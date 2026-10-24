/* 本机真实 Chrome + HTTP 登录/SSE；仅使用内存遥测，不访问生产 MQTT 或账户。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),P=require('../public/utils/uart4Protocol');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ids=['boat-cloud-test','boat-second','boat-long-mqtt-device-id'+('0123456789'.repeat(4))];
function telemetry(sequence){
  return Buffer.concat([[1,64,1],[2,40,2],[3,36,2],[4,36,1]].map(([type,size,version])=>{
    const bytes=Buffer.alloc(size);bytes.set([0xa5,0x5a,version,type,size,3]);bytes.writeUInt32LE(sequence,6);
    bytes.writeUInt16LE(P.crc16CcittFalse(bytes,2,size-4),size-2);return bytes;
  })).toString('base64');
}
async function main(){
  fs.mkdirSync(output,{recursive:true});const fixture={feed:false,deviceId:ids[0],sequence:0};
  const devices=ids.map(id=>({id,online:true,parametersReady:false}));
  const bridge=new EventEmitter();Object.assign(bridge,{enabled:true,start(){},stop(){},
    list:()=>({brokerConnected:true,devices}),state:id=>({brokerConnected:true,device:devices.find(device=>device.id===id)})});
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'device-card-admin-test-only',
    BOAT_GUEST_USERNAME:'observer',BOAT_GUEST_PASSWORD:'device-card-guest-test-only',BOAT_AMAP_KEY:'',BOAT_AMAP_SECURITY_CODE:''};
  const server=createServer({env,cloud:bridge});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const emit=(deviceId=fixture.deviceId)=>bridge.emit('telemetry',{deviceId,receivedAt:Date.now()-80,ageMs:0,payload:telemetry(++fixture.sequence)});
  const feed=setInterval(()=>{if(fixture.feed)emit();},100);
  const profile=fs.mkdtempSync(path.join(output,'chrome-device-card-')),errors=[];
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
    '--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();socket.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;
    };
    const card=()=>evaluate("(()=>{const get=id=>document.getElementById(id),text=id=>get(id).textContent;return {name:text('deviceName'),title:get('deviceName').title,chip:text('sourceChip'),status:text('deviceConnectionState'),state:get('deviceSummary').dataset.state,count:text('frameCount'),updated:text('deviceLastUpdate'),datetime:get('deviceLastUpdate').dateTime,latency:text('deviceLatency')};})()");
    const until=async expression=>{
      for(let i=0;i<180;i++){if(await evaluate(expression))return;await wait(60);}
      throw Error('Condition timed out: '+expression+'\n'+JSON.stringify(await card())+'\n'+errors.join('\n'));
    };
    const shot=async name=>{
      const clip=await evaluate("(()=>{const r=document.getElementById('deviceSummary').getBoundingClientRect();return {x:scrollX+r.left,y:scrollY+r.top,width:r.width,height:r.height,scale:2};})()");
      const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
      fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));
    };
    const choose=async id=>evaluate('document.getElementById("cloudDevice").value='+JSON.stringify(id)+';document.getElementById("cloudDevice").dispatchEvent(new Event("change"))');
    const connect=async()=>{
      await evaluate('document.getElementById("connectButton").click()');
      await until('boatMonitor.link.wanted&&!!boatMonitor.link.stream');
    };
    const disconnect=async()=>{
      fixture.feed=false;await wait(150);
      // frame 回调与 200 ms 周期渲染分离；先刷新再取快照，避免比较到旧的时间文本。
      await evaluate('window.dispatchEvent(new Event("resize"))');const before=await card();
      await evaluate('document.getElementById("disconnectButton").click()');
      await until('!boatMonitor.link.wanted&&!boatMonitor.link.connected');
      const after=await card();assert.equal(after.updated,before.updated,'A normal disconnect keeps the last valid update');
      assert.equal(after.datetime,before.datetime);assert.equal(after.latency,'--');assert.equal(after.status,'未连接');
      return after;
    };
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
    // 遥测与设备卡片验证不依赖外网瓦片、真实高德 SDK 或任何生产连接。
    await send('Network.setBlockedURLs',{urls:['https://*','http://tile.openstreetmap.org/*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await until('!!window.boatMonitor&&window.BoatAuth.ready&&document.getElementById("accountLoginDialog").open');
    await evaluate('document.getElementById("accountUsername").value="operator";document.getElementById("accountPassword").value="device-card-admin-test-only";document.getElementById("accountLoginForm").requestSubmit()');
    await until('!!BoatAuth.user&&!BoatAuth.busy');
    await until('document.getElementById("cloudDevice").value==="boat-cloud-test"&&!document.getElementById("connectButton").disabled');
    let current=await card();assert.equal(current.name,ids[0]);assert.equal(current.chip,'MQTT');assert.equal(current.count,'0');assert.equal(current.updated,'--');assert.equal(current.latency,'--');
    await connect();assert.equal((await card()).status,'等待遥测');
    fixture.feed=true;await until('boatMonitor.link.connected&&document.getElementById("deviceLastUpdate").textContent!=="--"');
    current=await card();assert.equal(current.name,ids[0]);assert.equal(current.title,'MQTT 设备 ID：'+ids[0]);assert.equal(current.state,'online');assert.equal(current.status,'已连接');
    assert.ok(Number(current.count.replaceAll(',',''))>=4);assert.match(current.updated,/\d{4}\/\d{2}\/\d{2}.*\d{2}:\d{2}:\d{2}/);
    assert.ok(Math.abs(Date.now()-Date.parse(current.datetime))<3000);assert.match(current.latency,/^\d+ ms$/);
    assert.ok(parseInt(current.latency)>=50&&parseInt(current.latency)<1000,'Local 80 ms forwarding fixture is estimated within freshness limit');
    assert.equal(await evaluate('document.querySelector(".vessel-emblem img").complete&&document.querySelector(".vessel-emblem img").naturalWidth>0'),true);
    await shot('device-card-cloud-connected');await disconnect();await shot('device-card-cloud-disconnected');
    await choose(ids[1]);current=await card();assert.equal(current.name,ids[1]);assert.equal(current.count,'0');assert.equal(current.updated,'--');assert.equal(current.datetime,'');assert.equal(current.latency,'--');
    emit(ids[0]);await wait(150);assert.deepEqual(await card(),current,'Old boat telemetry cannot change the selected second boat');
    fixture.deviceId=ids[1];await connect();current=await card();assert.equal(current.name,ids[1]);assert.equal(current.count,'0');assert.equal(current.updated,'--');
    fixture.feed=true;await until('boatMonitor.link.connected&&document.getElementById("deviceLastUpdate").textContent!=="--"');
    assert.equal((await card()).name,ids[1]);await shot('device-card-cloud-second');await disconnect();
    await choose(ids[2]);current=await card();assert.equal(current.name,ids[2]);assert.equal(current.count,'0');assert.equal(current.updated,'--');
    fixture.deviceId=ids[2];await connect();fixture.feed=true;await until('boatMonitor.link.connected&&document.getElementById("deviceLastUpdate").textContent!=="--"');
    assert.equal((await card()).title,'MQTT 设备 ID：'+ids[2]);
    assert.equal(await evaluate('document.getElementById("deviceSummary").scrollWidth<=document.getElementById("deviceSummary").clientWidth'),true,'A 64-character MQTT ID stays within the card');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await shot('device-card-cloud-long-id');
    await evaluate('document.getElementById("themeToggle").click()');await until('document.documentElement.dataset.theme==="light"');await shot('device-card-cloud-light');
    current=await disconnect();assert.equal(current.chip,'MQTT');assert.equal(current.name,ids[2]);assert.notEqual(current.count,'0');assert.notEqual(current.updated,'--');assert.equal(current.latency,'--');
    await connect();fixture.feed=true;await until('boatMonitor.link.connected');current=await card();assert.equal(current.chip,'MQTT');assert.equal(current.name,ids[2]);
    assert.deepEqual(errors,[]);
    console.log('Chrome device card passed: local login/API/SSE; MQTT IDs including 64 characters; count, recent update, forwarding estimate; disconnect retains last update; switch clears old vessel data; MQTT reconnect; dark/light screenshots; no production requests.');
  }finally{
    clearInterval(feed);socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
