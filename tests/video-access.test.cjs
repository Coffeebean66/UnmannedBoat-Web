'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {createMqttDeviceManager,validateVideoInput,validateInput,passwordMatches,videoBrokerConfiguration}=require('../maintenance/mqtt-device-worker.cjs');
const {parseArguments,readPrivateConfiguration,configureFromFile}=require('../maintenance/configure-video-access.cjs');
const output=path.resolve(__dirname,'../.test-output');
const plain='video-test-Secret!42',videoInput={deviceId:'boat-01',username:'camera-one',password:plain};
const acl='user boat-01\ntopic write boats/boat-01/telemetry\ntopic write boats/boat-01/status\ntopic read boats/boat-01/parameter-command\ntopic write boats/boat-01/parameter-response\ntopic write boats/boat-01/parameter-capability\n\nuser weather-reader\ntopic read weather/#\n\nuser boat-web-bridge\ntopic read boats/+/telemetry\ntopic read boats/+/status\ntopic write boats/+/parameter-command\ntopic read boats/+/parameter-response\ntopic read boats/+/parameter-capability\n';
async function fixture(t,{afterHash,service}={}){
  await fsp.mkdir(output,{recursive:true});const directory=await fsp.mkdtemp(path.join(output,'video-access-')),file=name=>path.join(directory,name),calls=[],restarts=[];
  const records={'.boat-cloud-deployment':'unmanned-boat-cloud-v1\n','broker.service':'# Owned by unmanned-boat-cloud-v1\n',
    'runtime.env':'BOAT_MQTT_USERNAME=boat-web-bridge\nBOAT_MQTT_PASSWORD=fixture-private-bridge\nBOAT_MQTT_TOPIC_PREFIX=boats\n',
    passwd:'boat-01:$7$101$oldSalt$oldHash\nweather-reader:$7$101$weather$hash\nboat-web-bridge:$7$101$bridge$hash\n',acl,
    'access.txt':'Device ID: boat-01\nDevice password: fixture-private-device\n',
    'mosquitto.conf':'allow_anonymous false\npassword_file '+file('passwd')+'\nacl_file '+file('acl')+'\nmax_packet_size 1024\nmessage_size_limit 512\n'};
  for(const [name,text]of Object.entries(records))await fsp.writeFile(file(name),text,{mode:name==='access.txt'||name==='runtime.env'?0o600:0o640});
  const execute=async(executable,args)=>{
    calls.push([executable,...args]);assert.deepEqual(args.slice(0,1),['-U']);assert.equal(args.length,2);
    const input=await fsp.readFile(args[1],'utf8'),split=input.indexOf(':'),username=input.slice(0,split),password=input.slice(split+1).trimEnd();
    const salt=crypto.randomBytes(12),hash=crypto.pbkdf2Sync(password,salt,101,64,'sha512');
    await fsp.writeFile(args[1],username+':$7$101$'+salt.toString('base64')+'$'+hash.toString('base64')+'\n');
    if(afterHash)await afterHash({file});
  };
  const options={configDir:directory,brokerUnit:file('broker.service'),checkOwnership:false,execute,service:service||(async()=>{restarts.push('restart');})};
  t.after(async()=>{if(path.dirname(directory)!==output||!path.basename(directory).startsWith('video-access-'))throw Error('Unexpected fixture cleanup path');await fsp.rm(directory,{recursive:true,force:true});});
  return {directory,file,records,calls,restarts,options,manager:createMqttDeviceManager(options)};
}
const read=async(f,name)=>fsp.readFile(f.file(name),'utf8');

test('视频账号只获得自身video发布权，桥接订阅及既有Broker大小限制一次升级',async t=>{
  const f=await fixture(t),result=await f.manager.configureVideo(videoInput);
  assert.equal(result.requiresReconnect,true);assert.deepEqual(result.video,{deviceId:'boat-01',username:'camera-one',topic:'boats/boat-01/video'});
  const nextAcl=await read(f,'acl'),nextPasswd=await read(f,'passwd'),nextBroker=await read(f,'mosquitto.conf');
  assert.equal(nextAcl.match(/user camera-one\n([\s\S]*)$/)[1].trim(),'topic write boats/boat-01/video');
  assert.match(nextAcl,/user boat-web-bridge[\s\S]*topic read boats\/\+\/video/);
  for(const line of f.records.passwd.trim().split('\n'))assert.ok(nextPasswd.includes(line));
  assert.match(nextBroker,/max_packet_size 8192/);assert.match(nextBroker,/message_size_limit 4096/);
  assert.doesNotMatch(JSON.stringify(result),/video-test|\$7\$|fixture-private/);assert.ok(!JSON.stringify(f.calls).includes(plain));assert.ok(!(await read(f,'access.txt')).includes(plain));
  assert.deepEqual((await f.manager.list()).devices,[{deviceId:'boat-01',username:'boat-01'}]);assert.equal(f.restarts.length,1);
});

