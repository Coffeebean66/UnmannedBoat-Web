'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {TelemetryHistory,historyOptions}=require('../server/telemetry-history'),{CloudBridge}=require('../server/cloud'),{createServer}=require('../server'),P=require('../public/utils/uart4Protocol');
function telemetry(sequence=1){
  const payload=Buffer.alloc(176);
  for(const[offset,size,version,type,flags]of[[0,64,1,1,0xf3],[64,40,2,2,3],[104,36,2,3,47],[140,36,1,4,3]]){
    const b=payload.subarray(offset,offset+size);b.set([0xa5,0x5a,version,type,size,flags]);b.writeUInt32LE(sequence,6);b.writeUInt32LE(sequence*100,10);
    if(type===1)for(const base of[14,38]){b[base]=7;b.writeUInt16LE(2450,base+2);b.writeUInt16LE(120,base+4);b.writeUInt32LE(1500,base+12);}
    if(type===2){b.writeInt16LE(1500,14);b.writeInt32LE(311234567,26);b.writeInt32LE(1217654321,30);b.writeUInt16LE(1000,34);b[36]=15;}
    if(type===3){b.writeInt16LE(2000,14);b.writeUInt16LE(1500,16);b[32]=2;b[33]=3;}
    if(type===4)b[32]=127;
    b.writeUInt16LE(P.crc16CcittFalse(b,2,size-4),size-2);
  }
  return payload;
}
function sample(id='boat-01',at=1000,sequence=1){const b=telemetry(sequence);return{deviceId:id,receivedAt:at,ageMs:0,payload:'must-not-store',summary:{status:P.decodeFrame(b.subarray(0,64)),velocity:P.decodeVelocityFrame(b.subarray(64,104)).velocity,boat:P.decodeBoatFrame(b.subarray(104,140)).boat,imu:P.decodeImuFrame(b.subarray(140)).imu}};}
function temporary(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boat-telemetry-history-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
class MQTT extends EventEmitter{subscribe(topics,options,callback){callback(null);}end(){}publish(){throw Error('History must never publish control');}}
const baseEnv={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://history-fixture.invalid:1883',BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'history-admin',BOAT_ADMIN_PASSWORD:'history-admin-fixture',BOAT_GUEST_USERNAME:'history-guest',BOAT_GUEST_PASSWORD:'history-guest-fixture'};
function bridge(options={}){const client=new MQTT(),env={...baseEnv},value=new CloudBridge({env,connect:()=>client,tickMs:60000,...options});value.start();client.emit('connect');return{bridge:value,client};}

test('按船采样保留最新完整状态和精简历史，原子保存及重启恢复不存原始帧',async t=>{
  const file=path.join(temporary(t),'state','telemetry-history.json');let now=12000;
  const history=new TelemetryHistory({file,maxPoints:10,sampleMs:1000,now:()=>now});
  assert.equal(history.record(sample('boat-01',1000)),true);assert.equal(history.record(sample('boat-01',1500,2)),false);
  for(let at=2000;at<=11000;at+=1000)history.record(sample('boat-01',at,at));
  history.record(sample('boat-02',11000));
  const result=history.snapshot('boat-01');assert.equal(result.latest.summary.status.motors[0].voltageV,24.5);assert.equal(result.samples.length,10);assert.equal(result.samples[0].receivedAt,2000);
  assert.deepEqual(Object.keys(result.samples[0].summary).sort(),['boat','velocity']);
  result.latest.summary.boat.actualMps=999;result.samples[0].summary.velocity.latitude=0;assert.equal(history.latest('boat-01').summary.boat.actualMps,1.5);assert.notEqual(history.list('boat-01')[0].summary.velocity.latitude,0);
  await history.close();const disk=fs.readFileSync(file,'utf8');assert.equal(disk.includes('must-not-store'),false);assert.equal(disk.includes('payload'),false);assert.equal(fs.readdirSync(path.dirname(file)).length,1);
  const restored=new TelemetryHistory({file,maxPoints:10,now:()=>now});assert.equal(restored.list('boat-01').length,10);assert.equal(restored.latest('boat-01').summary.status.sequence,11000);assert.equal(restored.deviceIds().length,2);await restored.close();
});
test('过期数据在查询和恢复时裁剪，设备数与每船点数均有上限',async t=>{
  const file=path.join(temporary(t),'history.json');let now=10000;const history=new TelemetryHistory({file,maxDevices:2,maxAgeMs:60000,now:()=>now});
  history.record(sample('old',1000));history.record(sample('second',2000));history.record(sample('third',3000));assert.deepEqual(history.deviceIds(),['second','third']);
  await history.flush();now=100000;assert.deepEqual(history.deviceIds(),[]);await history.close();
  const restored=new TelemetryHistory({file,maxDevices:2,maxAgeMs:60000,now:()=>now});assert.deepEqual(restored.deviceIds(),[]);await restored.close();
});
test('全局点数上限防止64船并行放大内存，同时各船最新快照保持可用',async t=>{
  const history=new TelemetryHistory({maxDevices:64,maxPoints:3600,now:()=>400000});
  for(let sequence=1;sequence<=320;sequence++)for(let id=0;id<64;id++)history.record(sample('boat-'+id,sequence*1000,sequence));
  assert.equal(history.totalPoints,20000);assert.equal(history.devices.size,64);assert.equal(history.latest('boat-0').summary.status.sequence,320);await history.close();
});
test('降低保留配置后重启裁剪旧记录而不是判损坏，请求较大limit仍按当前上限返回',async t=>{
  const file=path.join(temporary(t),'history.json');const original=new TelemetryHistory({file,maxPoints:30,maxDevices:3,now:()=>40000});
  for(let n=1;n<=20;n++)original.record(sample('boat-01',n*1000,n));
  original.record(sample('boat-02',25000));original.record(sample('boat-03',30000));await original.close();
  const restored=new TelemetryHistory({file,maxPoints:10,maxDevices:2,now:()=>40000});assert.equal(restored.status().storageError,null);assert.deepEqual(restored.deviceIds(),['boat-02','boat-03']);await restored.close();
  const limited=new TelemetryHistory({maxPoints:1000,now:()=>1100000});for(let n=1;n<=1000;n++)limited.record(sample('boat-01',n*1000,n));assert.equal(limited.list('boat-01',{limit:3600}).length,1000);await limited.close();
});
test('损坏/过大文件和无效摘要报告存储故障，持续采集仍可用且不覆盖损坏文件',async t=>{
  const file=path.join(temporary(t),'history.json'),broken='{bad-json';fs.writeFileSync(file,broken);
  const history=new TelemetryHistory({file,now:()=>2000});assert.ok(history.status().storageError);assert.equal(history.record(sample()),true);assert.equal(history.record({...sample(),summary:{boat:{}}}),false);await history.close();assert.equal(fs.readFileSync(file,'utf8'),broken);
  const large=path.join(path.dirname(file),'oversize.json'),handle=fs.openSync(large,'w');fs.ftruncateSync(handle,33*1024*1024);fs.closeSync(handle);const oversized=new TelemetryHistory({file:large});assert.ok(oversized.status().storageError);await oversized.close();
});
test('异步写盘失败不抛出或终止实时采集，修复路径后可重新保存',async t=>{
  const directory=temporary(t),blocker=path.join(directory,'blocked');fs.writeFileSync(blocker,'file');const file=path.join(blocker,'history.json');
  const history=new TelemetryHistory({file,now:()=>3000});
  // 加载时 ENOTDIR属于历史存储错误；使用新实例模拟启动后路径变得不可写。
  history.blockedFile=false;history.storageError=null;history.record(sample());await history.flush();assert.ok(history.status().storageError);
  fs.unlinkSync(blocker);fs.mkdirSync(blocker);history.record(sample('boat-01',2000));await history.flush();assert.equal(history.status().storageError,null);assert.equal(fs.existsSync(file),true);await history.close();
});
test('并发flush共享单个写入，close等待在途保存及期间新收到的最新数据',async t=>{
  const directory=temporary(t),file=path.join(directory,'history.json'),history=new TelemetryHistory({file,now:()=>4000});history.record(sample());
  const original=fsp.writeFile;let release,entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let writes=0;
  fsp.writeFile=async(...args)=>{writes++;if(writes===1){entered();await gate;}return original(...args);};t.after(()=>{fsp.writeFile=original;});
  const first=history.flush();await started;assert.equal(history.flush(),first);history.record(sample('boat-01',2000,2));const closing=history.close();release();await closing;assert.equal(writes,2);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).devices[0].latest.summary.status.sequence,2);
});
test('STATE_DIRECTORY默认持久化，环境变量空值不覆盖默认，隔离测试可显式只用内存',()=>{
  const directory=path.resolve(os.tmpdir(),'history-state-option');assert.equal(historyOptions({STATE_DIRECTORY:directory,BOAT_TELEMETRY_HISTORY_FILE:''}).file,path.join(directory,'telemetry-history.json'));
  assert.equal(historyOptions({STATE_DIRECTORY:directory},{file:''}).file,'');assert.equal(historyOptions({}).file,'');
});
test('旧更新部署回退可写requests目录，显式路径、StateDirectory和纯内存选项优先',()=>{
  const directory=path.resolve(os.tmpdir(),'history-update-option'),state=path.resolve(os.tmpdir(),'history-primary-option'),explicit=path.resolve(os.tmpdir(),'history-explicit.json');
  const update={BOAT_UPDATE_ENABLED:'1',BOAT_UPDATE_STATE_DIR:directory};
  assert.equal(historyOptions(update).file,path.join(directory,'requests','telemetry-history.json'));
  assert.equal(historyOptions({BOAT_UPDATE_ENABLED:'1'}).file,path.join('/var/lib/unmanned-boat-web-update','requests','telemetry-history.json'));
  assert.equal(historyOptions({...update,STATE_DIRECTORY:state}).file,path.join(state,'telemetry-history.json'));
  assert.equal(historyOptions({...update,STATE_DIRECTORY:state,BOAT_TELEMETRY_HISTORY_FILE:'  '+explicit+'  '}).file,explicit);
  assert.equal(historyOptions({...update,BOAT_TELEMETRY_HISTORY_FILE:''}).file,path.join(directory,'requests','telemetry-history.json'));
  assert.equal(historyOptions({...update,STATE_DIRECTORY:state,BOAT_TELEMETRY_HISTORY_FILE:explicit},{file:''}).file,'');
  assert.equal(historyOptions({...update,BOAT_UPDATE_ENABLED:'0'}).file,'');
});
test('无人浏览器和SSE时后台照常记录，正常关闭后重启恢复离线船，不恢复控制权限',async t=>{
  const file=path.join(temporary(t),'history.json');let now=10000;const first=bridge({now:()=>now,historyOptions:{file}});const current=first.bridge;
  for(let n=1;n<=3;n++){now+=1000;assert.equal(current.acceptMessage('boats/boat-01/telemetry',telemetry(n)),true);}
  assert.equal(current.listenerCount('telemetry'),0);assert.equal(current.historyFor('boat-01').samples.length,3);await current.stop();
  now+=20000;const second=bridge({now:()=>now,historyOptions:{file}});assert.equal(second.bridge.list().devices.length,1);assert.equal(second.bridge.get('boat-01').online,false);assert.equal(second.bridge.get('boat-01').parametersReady,false);assert.equal(second.bridge.get('boat-01').lastReceivedAt,13000);assert.equal(second.bridge.historyFor('boat-01').latest.summary.status.sequence,3);await second.bridge.stop();
});
test('已登录HTTP历史API默认范围非空、按船隔离，匿名和错误范围拒绝',async t=>{
  const directory=temporary(t);let now=10000;const f=bridge({now:()=>now,historyOptions:{file:path.join(directory,'history.json')}});
  const server=createServer({env:baseEnv,cloud:f.bridge,accountOptions:{storeFile:path.join(directory,'accounts.json')},mapOptions:{file:path.join(directory,'map.json')}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  f.bridge.acceptMessage('boats/boat-01/telemetry',telemetry(1));f.bridge.acceptMessage('boats/boat-02/telemetry',telemetry(2));
  const origin='http://127.0.0.1:'+server.address().port,request=(route,options={})=>fetch(origin+route,{...options,headers:{Origin:origin,...options.headers}});
  assert.equal((await request('/api/cloud/history?device=boat-01')).status,401);
  const login=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:baseEnv.BOAT_GUEST_USERNAME,password:baseEnv.BOAT_GUEST_PASSWORD})});assert.equal(login.status,200);const Cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await request('/api/cloud/history?device=boat-01',{headers:{Cookie}});assert.equal(response.status,200);const data=await response.json();assert.equal(data.samples.length,1);assert.equal(data.latest.summary.status.sequence,1);assert.equal(data.recording.sampleMs,1000);assert.equal(JSON.stringify(data).includes('payload'),false);assert.ok(data.samples.every(sample=>sample.deviceId==='boat-01'));
  for(const suffix of['device=bad.id','device=boat-01&until=abc','device=boat-01&since=200&until=100','device=boat-01&limit=99999'])assert.equal((await request('/api/cloud/history?'+suffix,{headers:{Cookie}})).status,400);
  const health=await(await request('/healthz')).json();assert.equal(health.ok,true);assert.equal(health.readiness.telemetryRecording.persistent,true);
});
