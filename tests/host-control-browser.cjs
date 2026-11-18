/* 使用真实账户/HTTP/控制服务/SSE，仅模拟船端串口目标与MQTT ACK。 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixtureServer}=require('./mqtt-browser-fixture.cjs');
const {browserSession,startTelemetry}=require('./amap-browser.cjs');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  fs.mkdirSync(output,{recursive:true});const state=fs.mkdtempSync(path.join(output,'host-control-state-'));
  const server=createFixtureServer({env:{STATE_DIRECTORY:state,BOAT_ACCOUNTS_FILE:path.join(state,'accounts.json')}});
  const bridge=server.boatCloud,id='boat-mqtt-test',start=Date.now();
  const fixture={state:0,leaseId:'0000000000000000',sequence:0,valid:true,speed:1234,heading:35999,calls:[],ackDelay:450};
  Object.assign(bridge,{brokerConnected:true,controlSubscribed:true,controlLocks:new Set(),firmwareLocks:new Set(),pendingParameters:new Map(),
    get:deviceId=>deviceId===id?{id,online:true,lastReceivedAt:Date.now()}:null,
    claimControl(deviceId){assert.equal(deviceId,id);assert.equal(this.controlLocks.has(id),false);this.controlLocks.add(id);},
    releaseControl(deviceId){this.controlLocks.delete(deviceId);},
    publishControl(deviceId,packet){
      assert.equal(deviceId,id);assert.ok([5,6].includes(packet[28]));fixture.calls.push(Buffer.from(packet));
      setTimeout(()=>{fixture.state=packet[28]===5?3:2;fixture.leaseId=packet.subarray(16,24).toString('hex');fixture.sequence=packet.readUInt32LE(24);emit();},fixture.ackDelay);
      return Promise.resolve();
    }});
  function emit(){
    const value={version:1,token:'0123456789abcdef',uptimeMs:Date.now()-start,state:fixture.state,leaseId:fixture.leaseId,sequence:fixture.sequence,
      mode:fixture.state===3?2:1,reason:fixture.state===3&&!fixture.valid?6:0,enabled:true,timeoutMs:500,testMode:false,
      hostControl:{enabled:fixture.state===3,valid:fixture.valid,targetSpeedMmS:fixture.speed,targetHeadingCdeg:fixture.heading,ageMs:0,timeoutMs:300}};
    bridge.emit('control-state',{deviceId:id,payload:Buffer.from(JSON.stringify(value))});
  }
  const timer=setInterval(emit,100);emit();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await browserSession(server,'host-control',async browser=>{
    const {evaluate,until,send,viewportShot}=browser;
    await startTelemetry(browser);await evaluate('boatMonitor.viewer.configure("animation",false);void 0');
    await until('!document.getElementById("hostControlToggle").disabled');
    assert.equal(await evaluate('document.getElementById("hostTargetSpeed").textContent'),'1.234');
    assert.equal(await evaluate('document.getElementById("hostTargetHeading").textContent'),'359.99');
    await evaluate('document.getElementById("hostControlPanel").scrollIntoView({block:"center",behavior:"instant"})');
    const point=await evaluate('(()=>{const r=document.getElementById("hostControlToggle").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    assert.equal(await evaluate('document.getElementById("hostControlToggle").disabled'),true);
    assert.equal(await evaluate('document.getElementById("hostControlToggle").getAttribute("aria-pressed")'),'false','No optimistic takeover');
    await until('boatMonitor.hostControl.value?.hostControl?.enabled===true&&!boatMonitor.hostControl.busy');
    assert.equal(fixture.calls.length,1);assert.equal(fixture.calls[0][28],5);
    await viewportShot('host-control-desktop-dark');
    fixture.speed=-500;fixture.heading=0;emit();
    await until('document.getElementById("hostTargetSpeed").textContent==="-0.500"&&document.getElementById("hostTargetHeading").textContent==="0.00"');
    fixture.valid=false;emit();await until('document.getElementById("hostTargetSpeed").textContent==="--"');
    assert.equal(await evaluate('boatMonitor.hostControl.value.hostControl.enabled'),true,'Invalid target stops motion without pretending the source was disabled');
    fixture.valid=true;fixture.speed=1234;fixture.heading=35999;emit();
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');
    await until('boatMonitor.driver.remote?.state===3');
    assert.equal(await evaluate('document.getElementById("driverEnable").disabled'),true);
    await evaluate('document.getElementById("driverControlOptions").open=true');
    await until('document.getElementById("driverHostTargets").textContent.includes("1.234")');
    await evaluate('document.getElementById("driverHostControlToggle").click()');
    await until('boatMonitor.hostControl.value?.hostControl?.enabled===false&&!boatMonitor.hostControl.busy');
    assert.equal(fixture.calls.length,2);assert.equal(fixture.calls[1][28],6);
    await evaluate('BoatWorkspace.navigate("overview",{focus:false})');
    for(const [theme,width]of [['dark',375],['light',320]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:false});
      await evaluate('BoatUI.setTheme('+JSON.stringify(theme)+');document.getElementById("hostControlPanel").scrollIntoView({block:"center",behavior:"instant"})');await wait(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&document.getElementById("hostControlPanel").scrollWidth<=document.getElementById("hostControlPanel").clientWidth'),true);
      await viewportShot('host-control-'+theme+'-'+width);
    }
    const created=await evaluate('fetch("/api/auth/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"pilot-test",password:"browser-pilot-test-only",role:"driver"})}).then(r=>r.status)');
    assert.equal(created,201);
    await evaluate('BoatAuth.logout()');await until('!BoatAuth.user');
    await evaluate('BoatAuth.login("observer","browser-guest-test-only")');await until('BoatAuth.user?.role==="guest"');
    await evaluate('connectTestBoat()');await until('document.getElementById("hostTargetSpeed").textContent==="1.234"');
    assert.equal(await evaluate('[...document.querySelectorAll("[data-host-control-toggle]")].every(button=>button.hidden)'),true);
    assert.equal(await evaluate('fetch("/api/cloud/host-control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({deviceId:"boat-mqtt-test",enabled:true})}).then(r=>r.status)'),403);
    await evaluate('BoatAuth.logout()');await until('!BoatAuth.user');
    await evaluate('BoatAuth.login("pilot-test","browser-pilot-test-only")');await until('BoatAuth.user?.role==="driver"');
    await evaluate('connectTestBoat()');await until('!document.getElementById("hostControlToggle").hidden&&!document.getElementById("hostControlToggle").disabled');
    await evaluate('document.getElementById("hostControlToggle").click()');await until('boatMonitor.hostControl.value?.hostControl?.enabled===true&&!boatMonitor.hostControl.busy');
    await evaluate('document.getElementById("hostControlToggle").click()');await until('boatMonitor.hostControl.value?.hostControl?.enabled===false&&!boatMonitor.hostControl.busy');
    assert.equal(fixture.calls.length,4);
    console.log('Chrome host control passed: native click, real API/MCU ACK, signed live targets, invalid/recovery, driving exclusion/stop, administrator/driver permissions, guest monitoring, dark/light and 320/375px layouts.');
  });}finally{clearInterval(timer);server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