test('相同视频账号配置重复执行不改文件、不再哈希或重启，改密码才更新',async t=>{
  const f=await fixture(t);await f.manager.configureVideo(videoInput);
  const first=Object.fromEntries(await Promise.all(['passwd','acl','access.txt','mosquitto.conf'].map(async name=>[name,await read(f,name)])));
  const unchanged=await f.manager.configureVideo(videoInput);assert.equal(unchanged.requiresReconnect,false);assert.equal(f.calls.length,1);assert.equal(f.restarts.length,1);
  for(const [name,text]of Object.entries(first))assert.equal(await read(f,name),text);
  await f.manager.configureVideo({...videoInput,password:'different-video-test-secret'});
  assert.notEqual(await read(f,'passwd'),first.passwd);assert.equal(await read(f,'acl'),first.acl);assert.equal(f.calls.length,2);assert.equal(f.restarts.length,2);
});

test('视频密码允许六位ASCII且普通设备仍至少八位；输入注入和未知字段拒绝',()=>{
  assert.doesNotThrow(()=>validateVideoInput({...videoInput,password:'abc789'}));
  assert.throws(()=>validateInput({username:'boat-01',revision:'a'.repeat(64),password:'abc789'}),{status:400});
  for(const change of [{deviceId:123},{username:123},{deviceId:'boat/01'},{username:'bad\nuser bridge'},{password:'short'},{password:'with space'},{password:'with:colon'},{password:'密码密码密码'},{password:'a'.repeat(65)},{extra:true}])assert.throws(()=>validateVideoInput({...videoInput,...change}),{status:400});
});

test('视频用户名不能覆盖遥测、桥接、无关账号或其他船的视频账号',async t=>{
  const f=await fixture(t);
  for(const username of ['boat-01','boat-web-bridge','weather-reader'])await assert.rejects(f.manager.configureVideo({...videoInput,username}),{status:409});
  await assert.rejects(f.manager.configureVideo({...videoInput,deviceId:'boat-missing'}),{status:404});
  assert.equal(await read(f,'passwd'),f.records.passwd);assert.equal(f.restarts.length,0);
  await f.manager.configureVideo(videoInput);
  await assert.rejects(f.manager.configureVideo({...videoInput,username:'other-camera'}),{status:409});
  await fsp.appendFile(f.file('acl'),'\nuser camera-other\ntopic write boats/boat-02/video\n');await fsp.appendFile(f.file('passwd'),'camera-other:$7$101$salt$hash\n');
  await assert.rejects(f.manager.configureVideo({...videoInput,username:'camera-other'}),{status:409});
});

test('既有视频账号出现额外权限时拒绝接管，普通账号修改和新建会保留视频配置',async t=>{
  const f=await fixture(t);await f.manager.configureVideo(videoInput);
  const videoHash=(await read(f,'passwd')).split('\n').find(line=>line.startsWith('camera-one:'));
  await f.manager.update('boat-01',{username:'boat-one-renamed',revision:(await f.manager.list()).revision});
  assert.ok((await read(f,'passwd')).includes(videoHash));assert.match(await read(f,'acl'),/user camera-one\ntopic write boats\/boat-01\/video/);
  await f.manager.create({deviceId:'boat-02',username:'boat-two',password:'fixture-device-secret',revision:(await f.manager.list()).revision});
  assert.ok((await read(f,'passwd')).includes(videoHash));assert.match(await read(f,'mosquitto.conf'),/max_packet_size 8192/);
  await fsp.writeFile(f.file('acl'),(await read(f,'acl')).replace('user camera-one\ntopic write boats/boat-01/video\n','user camera-one\ntopic write boats/boat-01/video\ntopic read boats/+/parameter-command\n'));
  await assert.rejects(f.manager.configureVideo(videoInput),{status:409});
});

