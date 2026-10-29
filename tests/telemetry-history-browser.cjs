/* 无浏览器采集 → 正常关服落盘 → 重启恢复 → Chrome 登录回看；全程只用本机模拟 MQTT。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),{CloudBridge}=require('../server/cloud');
const P=require('../public/utils/uart4Protocol');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=path.resolve(__dirname,'../.test-output');

function telemetry(id,index,sequence,speed){
  const result=Buffer.alloc(176);
  for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){
    const frame=result.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length,3]);
    frame.writeUInt32LE(sequence,6);frame.writeUInt32LE(sequence*1000,10);
    if(type===1)for(const base of [14,38]){frame[base]=7;frame[base+1]=32;frame.writeUInt16LE(2450+index,base+2);frame.writeUInt16LE(1250,base+4);frame.writeUInt32LE(index*1100,base+12);frame.writeUInt16LE(20,base+20);}
    if(type===2){frame.writeInt16LE(Math.round(speed*1000),14);frame.writeUInt16LE(20,20);frame.writeInt32LE(Math.round((31+index/100+sequence*.000025)*1e7),26);frame.writeInt32LE(Math.round((121+index/100)*1e7),30);frame.writeUInt16LE(index*4500,34);frame[36]=15;}
    if(type===3){frame[5]=47;frame.writeInt16LE(2500,14);frame.writeUInt16LE(Math.round(speed*1000),16);frame.writeInt16LE(100,18);frame.writeUInt16LE(20,20);frame.writeInt16LE(2500,22);frame.writeUInt16LE(index*4500,26);frame.writeUInt16LE(index*4500,28);frame[32]=2;frame[33]=3;}
    if(type===4){frame.writeInt16LE(500,20);frame.writeInt16LE(-300,22);frame.writeInt16LE(2300,24);frame.writeUInt16LE(20,26);frame[32]=127;}
    frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);
  }
  return result;
}

async function main(){
  fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'history-browser-state-')),profile=path.join(run,'chrome');
  const file=path.join(run,'telemetry-history.json'),env={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://fixture.invalid:1883',
    BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'history-admin',BOAT_ADMIN_PASSWORD:'history-browser-administrator',
    BOAT_GUEST_USERNAME:'history-guest',BOAT_GUEST_PASSWORD:'history-browser-observer',BOAT_AMAP_KEY:'',BOAT_AMAP_SECURITY_CODE:''};
  let now=Date.now()-45000,server,bridge,mqtt,browser,socket,feed,delayHistory=0;
  const errors=[],requests=[],calls=[];
  class SimulatedMQTT extends EventEmitter{
    constructor(){super();this.connected=true;}
    subscribe(topics,options,callback){queueMicrotask(()=>callback(null));}
    publish(topic,payload,options,callback){calls.push(topic);callback?.();}
    end(){}
  }
  const start=async()=>{
    mqtt=new SimulatedMQTT();bridge=new CloudBridge({env,connect:()=>mqtt,now:()=>now,tickMs:100,historyOptions:{file}});
    server=createServer({env,cloud:bridge,accountOptions:{storeFile:path.join(run,'accounts.json')},mapOptions:{file:path.join(run,'map-settings.json')},
      mqttAdminOptions:{client:async()=>({devices:[],revision:'a'.repeat(64),canCreate:true})}});
    const handler=server.listeners('request')[0];server.removeListener('request',handler);
    server.on('request',(req,res)=>{
      if(req.url.startsWith('/api/cloud/history')){requests.push(req.url);if(delayHistory){setTimeout(()=>{if(!res.destroyed)handler(req,res);},delayHistory);return;}}
      handler(req,res);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));mqtt.emit('connect');await wait(0);
  };
  const close=async()=>{if(server){const current=server;server=null;await new Promise(resolve=>current.close(resolve));}};
  const emit=(id,index,seq,speed)=>mqtt.emit('message','boats/'+id+'/telemetry',telemetry(id,index,seq,speed),{});
  const alpha='boat-history-alpha',beta='boat-history-beta';
  try{
    await start();
    for(let n=1;n<=12;n++){emit(alpha,1,n,.3+(n%6)*.5);emit(beta,2,n,2.2);now+=1000;}
    assert.equal(server.boatCloudApi.getClientCount(),0,'No page or SSE is needed for collection');
    assert.equal(bridge.historyFor(alpha,{limit:100}).samples.length,12);
    assert.equal(bridge.historyFor(beta,{limit:100}).samples.length,12);
    await close();
    assert.equal(fs.existsSync(file),true,'Graceful shutdown waits for final durable history');
    const disk=fs.readFileSync(file,'utf8');assert.ok(disk.includes(alpha)&&disk.includes(beta));
    assert.equal(disk.includes('base64'),false,'History contains decoded measurements only');
    now=Date.now();await start();
    assert.equal(bridge.list().devices.length,2,'Historical boats survive a restart');
    assert.ok(bridge.list().devices.every(item=>!item.online&&!item.parametersReady));
    const unauth=await fetch('http://127.0.0.1:'+server.address().port+'/api/cloud/history?device='+alpha);
    assert.equal(unauth.status,401,'Historical data requires monitoring login');
    browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
      '--headless','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader',
      '--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:'ignore'});
    browser.on('error',error=>errors.push(error.message));
    const portFile=path.join(profile,'DevToolsActivePort');for(let n=0;n<100&&!fs.existsSync(portFile)&&!errors.length;n++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}
    };
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const until=async(expression,label=expression)=>{for(let n=0;n<200;n++){if(await evaluate(expression))return;await wait(50);}throw Error('Condition timed out: '+label+'\n'+await evaluate('JSON.stringify({link:boatMonitor.link.state(),history:document.getElementById("historyStatus")?.textContent,fleet:boatMonitor.fleet.state()})')+'\n'+errors.join('\n'));};
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
    await send('Network.setBlockedURLs',{urls:['*://tile.openstreetmap.org/*','*://*.tile.openstreetmap.org/*','*://webapi.amap.com/*']});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.historyChartLines=0;const originalLineTo=CanvasRenderingContext2D.prototype.lineTo;CanvasRenderingContext2D.prototype.lineTo=function(...args){if(this.canvas.id==="chart"&&this.lineWidth===2)window.historyChartLines++;return originalLineTo.apply(this,args);};'});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await until('!!window.boatMonitor&&BoatAuth.ready');
    await evaluate('document.getElementById("accountUsername").value="history-admin";document.getElementById("accountPassword").value="history-browser-administrator";document.getElementById("accountLoginForm").requestSubmit()');
    await until('BoatAuth.canManage&&!BoatAuth.busy');
    await until('boatMonitor.link.selectedId&&document.getElementById("historyStatus").textContent.includes("12")','automatic history load');
    assert.equal(await evaluate('location.hash'),'#fleet','Auto-selection preserves the fleet workspace');
    assert.equal(await evaluate('boatMonitor.link.connected'),false,'Restored data is historical, never live');
    assert.equal(await evaluate('boatMonitor.link.readOnly'),true,'History cannot enable parameter writes');
    assert.equal(await evaluate('document.getElementById("fleetOnline").textContent'),'0');
    assert.ok(await evaluate('boatMonitor.track.pointCount')>=10,'Track restores without pressing Start tracking');
    assert.ok(await evaluate('boatMonitor.track.polylines().length')>0,'One-second samples form visible line segments');
    assert.notEqual(await evaluate('document.getElementById("historyLastTime").textContent'),'尚无记录');
    await evaluate('boatMonitor.selectBoat('+JSON.stringify(beta)+',false)');
    await until('document.getElementById("historyLastSpeed").textContent==="2.200 m/s"');
    assert.equal(await evaluate('document.getElementById("cloudDevice").value'),beta,'Device picker follows the displayed history');
    assert.equal(await evaluate('boatMonitor.track.segments.flat().every(point=>point.latitude>31.02)'),true,'Boat tracks remain isolated');
    // 延迟旧船响应，马上切换；旧请求不得污染当前船。
    delayHistory=450;await evaluate('boatMonitor.selectBoat('+JSON.stringify(alpha)+',false)');
    await evaluate('boatMonitor.selectBoat('+JSON.stringify(beta)+',false)');await wait(650);delayHistory=0;
    assert.equal(await evaluate('boatMonitor.link.selectedId'),beta);
    assert.equal(await evaluate('document.getElementById("historyLastSpeed").textContent'),'2.200 m/s');
    await evaluate('BoatWorkspace.navigate("analysis")');
    assert.match(await evaluate('document.getElementById("chartHistoryState").textContent'),/最后记录/);
    await until('window.historyChartLines>10','One-second history samples produce actual Canvas curve segments');
    for(const width of [1440,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});await wait(150);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,width+'px history fits');
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,'telemetry-history-'+width+'.png'),Buffer.from(shot.data,'base64'));
    }
    assert.equal(calls.length,0,'Automatic history loading never sends device commands');
    // 新鲜遥测到达后自动恢复实时状态，旧历史响应不能回滚实际速度。
    let seq=100;feed=setInterval(()=>{now=Date.now();emit(beta,2,++seq,2.8);},100);
    await until('boatMonitor.link.connected&&document.getElementById("boatActual").textContent==="2.800"');
    assert.ok(await evaluate('boatMonitor.track.pointCount')>=12,'Same-boat live recovery preserves the imported route');
    await evaluate('document.getElementById("disconnectButton").click()');
    await until('!boatMonitor.link.wanted&&!boatMonitor.link.connected');await wait(600);
    assert.equal(await evaluate('boatMonitor.link.wanted'),false,'Manual disconnect suppresses automatic reconnection');
    await evaluate('boatMonitor.selectBoat('+JSON.stringify(alpha)+',false)');
    await until('document.getElementById("historyStatus").textContent.includes("12")');
    await evaluate('BoatAuth.logout()');await until('!BoatAuth.user&&!boatMonitor.link.authenticated');
    assert.equal(await evaluate('boatMonitor.track.pointCount'),0,'Logout clears previously visible records');
    await until('document.getElementById("historyLastTime").textContent==="尚无记录"');
    const historyRequestsBeforeLogin=requests.length;
    await evaluate('document.getElementById("accountUsername").value="history-admin";document.getElementById("accountPassword").value="history-browser-administrator";document.getElementById("accountLoginForm").requestSubmit()');
    await until('BoatAuth.canManage&&boatMonitor.link.selectedId==='+JSON.stringify(beta)+'&&boatMonitor.link.connected','Same-page login automatically selects the currently online boat');
    await until('boatMonitor.historyState().recordedAt>0');
    assert.ok(requests.length>historyRequestsBeforeLogin,'Logging in again reloads history without a manual connection');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS: zero-viewer collection, graceful persistence/restart, authenticated automatic history, isolated tracks, stale-response guards, live resume, manual disconnect, logout/relogin and responsive layouts.');
  }finally{
    clearInterval(feed);if(socket?.readyState===1)socket.close();if(browser){browser.kill();await wait(400);}await close();
    fs.rmSync(run,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
