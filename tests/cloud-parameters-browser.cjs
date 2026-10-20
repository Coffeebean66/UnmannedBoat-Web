/* 真 Chrome + 真实账户/云端参数 HTTP API；设备由内存替身模拟，不连接生产船。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events'),vm=require('node:vm');
const {createServer}=require('../server'),P=require('../public/utils/uart4Protocol');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const configContext={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/parameter-data.js'),'utf8'),configContext);
const values=Object.fromEntries(Object.entries(configContext.window.BoatParameters.ranges).map(([key,range])=>[key,range[0]]));values.kpX2PerMps=42;
function parameterFrame(parameters,status=0){const bytes=P.encodeParameterWriteRequest(321,parameters);bytes[3]=0x90;bytes[5]=status;new DataView(bytes.buffer).setUint16(54,P.crc16CcittFalse(bytes,2,52),true);return Buffer.from(bytes);}
function telemetry(){return Buffer.concat([[1,64,1],[2,40,2],[3,36,2],[4,36,1]].map(([type,size,version])=>{const bytes=Buffer.alloc(size);bytes.set([0xa5,0x5a,version,type,size,3]);bytes.writeUInt16LE(P.crc16CcittFalse(bytes,2,size-4),size-2);return bytes;})).toString('base64');}
async function main(){
  fs.mkdirSync(output,{recursive:true});const fixture={ready:true,values:{...values},calls:[],rejectFlash:true,loseResponse:false};
  const bridge=new EventEmitter();Object.assign(bridge,{enabled:true,start(){},stop(){},
    list:()=>({brokerConnected:true,devices:[{id:'boat-cloud-test',online:true,parametersReady:fixture.ready}]}),
    state:()=>({brokerConnected:true,device:{id:'boat-cloud-test',online:true,parametersReady:fixture.ready}}),
    async requestParameters(deviceId,kind,input){
      fixture.calls.push({deviceId,kind,values:input});fixture.ready=false;bridge.emit('state',bridge.state());
      await wait(180);const status=kind==='flash'&&fixture.rejectFlash?3:0;
      if(kind==='write'&&status===0)fixture.values={...input};
      setTimeout(()=>{fixture.ready=true;bridge.emit('state',bridge.state());},300);
      if(fixture.loseResponse)throw Object.assign(Error('设备响应超时，结果未知，请读取确认'),{status:504});
      return parameterFrame(fixture.values,status);
    }});
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only',BOAT_GUEST_USERNAME:'observer',BOAT_GUEST_PASSWORD:'browser-guest-test-only'};
  const server=createServer({env,cloud:bridge});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const feed=setInterval(()=>bridge.emit('telemetry',{deviceId:'boat-cloud-test',receivedAt:Date.now(),ageMs:0,payload:telemetry()}),100);
  const profile=fs.mkdtempSync(path.join(output,'chrome-cloud-parameters-')),errors=[];
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const until=async expression=>{for(let i=0;i<180;i++){if(await evaluate(expression))return;await wait(60);}const diag=await evaluate('({source:boatMonitor.link.source,readOnly:boatMonitor.link.readOnly,connected:boatMonitor.link.connected,cloud:boatMonitor.link.cloud.state(),parameter:document.getElementById("parameterStatus").textContent})');throw Error('Condition timed out: '+expression+'\n'+JSON.stringify(diag)+'\n'+errors.join('\n'));};
    const shot=async name=>{const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
    const login=async(username,password)=>{await evaluate('document.getElementById("accountUsername").value='+JSON.stringify(username)+';document.getElementById("accountPassword").value='+JSON.stringify(password)+';document.getElementById("accountLoginForm").requestSubmit()');await until('!!BoatAuth.user&&!BoatAuth.busy');};
    await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});await until('!!window.boatMonitor&&window.BoatAuth.ready&&document.getElementById("accountLoginDialog").open');
    await login('operator','browser-admin-test-only');await evaluate('document.getElementById("telemetrySource").value="cloud";document.getElementById("telemetrySource").dispatchEvent(new Event("change"))');
    await until('document.getElementById("cloudDevice").value==="boat-cloud-test"&&!document.getElementById("connectButton").disabled');await evaluate('document.getElementById("connectButton").click()');await until('boatMonitor.link.connected&&!boatMonitor.link.readOnly');
    await evaluate('document.getElementById("settingsToggle").click();document.getElementById("readParameters").click()');await until('document.getElementById("parameterStatus").textContent.includes("读取成功")&&!boatMonitor.params.busy');
    assert.equal(await evaluate('boatMonitor.params.confirmed.kpX2PerMps'),42);assert.equal(fixture.calls.length,1);await shot('cloud-parameters-desktop-read');
    await until('!document.getElementById("writeParameters").disabled');await evaluate('document.querySelector("[data-key=kpX2PerMps]").value="91";document.getElementById("writeParameters").click()');
    await until('document.getElementById("parameterStatus").textContent.includes("写入成功")&&!boatMonitor.params.busy');assert.equal(fixture.values.kpX2PerMps,91);
    await until('!document.getElementById("saveFlash").disabled');await evaluate('document.getElementById("saveFlash").click()');await until('document.getElementById("parameterStatus").textContent.includes("CH6")&&!boatMonitor.params.busy');
    assert.equal(await evaluate('document.getElementById("parameterStatus").dataset.tone'),'warning');assert.equal(fixture.calls.at(-1).kind,'flash');
    fixture.rejectFlash=false;await until('!document.getElementById("saveFlash").disabled');await evaluate('document.getElementById("saveFlash").click()');await until('document.getElementById("parameterStatus").textContent.includes("已保存到 Flash")&&!boatMonitor.params.busy');
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});await wait(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await shot('cloud-parameters-mobile-flash');
    await until('!document.getElementById("writeParameters").disabled');fixture.loseResponse=true;const before=fixture.calls.length;
    await evaluate('document.querySelector("[data-key=kpX2PerMps]").value="92";document.getElementById("writeParameters").click()');await until('document.getElementById("parameterStatus").textContent.includes("写入可能已生效")&&!boatMonitor.params.busy');
    assert.equal(fixture.calls.length,before+1);assert.equal(fixture.values.kpX2PerMps,92);assert.equal(await evaluate('boatMonitor.params.confirmed'),null);
    assert.equal(await evaluate('document.getElementById("writeParameters").disabled'),true);assert.equal(await evaluate('document.getElementById("saveFlash").disabled'),true);await shot('cloud-parameters-mobile-uncertain');
    fixture.loseResponse=false;await until('!document.getElementById("readParameters").disabled');await evaluate('document.getElementById("readParameters").click()');await until('document.getElementById("parameterStatus").textContent.includes("读取成功")&&!boatMonitor.params.busy');assert.equal(await evaluate('boatMonitor.params.confirmed.kpX2PerMps'),92);
    await evaluate('document.getElementById("settingsClose").click();document.getElementById("accountLogout").click()');await until('!BoatAuth.user&&!BoatAuth.busy');
    await evaluate('document.getElementById("accountLoginOpen").click()');await login('observer','browser-guest-test-only');
    const count=fixture.calls.length;assert.match(await evaluate('boatMonitor.link.cloud.request("read").then(()=>"unexpected",error=>error.message)'),/访客/);assert.equal(fixture.calls.length,count);
    assert.equal(await evaluate('document.getElementById("settingsToggle").hidden'),true);assert.deepEqual(errors,[]);
    console.log('Chrome cloud parameters passed: real local auth/API/SSE, 1440px/320px, admin read/write/Flash and MCU refusal, consumed-token capability transition, unknown write result requires read, guest denied.');
  }finally{clearInterval(feed);socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