test('Broker失败同时回滚密码、ACL、连接资料和报文上限，恢复旧三文件journal仍兼容',async t=>{
  let restarts=0;const f=await fixture(t,{service:async()=>{if(++restarts===1)throw Error('private service failure');}});
  await assert.rejects(f.manager.configureVideo(videoInput),error=>error.status===503&&/已恢复原账号/.test(error.message)&&!error.message.includes('private service'));
  for(const name of ['passwd','acl','access.txt','mosquitto.conf'])assert.equal(await read(f,name),f.records[name]);assert.equal(restarts,2);
  const legacy={version:1,files:{}};for(const name of ['passwd','acl','access.txt'])legacy.files[name]={text:f.records[name],mode:name==='access.txt'?0o600:0o640,gid:0};
  await fsp.writeFile(f.file('.mqtt-device-transaction.json'),JSON.stringify(legacy),{mode:0o600});
  assert.equal((await f.manager.list()).devices.length,1);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);
});

test('哈希期间外部配置变化在事务开始前拒绝，报文大小策略保留更大限制且拒绝重复指令',async t=>{
  const f=await fixture(t,{afterHash:async({file})=>fsp.appendFile(file('mosquitto.conf'),'# external change\n')});
  await assert.rejects(f.manager.configureVideo(videoInput),{status:409});assert.equal(await read(f,'passwd'),f.records.passwd);assert.equal(f.restarts.length,0);assert.equal(fs.existsSync(f.file('.mqtt-device-transaction.json')),false);
  const larger='max_packet_size 16384\nmessage_size_limit 8192\n';assert.equal(videoBrokerConfiguration(larger),larger);
  assert.throws(()=>videoBrokerConfiguration('max_packet_size 1024\nmax_packet_size 2048\n'),/不明确/);
});

test('Mosquitto新旧盐化密码校验不会把错误密码当作已配置',async()=>{
  const salt=crypto.randomBytes(12),password='fixture-hashed-password',hash=crypto.pbkdf2Sync(password,salt,101,64,'sha512');
  const encoded='$7$101$'+salt.toString('base64')+'$'+hash.toString('base64');assert.equal(await passwordMatches(password,encoded),true);assert.equal(await passwordMatches('wrong',encoded),false);
  const legacy='$6$'+salt.toString('base64')+'$'+crypto.createHash('sha512').update(password).update(salt).digest('base64');assert.equal(await passwordMatches(password,legacy),true);
  for(const bad of ['$7$0$salt$hash','$7$1000001$salt$hash','$7$101$bad$bad','$8$salt$hash'])assert.equal(await passwordMatches(password,bad),false);
});

test('CLI只接收配置文件参数，私密JSON经校验传给manager且错误不回显文件内容',async t=>{
  const f=await fixture(t),privateFile=f.file('video-private.json');await fsp.writeFile(privateFile,JSON.stringify(videoInput),{mode:0o600});
  const args=parseArguments(['--config',privateFile,'--config-dir',f.directory]);assert.equal(args.configFile,privateFile);assert.equal(args.configDir,f.directory);
  assert.deepEqual(await readPrivateConfiguration(privateFile,{ownership:false}),videoInput);
  const result=await configureFromFile(args,{ownership:false,createManager:()=>f.manager});assert.equal(result.video.username,'camera-one');
  for(const invalid of [[],['--password','never-accept-cli-password'],['--config',privateFile,'--config',privateFile],['--config']])assert.throws(()=>parseArguments(invalid),error=>!error.message.includes('never-accept-cli-password'));
  await fsp.writeFile(privateFile,'{"password":"fixture-private-secret",bad-json');await assert.rejects(readPrivateConfiguration(privateFile,{ownership:false}),error=>/JSON 格式无效/.test(error.message)&&!error.message.includes('fixture-private-secret'));
  const linked=f.file('linked-private.json');await fsp.link(privateFile,linked);await assert.rejects(readPrivateConfiguration(linked,{ownership:false}),/私密文件/);
});

test('新装部署允许视频描述报文并为桥接账号提供视频主题读取权',()=>{
  const script=fs.readFileSync(path.join(__dirname,'../deploy-cloud.sh'),'utf8');
  assert.match(script,/topic read boats\/\+\/video/);assert.match(script,/max_packet_size 8192/);assert.match(script,/message_size_limit 4096/);
});

