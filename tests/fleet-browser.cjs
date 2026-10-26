/* 真实CloudBridge/账户/HTTP/SSE与Chrome；仅MQTT传输端为本机模拟船，绝不访问生产Broker。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),{CloudBridge}=require('../server/cloud');
const P=require('../public/utils/uart4Protocol'),PP=require('../server/parameter-protocol');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function telemetry(vessel){
  const result=Buffer.alloc(176);vessel.sequence++;
  for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){
    const frame=result.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length,3]);frame.writeUInt32LE(vessel.sequence,6);frame.writeUInt32LE(vessel.sequence*100,10);
    if(type===1)for(const base of [14,38]){frame[base]=7;frame[base+1]=32;frame.writeUInt16LE(Math.round(vessel.voltage*100),base+2);frame.writeUInt16LE(1250,base+4);frame.writeUInt32LE(vessel.rpm,base+12);frame.writeUInt16LE(20,base+20);}
    if(type===2){frame.writeInt16LE(Math.round(vessel.speed*1000),14);frame.writeUInt16LE(vessel.sourceAge,20);frame.writeInt32LE(Math.round(vessel.latitude*1e7),26);frame.writeInt32LE(Math.round(vessel.longitude*1e7),30);frame.writeUInt16LE(vessel.heading*100,34);frame[36]=15;}
    if(type===3){frame[5]=47;frame.writeInt16LE(2500,14);frame.writeUInt16LE(Math.round(vessel.speed*1000),16);frame.writeInt16LE(100,18);frame.writeUInt16LE(vessel.sourceAge,20);frame.writeUInt16LE(2500,22);frame.writeUInt16LE(vessel.heading*100,26);frame.writeUInt16LE(vessel.heading*100,28);frame[32]=2;frame[33]=3;}
    if(type===4){frame.writeInt16LE(500,20);frame.writeInt16LE(-300,22);frame.writeInt16LE(2300,24);frame.writeUInt16LE(20,26);frame[32]=127;}
    frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);
  }
  return result;
}
function vessel(id,index,speed){
  return {id,index,speed,sequence:0,heading:index===1?45:225,voltage:24+index/10,rpm:index*1100,latitude:31+index/100,longitude:121+index/100,
    running:true,sourceAge:20,epoch:1,replyDelay:75,values:{...Object.fromEntries(Object.entries(PP.RANGES).map(([key,range])=>[key,range[0]])),kpX2PerMps:index*101}};
}
async function main(){
  fs.mkdirSync(output,{recursive:true});const run=fs.mkdtempSync(path.join(output,'fleet-browser-state-')),vessels=new Map(),commands=[],errors=[];
  let bridge,feed;
  const capability=item=>bridge.acceptMessage('boats/'+item.id+'/parameter-capability',Buffer.from(JSON.stringify({version:1,token:(BigInt(item.index)*1000n+BigInt(item.epoch)).toString(16).padStart(16,'0'),uptimeMs:100000+item.sequence*100})));
  class SimulatedMQTT extends EventEmitter{
    constructor(){super();this.connected=true;}
    subscribe(topics,options,callback){queueMicrotask(()=>callback(null));}
    publish(topic,request,options,callback){
      callback?.();if(request.toString('ascii',0,4)!=='BPC1')return;
      const id=topic.split('/')[1],item=vessels.get(id),frame=request.subarray(16),kind={16:'read',17:'write',18:'flash'}[frame[3]];
      assert.ok(item&&kind,'Parameter destination must name a known simulated boat');commands.push({deviceId:id,kind});
      const replyTimer=setTimeout(()=>{
        if(kind==='write'){
          const copy=Buffer.from(frame);copy[3]=0x90;copy.writeUInt16LE(P.crc16CcittFalse(copy,2,52),54);item.values={...P.decodeParameterFrame(copy).parameters};
        }
        const response=Buffer.from(P.encodeParameterWriteRequest(request.readUInt32LE(22),item.values));response[3]=0x90;response.writeUInt16LE(P.crc16CcittFalse(response,2,52),54);
        bridge.acceptMessage('boats/'+id+'/parameter-response',Buffer.concat([request.subarray(0,16),response]));item.epoch++;if(item.running)capability(item);
      },item.replyDelay);replyTimer.unref?.();
    }
    end(){clearInterval(feed);}
  }
  const mqtt=new SimulatedMQTT(),env={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://fixture.invalid:1883',BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'fleet-admin',BOAT_ADMIN_PASSWORD:'fleet-browser-administrator',BOAT_GUEST_USERNAME:'fleet-guest',BOAT_GUEST_PASSWORD:'fleet-browser-observer',BOAT_AMAP_KEY:'',BOAT_AMAP_SECURITY_CODE:''};
  bridge=new CloudBridge({env,connect:()=>mqtt,tickMs:100});
  const server=createServer({env,cloud:bridge,accountOptions:{storeFile:path.join(run,'accounts.json')},mapOptions:{file:path.join(run,'map-settings.json')},mqttAdminOptions:{client:async()=>({devices:[],revision:'a'.repeat(64),canCreate:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));mqtt.emit('connect');
  feed=setInterval(()=>{for(const item of vessels.values())if(item.running){bridge.acceptMessage('boats/'+item.id+'/telemetry',telemetry(item));capability(item);}},100);
  const profile=fs.mkdtempSync(path.join(output,'chrome-fleet-'));
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(message.method==='Page.javascriptDialogOpening')send('Page.handleJavaScriptDialog',{accept:true}).catch(error=>errors.push(error.message));
      if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const until=async(expression,label=expression)=>{for(let i=0;i<220;i++){if(await evaluate(expression))return;await wait(60);}throw Error('Condition timed out: '+label+'\n'+await evaluate('JSON.stringify({hash:location.hash,auth:BoatAuth.state(),cloud:boatMonitor.link.state(),fleet:boatMonitor.fleet.state(),parameter:document.getElementById("parameterStatus").textContent})')+'\n'+errors.join('\n'));};
    const login=async(role='admin')=>{
      await evaluate('document.getElementById("accountUsername").value='+JSON.stringify(role==='guest'?'fleet-guest':'fleet-admin')+';document.getElementById("accountPassword").value='+JSON.stringify(role==='guest'?'fleet-browser-observer':'fleet-browser-administrator')+';document.getElementById("accountLoginForm").requestSubmit()');
      await until('BoatAuth.user?.role==='+JSON.stringify(role)+'&&!BoatAuth.busy');
    };
    const card=(id,selector='')=>'document.querySelector('+JSON.stringify('.fleet-card[data-device-id="'+id+'"]'+(selector?' '+selector:''))+')';
    const speed=id=>card(id,'.fleet-card-facts > div:nth-child(4) dd b');
    const read=async()=>{await until('!document.getElementById("readParameters").disabled');await evaluate('document.getElementById("readParameters").click()');await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").textContent.includes("读取成功")');};
    const shot=async name=>{const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
    const layout=async(width,theme,view='fleet')=>{
      await send('Emulation.setDeviceMetricsOverride',{width,height:width<600?900:1000,deviceScaleFactor:1,mobile:width<600});
      await evaluate('BoatUI.setTheme('+JSON.stringify(theme)+');'+(view==='fleet'?'BoatWorkspace.navigate("fleet")':''));await wait(200);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,width+'px '+view+' page fits');
      if(width>740)assert.equal(await evaluate('document.querySelector(".sidebar").getBoundingClientRect().top>=document.querySelector(".topbar").getBoundingClientRect().bottom-1'),true,width+'px sidebar clears the wrapped header');
      if(view==='fleet')assert.equal(await evaluate('[...document.querySelectorAll(".fleet-card:not([hidden])")].some(el=>el.scrollWidth>el.clientWidth+1)'),false,width+'px fleet cards fit');
      else assert.equal(await evaluate('document.getElementById('+JSON.stringify(view)+').scrollWidth>document.getElementById('+JSON.stringify(view)+').clientWidth+1'),false,width+'px '+view+' fits');
      await shot('fleet-'+view+'-'+width+'-'+theme);
      if(view==='fleet'&&width===320){
        await evaluate('document.querySelector(".fleet-card").scrollIntoView({block:"start",behavior:"instant"})');
        await shot('fleet-card-320-'+theme);
        await evaluate('window.scrollTo({top:0,behavior:"instant"})');
      }
      if(view==='fleet'&&width===1440){
        await evaluate('document.getElementById("fleetMap").scrollIntoView({block:"center",behavior:"instant"})');
        await shot('fleet-map-'+theme);
        await evaluate('window.scrollTo({top:0,behavior:"instant"})');
      }
    };
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['*://tile.openstreetmap.org/*','*://*.tile.openstreetmap.org/*','*://webapi.amap.com/*']});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.testEventStreams=[];const NativeEventSource=window.EventSource;window.EventSource=class extends NativeEventSource{constructor(url,options){super(url,options);this.testUrl=String(url);this.testClosed=false;window.testEventStreams.push(this);}close(){this.testClosed=true;super.close();}};Object.defineProperty(navigator,"bluetooth",{configurable:true,value:undefined});'});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await until('!!window.boatMonitor&&BoatAuth.ready');assert.equal(await evaluate('location.hash'),'#fleet');await login();
    assert.equal(await evaluate('document.querySelector(".toolbar").contains(document.getElementById("settingsToggle"))'),false);
    assert.equal(await evaluate('document.getElementById("sidebarSettings")===null'),true);
    assert.equal(await evaluate('document.getElementById("settingsToggle").hidden'),true);
    await until('boatMonitor.fleet.streamConnected');assert.equal(await evaluate('document.getElementById("fleetTotal").textContent'),'0');
    await evaluate('document.getElementById("platformSettingsToggle").click()');await until('document.getElementById("platformSettingsDialog").open');
    assert.equal(await evaluate('document.getElementById("settingsDialog").open'),false);assert.equal(await evaluate('document.getElementById("platformSettingsDialog").contains(document.getElementById("parameterFields"))'),false);
    assert.equal(await evaluate('document.getElementById("platformSettingsDialog").contains(document.getElementById("userManagement"))'),true);
    await evaluate('document.getElementById("platformSettingsClose").click()');
    const alpha=vessel('boat-alpha',1,1.1),beta=vessel('boat-beta',2,2.2),long=vessel('inspection-long-vessel-'+'x'.repeat(38),3,0);
    for(const item of [alpha,beta,long])vessels.set(item.id,item);
    await until('document.getElementById("fleetTotal").textContent==="3"&&document.getElementById("fleetOnline").textContent==="3"');
    await until('document.querySelectorAll(".fleet-parameter-button:not([hidden]):not(:disabled)").length===3');
    await until(speed(alpha.id)+'.textContent==="1.10"&&'+speed(beta.id)+'.textContent==="2.20"');
    await until('boatMonitor.fleetMapView.mapReady&&boatMonitor.fleetMapView.markers.size===3');
    assert.equal(await evaluate('document.querySelectorAll("#fleetMap .fleet-map-pin").length'),3);
    assert.equal(await evaluate('document.querySelectorAll("#fleetMapLegend .fleet-map-legend-item[data-located=true]").length'),3);
    assert.equal(await evaluate('document.getElementById("fleetMoving").textContent'),'2');assert.equal(server.boatCloudApi.getClientCount(),1);
    await evaluate('document.getElementById("fleetSearch").value="BETA";document.getElementById("fleetSearch").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.querySelectorAll(".fleet-card:not([hidden])").length'),1);assert.equal(await evaluate(card(beta.id)+'.hidden'),false);
    await evaluate('document.getElementById("fleetSearch").value="";document.getElementById("fleetSearch").dispatchEvent(new Event("input"))');
    alpha.sourceAge=1000;await until(speed(alpha.id)+'.textContent==="--"');assert.equal(await evaluate(speed(beta.id)+'.textContent'),'2.20');assert.equal(await evaluate(card(alpha.id)+'.dataset.online'),'true');
    alpha.sourceAge=20;beta.running=false;bridge.acceptMessage('boats/'+beta.id+'/status',Buffer.from('offline'));
    await until('document.getElementById("fleetOnline").textContent==="2"&&'+card(beta.id)+'.dataset.online==="false"');assert.equal(await evaluate(speed(beta.id)+'.textContent'),'--');
    assert.equal(await evaluate(card(beta.id,'.fleet-parameter-button')+'.disabled'),true);
    await evaluate(card(beta.id,'.fleet-parameter-button')+'.click()');
    assert.equal(await evaluate('document.getElementById("settingsDialog").open'),false);
    await evaluate('document.getElementById("fleetFilter").value="offline";document.getElementById("fleetFilter").dispatchEvent(new Event("change"))');assert.equal(await evaluate('document.querySelectorAll(".fleet-card:not([hidden])").length'),1);
    await evaluate('document.getElementById("fleetFilter").value="all";document.getElementById("fleetFilter").dispatchEvent(new Event("change"))');beta.running=true;
    await until('document.getElementById("fleetOnline").textContent==="3"&&'+speed(alpha.id)+'.textContent==="1.10"');
    for(const width of [1440,768,375,320])for(const theme of ['dark','light'])await layout(width,theme);
    await evaluate(card(alpha.id,'.fleet-parameter-button')+'.click();'+card(beta.id,'.fleet-parameter-button')+'.click()');
    await until('document.getElementById("settingsDialog").open&&boatMonitor.link.connected&&boatMonitor.link.selectedId==="boat-beta"');
    assert.equal(await evaluate('location.hash'),'#fleet');
    assert.equal(await evaluate('document.getElementById("parameterDeviceName").textContent'),'boat-beta');
    assert.equal(await evaluate('document.getElementById("settingsDialog").dataset.deviceId'),'boat-beta');
    assert.equal(commands.length,0,'Opening cards never sends a parameter request');
    await evaluate('document.getElementById("settingsClose").click()');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate('(boatMonitor.fleetMapView.markers.get("boat-alpha").native.fire("click"),true)');
    await until('location.hash==="#overview"&&boatMonitor.link.connected&&boatMonitor.link.selectedId==="boat-alpha"');await until('document.getElementById("boatActual").textContent==="1.100"');
    assert.equal(await evaluate('document.getElementById("singleBoatNav").hidden'),false);
    assert.equal(await evaluate('document.getElementById("singleBoatNav").open'),true);
    assert.equal(await evaluate('document.getElementById("singleBoatNavName").textContent'),'boat-alpha');
    assert.equal(await evaluate('document.getElementById("workspaceBreadcrumbBoat").textContent'),'boat-alpha');
    await evaluate('document.querySelector("#singleBoatNav summary").click()');
    await wait(600);
    assert.equal(await evaluate('document.getElementById("singleBoatNav").open'),false,'Live telemetry preserves manual menu collapse');
    await evaluate('document.querySelector("#singleBoatNav summary").click()');
    for(const theme of ['dark','light']){
      await evaluate('BoatUI.setTheme('+JSON.stringify(theme)+')');
      await wait(250);
      await shot('fleet-selected-navigation-'+theme);
    }
    assert.equal(server.boatCloudApi.getClientCount(),2);const fleetInstance=await evaluate('testEventStreams.filter(stream=>stream.testUrl==="/api/cloud/fleet/events").length');
    await evaluate('BoatWorkspace.navigate("fleet");'+card(alpha.id,'.fleet-parameter-button')+'.click()');await until('document.getElementById("settingsDialog").open');
    assert.equal(await evaluate('location.hash'),'#fleet');
    assert.equal(await evaluate('document.getElementById("parameterDeviceName").textContent'),'boat-alpha');assert.equal(await evaluate('document.getElementById("writeParameters").disabled&&document.getElementById("saveFlash").disabled'),true);
    assert.match(await evaluate('boatMonitor.params.command("write").then(()=>"unexpected",error=>error.message)'),/读取/);assert.match(await evaluate('boatMonitor.params.command("flash").then(()=>"unexpected",error=>error.message)'),/读取/);assert.equal(commands.length,0);
    await read();assert.equal(await evaluate('boatMonitor.params.confirmed.kpX2PerMps'),101);assert.deepEqual(commands.at(-1),{deviceId:'boat-alpha',kind:'read'});
    await evaluate('document.querySelector("[data-key=kpX2PerMps]").value="123";document.querySelector("[data-key=kpX2PerMps]").dispatchEvent(new Event("input"))');
    assert.match(await evaluate('boatMonitor.params.command("flash").then(()=>"unexpected",error=>error.message)'),/未生效/);
    alpha.replyDelay=400;
    await until('!document.getElementById("writeParameters").disabled');await evaluate('document.getElementById("writeParameters").click()');
    await until('!!boatMonitor.link.pending&&[...document.querySelectorAll(".fleet-parameter-button")].every(button=>button.disabled)');
    assert.match(await evaluate('boatMonitor.openBoatSettings("boat-beta").then(()=>"unexpected",error=>error.message)'),/等待.*参数操作/);
    assert.equal(await evaluate('boatMonitor.link.selectedId'),'boat-alpha');
    await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").textContent.includes("写入成功")');alpha.replyDelay=75;
    assert.equal(alpha.values.kpX2PerMps,123);assert.equal(beta.values.kpX2PerMps,202);
    await until('!document.getElementById("saveFlash").disabled');await evaluate('document.getElementById("saveFlash").click()');await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").textContent.includes("已保存到 Flash")');assert.deepEqual(commands.at(-1),{deviceId:'boat-alpha',kind:'flash'});
    for(const width of [1440,375,320])for(const theme of ['dark','light'])await layout(width,theme,'settingsDialog');
    await evaluate('document.getElementById("settingsClose").click();BoatWorkspace.navigate("fleet")');await evaluate(card(beta.id,'.fleet-parameter-button')+'.click()');
    await until('boatMonitor.link.connected&&boatMonitor.link.selectedId==="boat-beta"&&document.getElementById("boatActual").textContent==="2.200"');assert.equal(await evaluate('boatMonitor.params.confirmed'),null);
    await until('document.getElementById("settingsDialog").open&&document.getElementById("settingsDialog").dataset.deviceId==="boat-beta"');
    assert.equal(await evaluate('location.hash'),'#fleet');
    alpha.speed=3.33;await until(speed(alpha.id)+'.textContent==="3.33"');assert.equal(await evaluate('document.getElementById("boatActual").textContent'),'2.200');
    assert.equal(await evaluate('testEventStreams.filter(stream=>stream.testUrl==="/api/cloud/fleet/events").length'),fleetInstance);assert.equal(server.boatCloudApi.getClientCount(),2);
    assert.deepEqual(await evaluate('testEventStreams.filter(stream=>!stream.testClosed).map(stream=>stream.testUrl).sort()'),['/api/cloud/events?device=boat-beta','/api/cloud/fleet/events']);
    assert.equal(await evaluate('document.getElementById("parameterDeviceName").textContent'),'boat-beta');assert.equal(await evaluate('document.getElementById("writeParameters").disabled&&document.getElementById("saveFlash").disabled'),true);
    await read();assert.equal(await evaluate('boatMonitor.params.confirmed.kpX2PerMps'),202);assert.deepEqual(commands.at(-1),{deviceId:'boat-beta',kind:'read'});
    await evaluate('document.querySelector("[data-key=kpX2PerMps]").value="234";document.querySelector("[data-key=kpX2PerMps]").dispatchEvent(new Event("input"))');
    await until('!document.getElementById("writeParameters").disabled');await evaluate('document.getElementById("writeParameters").click()');await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").textContent.includes("写入成功")');
    await until('!document.getElementById("saveFlash").disabled');await evaluate('document.getElementById("saveFlash").click()');await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").textContent.includes("已保存到 Flash")');
    assert.equal(alpha.values.kpX2PerMps,123);assert.equal(beta.values.kpX2PerMps,234);
    assert.deepEqual(commands.filter(command=>command.deviceId==='boat-beta').map(command=>command.kind),['read','write','flash']);
    await evaluate('document.getElementById("settingsClose").click();document.getElementById("platformSettingsToggle").click()');await until('document.getElementById("platformSettingsDialog").open');
    for(const width of [1440,768,375,320])for(const theme of ['dark','light'])await layout(width,theme,'platformSettingsDialog');
    await evaluate('document.getElementById("platformSettingsClose").click();document.getElementById("accountLogout").click()');await until('!BoatAuth.user&&!BoatAuth.busy');
    await until('boatMonitor.fleet.devices.size===0');assert.equal(await evaluate('document.getElementById("fleetTotal").textContent'),'0');
    await evaluate('document.getElementById("accountLoginOpen").click()');await login('guest');await until('boatMonitor.fleet.streamConnected&&document.getElementById("fleetTotal").textContent==="3"');
    assert.equal(await evaluate('document.getElementById("settingsToggle").hidden&&document.getElementById("platformSettingsToggle").hidden'),true);
    assert.equal(await evaluate('[...document.querySelectorAll(".fleet-parameter-button")].every(button=>button.hidden)'),true);
    assert.match(await evaluate('boatMonitor.openBoatSettings("boat-beta").then(()=>"unexpected",error=>error.message)'),/管理员|访客/);
    await evaluate(card(beta.id,'.fleet-parameter-button')+'.click()');assert.equal(await evaluate('document.getElementById("settingsDialog").open'),false);
    const before=commands.length;assert.match(await evaluate('boatMonitor.params.command("write").then(()=>"unexpected",error=>error.message)'),/管理员|访客/);assert.equal(commands.length,before);
    assert.equal(await evaluate('fetch("/api/cloud/parameters",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({deviceId:"boat-beta",kind:"read"})}).then(response=>response.status)'),403);
    assert.equal(await evaluate('fetch("/api/mqtt/devices").then(response=>response.status)'),403);assert.deepEqual(errors,[]);
    console.log('Chrome fleet passed: real local CloudBridge/auth/API/SSE, three concurrent boats, per-source expiry/offline/recovery, search/filter, selected telemetry isolation and per-boat read/write/Flash, one fleet plus one detail stream, split settings and guest denial, 1440/768/375/320px dark/light screenshots.');
  }finally{
    clearInterval(feed);socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
    if(path.dirname(run)===output&&path.basename(run).startsWith('fleet-browser-state-'))fs.rmSync(run,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