test('视频管理接口首次设置仅返回元数据，改名保留旧哈希并支持同配置空操作和改密',async t=>{
  const f=await fixture(t),before=await f.manager.list();
  assert.equal(before.canManageVideo,true);assert.deepEqual(before.videos,[]);
  const first=await f.manager.updateVideo('boat-01',{username:'camera-one',password:plain,revision:before.revision});
  assert.equal(first.requiresReconnect,true);assert.deepEqual(first.videos,[{deviceId:'boat-01',username:'camera-one'}]);
  assert.doesNotMatch(JSON.stringify(first),/video-test|\$7\$|fixture-private/);
  const firstHash=(await read(f,'passwd')).split('\n').find(line=>line.startsWith('camera-one:'));
  const renamed=await f.manager.updateVideo('boat-01',{username:'camera-renamed',revision:first.revision});
  assert.equal(renamed.requiresReconnect,true);assert.deepEqual(renamed.videos,[{deviceId:'boat-01',username:'camera-renamed'}]);
  assert.ok((await read(f,'passwd')).includes(firstHash.slice(firstHash.indexOf(':'))));assert.doesNotMatch(await read(f,'acl'),/user camera-one\n/);assert.match(await read(f,'acl'),/user camera-renamed\ntopic write boats\/boat-01\/video/);
  const noop=await f.manager.updateVideo('boat-01',{username:'camera-renamed',revision:renamed.revision});assert.equal(noop.requiresReconnect,false);assert.equal(f.restarts.length,2);
  const rotated=await f.manager.updateVideo('boat-01',{username:'camera-renamed',password:'rotated-video-Secret!9',revision:renamed.revision});
  assert.equal(rotated.requiresReconnect,true);assert.notEqual((await read(f,'passwd')).split('\n').find(line=>line.startsWith('camera-renamed:')),firstHash.replace('camera-one:','camera-renamed:'));assert.doesNotMatch(JSON.stringify(rotated),/rotated-video|\$7\$/);
});

test('视频管理拒绝过时版本、普通账号和其他视频账号冲突，失败不改文件',async t=>{
  const f=await fixture(t),first=await f.manager.updateVideo('boat-01',{username:'camera-one',password:plain,revision:(await f.manager.list()).revision});
  const beforePasswd=await read(f,'passwd'),beforeAcl=await read(f,'acl');
  await assert.rejects(f.manager.updateVideo('boat-01',{username:'boat-web-bridge',revision:first.revision}),{status:409});
  await assert.rejects(f.manager.updateVideo('boat-01',{username:'camera-renamed',revision:'a'.repeat(64)}),{status:409});
  await f.manager.create({deviceId:'boat-02',username:'boat-two',password:'boat-two-Secret!2',revision:(await f.manager.list()).revision});
  const second=await f.manager.configureVideo({deviceId:'boat-02',username:'camera-two',password:'second-video-Secret!2'});
  const stablePasswd=await read(f,'passwd'),stableAcl=await read(f,'acl');
  await assert.rejects(f.manager.updateVideo('boat-01',{username:'camera-two',revision:second.revision}),{status:409});
  assert.equal(await read(f,'passwd'),stablePasswd);assert.equal(await read(f,'acl'),stableAcl);
  assert.match(beforePasswd,/boat-01:/);assert.match(beforeAcl,/user boat-web-bridge/);
});

test('视频管理事务失败回滚全部四个文件且固定 PUT 路由不回显密码',async t=>{
  let restarts=0;const f=await fixture(t,{service:async()=>{if(++restarts===1)throw Error('video broker restart failed');}});
  const before=Object.fromEntries(await Promise.all(['passwd','acl','access.txt','mosquitto.conf'].map(async name=>[name,await read(f,name)])));
  await assert.rejects(f.manager.updateVideo('boat-01',{username:'camera-one',password:plain,revision:(await f.manager.list()).revision}),{status:503});
  for(const [name,text]of Object.entries(before))assert.equal(await read(f,name),text);assert.equal(restarts,2);
  const g=await fixture(t),worker=require('../maintenance/mqtt-device-worker.cjs').createMqttDeviceWorker({manager:g.manager});await new Promise(resolve=>worker.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>worker.close(resolve)));
  const base='http://127.0.0.1:'+worker.address().port,revision=(await g.manager.list()).revision;
  const response=await fetch(base+'/devices/boat-01/video',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'camera-route',password:'route-video-Secret!2',revision})});
  assert.equal(response.status,200);const body=await response.text();assert.doesNotMatch(body,/route-video|\$7\$/);const json=JSON.parse(body);assert.deepEqual(json.videos,[{deviceId:'boat-01',username:'camera-route'}]);
  assert.equal((await fetch(base+'/devices/boat-01/video',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,405);
});
