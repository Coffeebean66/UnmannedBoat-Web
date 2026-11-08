/* 真实 Chrome 与本机 HTTP 接管链路；只替换浏览器的 Gamepad 设备读数。 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {browserSession,login,startTelemetry}=require('./amap-browser.cjs');
const {createDriverFixture}=require('./driver-browser-fixture.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const lbOnly=process.argv.includes('--lb-only');
const dpadOnly=process.argv.includes('--dpad-only');
const gamepadScript=`window.gamepadTest={pads:[{index:0,id:'Xbox Wireless Controller · browser test',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0})),timestamp:0}]};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>gamepadTest.pads});window.setPadButton=(index,value)=>{gamepadTest.pads[0].buttons[index]={pressed:value,value:Number(value)};};`;
async function dpadChecks(browser,server){
  const {evaluate,until,viewportShot}=browser;
  await evaluate('window.gamepadFollowEvents=0;document.getElementById("mapFollow").addEventListener("change",()=>gamepadFollowEvents++);void 0');
  await evaluate('document.activeElement?.blur();document.getElementById("mapFollow").checked=false;boatMonitor.driver.setMediaFocus("video");window.dpadVideoCenter=boatMonitor.map.getCenter();setPadButton(15,true);void 0');
  await until('boatMonitor.driver.gamepad.sample.mapX===1');await wait(350);
  assert.deepEqual(await evaluate('boatMonitor.map.getCenter()'),await evaluate('dpadVideoCenter'),'图传主画面不平移地图小窗');
  await evaluate('setPadButton(15,false)');await until('boatMonitor.driver.gamepad.sample.mapX===0');
  for(const provider of ['osm','amap','arcgis','tianditu']){
    await evaluate('boatMonitor.map.switchProvider('+JSON.stringify(provider)+')');await until('boatMonitor.map.ready&&!boatMonitor.map.switching');
    await evaluate('boatMonitor.driver.setMediaFocus("map");boatMonitor.map.setRotation(73);boatMonitor.map.setView([31.23,121.47],18,{animate:false});void 0');await wait(200);
    for(const [button,x,y]of [[15,1,0],[12,0,-1],[14,-1,0],[13,0,1]]){
      await evaluate('window.dpadAnchor=boatMonitor.map.getCenter();window.dpadPixel=boatMonitor.map.latLngToContainerPoint(dpadAnchor);setPadButton('+button+',true);void 0');
      await until('(()=>{const p=boatMonitor.map.latLngToContainerPoint(dpadAnchor);return Math.hypot(p.x-dpadPixel.x,p.y-dpadPixel.y)>25;})()');
      const delta=await evaluate('(()=>{const p=boatMonitor.map.latLngToContainerPoint(dpadAnchor);return {x:p.x-dpadPixel.x,y:p.y-dpadPixel.y};})()');
      assert.ok((x?delta.x*x:delta.y*y)<-20,provider+'旋转后沿屏幕方向移动: '+JSON.stringify(delta));
      assert.ok(Math.abs(x?delta.y:delta.x)<3,provider+'没有横向偏移: '+JSON.stringify(delta));
      await evaluate('setPadButton('+button+',false)');await until('boatMonitor.driver.gamepad.sample.mapX===0&&boatMonitor.driver.gamepad.sample.mapY===0');
      const center=await evaluate('boatMonitor.map.getCenter()');await wait(220);assert.deepEqual(await evaluate('boatMonitor.map.getCenter()'),center,provider+'松键后地图停止');
    }
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),18);assert.equal(await evaluate('boatMonitor.map.getRotation()'),73);
    const restores=await evaluate('gamepadFollowEvents');await evaluate('setPadButton(0,true)');
    await until('boatMonitor.driver.gamepad.sample.follow&&document.getElementById("mapFollow").checked&&document.getElementById("driverMapFollow").getAttribute("aria-pressed")==="true"');
    await until('(()=>{const m=boatMonitor.map,p=m.latLngToContainerPoint(boatMonitor.mapVectors.marker.position),s=m.getSize();return m.getZoom()===16&&Math.hypot(p.x-s.x/2,p.y-s.y/2)<3;})()');
    await wait(250);assert.equal(await evaluate('gamepadFollowEvents'),restores+1,provider+'长按A仅恢复跟随一次');
    assert.equal(await evaluate('document.getElementById("mapFollow").checked'),true,provider+'A长按不反复切换');
    await evaluate('setPadButton(0,false);document.getElementById("mapFollow").checked=false;void 0');await until('!boatMonitor.driver.gamepad.sample.follow');
  }
  await evaluate('document.getElementById("mapFollow").checked=true;document.getElementById("mapFollow").dispatchEvent(new Event("change"));setPadButton(15,true);void 0');
  await until('!document.getElementById("mapFollow").checked&&document.getElementById("driverMapFollow").getAttribute("aria-pressed")==="false"');
  await evaluate('setPadButton(15,false)');await until('boatMonitor.driver.gamepad.sample.mapX===0');
  const panned=await evaluate('boatMonitor.map.getCenter()');await wait(400);assert.deepEqual(await evaluate('boatMonitor.map.getCenter()'),panned,'后续遥测不拉回船位');
  await evaluate('setPadButton(15,true);setPadButton(0,true);void 0');await until('boatMonitor.driver.gamepad.sample.follow&&document.getElementById("mapFollow").checked');
  await wait(250);assert.equal(await evaluate('document.getElementById("mapFollow").checked'),true,'A和十字键同时按住时优先跟随');
  await evaluate('setPadButton(0,false);setPadButton(15,false);void 0');await until('!boatMonitor.driver.gamepad.sample.follow&&boatMonitor.driver.gamepad.sample.mapX===0');
  await evaluate('setPadButton(15,true)');await until('boatMonitor.driver.gamepad.sample.mapX===1');
  await evaluate('setPadButton(3,true)');await until('document.getElementById("view-driving").dataset.primary==="video"');
  const swapped=await evaluate('boatMonitor.map.getCenter()');await wait(300);assert.deepEqual(await evaluate('boatMonitor.map.getCenter()'),swapped,'Y换回图传后长按十字键不继续平移');
  await evaluate('setPadButton(0,true)');await until('boatMonitor.driver.gamepad.sample.follow');assert.equal(await evaluate('document.getElementById("mapFollow").checked'),false,'图传主画面A不修改跟随');
  await evaluate('setPadButton(0,false)');await until('!boatMonitor.driver.gamepad.sample.follow');
  await evaluate('setPadButton(15,false);setPadButton(3,false);void 0');await until('!boatMonitor.driver.gamepad.sample.swap');
  await evaluate('boatMonitor.driver.setMediaFocus("map");document.getElementById("driverLimit").focus();window.dpadEditingCenter=boatMonitor.map.getCenter();setPadButton(15,true);void 0');
  await wait(350);assert.deepEqual(await evaluate('boatMonitor.map.getCenter()'),await evaluate('dpadEditingCenter'),'编辑输入时不移动地图');
  await evaluate('setPadButton(15,false);setPadButton(0,true);void 0');await until('boatMonitor.driver.gamepad.sample.follow');
  assert.equal(await evaluate('document.getElementById("mapFollow").checked'),false,'编辑输入时A不恢复跟随');
  await evaluate('setPadButton(0,false);document.activeElement?.blur();void 0');await until('!boatMonitor.driver.gamepad.sample.follow');
  await evaluate('setPadButton(0,true)');await until('document.getElementById("mapFollow").checked');
  await evaluate('setPadButton(0,false)');await until('!boatMonitor.driver.gamepad.sample.follow');
  await evaluate('setPadButton(0,true)');await until('boatMonitor.driver.gamepad.sample.follow');
  assert.equal(await evaluate('document.getElementById("mapFollow").checked'),true,'重复按A仍保持跟随开启');
  await evaluate('setPadButton(0,false);document.getElementById("driverMapFollow").click();void 0');assert.equal(await evaluate('document.getElementById("mapFollow").checked'),false,'原跟随按钮仍可关闭');
  await evaluate('document.getElementById("driverMapFollow").click();void 0');assert.equal(await evaluate('document.getElementById("mapFollow").checked'),true,'原跟随按钮仍可恢复');
  assert.equal(server.driverFixture.calls.some(call=>['acquire','input'].includes(call.action)),false,'浏览地图不接管或发送运动');
  await viewportShot('gamepad-dpad-main-map');
}
async function main(){
  const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
  const directory=fs.mkdtempSync(path.join(output,'gamepad-state-'));
  const server=createDriverFixture({env:{BOAT_ACCOUNTS_FILE:path.join(directory,'accounts.json'),BOAT_MAP_CONFIG_FILE:path.join(directory,'map.json'),BOAT_DRIVER_LAYOUT_FILE:path.join(directory,'driver-layout.json'),BOAT_TELEMETRY_HISTORY_FILE:path.join(directory,'history.json'),BOAT_OTA_KEY:'',...(dpadOnly?{BOAT_AMAP_KEY:'a'.repeat(32),BOAT_AMAP_SECURITY_CODE:'b'.repeat(32),BOAT_TIANDITU_KEY:'c'.repeat(32)}:{})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await browserSession(server,dpadOnly?'satellite':'gamepad',async browser=>{
    const {evaluate,until:waitUntil,send,viewportShot}=browser;
    const until=async(expression,...options)=>{
      try{await waitUntil(expression,...options);}catch(error){
        const state=await evaluate('(()=>{const d=boatMonitor.driver,g=d.gamepad;return {focused:document.hasFocus(),hidden:document.hidden,active:d.active,pending:d.pending,reason:d.stopReason,message:d.message,mode:d.nodes.driverMode.value,source:g.source,sample:g.sample,engaged:g.engaged,needsNeutral:g.needsNeutral,input:d.inputs(),responseAge:performance.now()-d.lastInputResponseAt,sampleAge:performance.now()-g.lastTick};})()');
        throw Error(error.message+'\nDriver state: '+JSON.stringify(state)+'\nRecent HTTP commands: '+JSON.stringify(server.driverFixture.calls.slice(-8)),{cause:error});
      }
    };
    const click=async id=>{
      await evaluate('document.getElementById('+JSON.stringify(id)+').scrollIntoView({block:"nearest"})');
      const point=await evaluate('(()=>{const b=document.getElementById('+JSON.stringify(id)+'),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.closest("button")===b&&!b.disabled};})()');
      assert.equal(point.hit,true,id+' accepts a real mouse hit');
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1});
    };
    const button=(index,pressed)=>evaluate('setPadButton('+index+','+pressed+');void 0');
    const axes=(forward,turn)=>evaluate('gamepadTest.pads[0].axes=[0,'+forward+','+turn+',0];void 0');
    const enable=async()=>{
      await evaluate('document.activeElement?.blur();boatMonitor.driver.lastPoll=0;void boatMonitor.driver.poll()');
      await until('!document.getElementById("driverEnable").disabled');await click('driverEnable');await until('boatMonitor.driver.active');
    };
    const engage=async()=>{await until('!boatMonitor.driver.gamepad.needsNeutral');await button(5,true);await until('boatMonitor.driver.gamepad.engaged');};
    await login(browser,'operator','browser-admin-test-only');await startTelemetry(browser);
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});void 0');
    await until('!document.getElementById("driverEnable").disabled');
    assert.equal(await evaluate('boatMonitor.driver.gamepad.source'),'keyboard');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:gamepadScript});await evaluate(gamepadScript);
    await evaluate('document.getElementById("driverControlOptions").open=true;document.getElementById("driverInputSource").value="gamepad";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));document.getElementById("driverMode").value="0";document.getElementById("driverMode").dispatchEvent(new Event("change"));void 0');
    await until('!!boatMonitor.driver.gamepad.sample');
    assert.equal(await evaluate('boatMonitor.driver.active'),false,'Controller selection does not acquire the vessel');
    await axes(-.8,0);await until('document.getElementById("driverEnable").disabled');
    await axes(0,0);await button(5,true);await wait(150);assert.equal(await evaluate('document.getElementById("driverEnable").disabled'),true);
    assert.equal(server.driverFixture.calls.some(call=>call.action==='acquire'),false);
    await button(5,false);await evaluate('document.getElementById("driverControlOptions").open=false');
    // 截图与软件 GPU 预热在接管前完成，保持正式600ms响应保护。
    await viewportShot('gamepad-ready-desktop');
    await send('Page.bringToFront');
    if(dpadOnly){await dpadChecks(browser,server);return;}
    if(!lbOnly){
    server.driverFixture.ackDelay=350;await enable();server.driverFixture.ackDelay=100;
    await engage();await axes(-1,1);await until('boatMonitor.driver.inputs().throttle===200&&boatMonitor.driver.inputs().turn===200');
    await wait(130);assert.ok(server.driverFixture.calls.some(call=>call.action==='input'&&call.throttle===200&&call.turn===200),'Actual HTTP commands carry bounded analog motion');
    await axes(-.5,.5);await until('boatMonitor.driver.inputs().throttle===82&&boatMonitor.driver.inputs().turn===82');
    await axes(-.1,.1);await until('boatMonitor.driver.inputs().throttle===0&&boatMonitor.driver.inputs().turn===0');
    await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyW',key:'w',windowsVirtualKeyCode:87});await wait(120);
    assert.equal(await evaluate('boatMonitor.driver.inputs().throttle'),0,'Keyboard motion does not mix into the selected controller');
    await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyW',key:'w',windowsVirtualKeyCode:87});
    await button(3,true);await until('document.getElementById("view-driving").dataset.primary==="map"');await wait(250);
    assert.equal(await evaluate('document.getElementById("view-driving").dataset.primary'),'map','Holding Y does not keep toggling');await button(3,false);
    await button(5,false);await until('!boatMonitor.driver.active');assert.match(await evaluate('boatMonitor.driver.stopReason'),/松开 RB/);
    await axes(0,0);await enable();await engage();await axes(-1,0);
    await until('boatMonitor.driver.inputs().throttle===200');
    await evaluate('window.originalTestPad=gamepadTest.pads[0];gamepadTest.pads=[null,{...originalTestPad,index:1,id:"second controller",axes:[0,0,0,0]}];const event=new Event("gamepaddisconnected");Object.defineProperty(event,"gamepad",{value:originalTestPad});window.dispatchEvent(event);void 0');
    await until('!boatMonitor.driver.active');assert.equal(await evaluate('boatMonitor.driver.gamepad.sample'),null);
    await evaluate('gamepadTest.pads=[{...originalTestPad,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))}];void 0');await wait(150);
    assert.equal(await evaluate('boatMonitor.driver.active'),false,'Reconnect never resumes a lease');
    await evaluate('document.getElementById("driverMode").value="2";document.getElementById("driverMode").dispatchEvent(new Event("change"));void 0');
    await enable();await engage();const before=await evaluate('boatMonitor.driver.headingValue()');await axes(-1,1);
    await until('boatMonitor.driver.headingValue()!=='+before);await wait(120);
    const heading=server.driverFixture.calls.filter(call=>call.action==='input').at(-1);assert.equal(heading.mode,2);assert.equal(heading.turn,0);assert.equal(heading.throttle,200);
    await button(1,true);await until('!boatMonitor.driver.active');await until('boatMonitor.driver.stopReason.includes("急停")');
    await button(1,false);await button(5,false);await axes(0,0);await enable();await engage();
    await evaluate('document.getElementById("driverInputSource").value="keyboard";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));void 0');
    await until('!boatMonitor.driver.active');assert.equal(await evaluate('boatMonitor.driver.gamepad.source'),'keyboard');
    await button(5,false);await axes(0,0);
    await evaluate('document.getElementById("driverInputSource").value="gamepad";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));boatMonitor.driver.lastPoll=0;void boatMonitor.driver.poll()');
    await until('!document.getElementById("driverTestMode").disabled');
    await evaluate('document.getElementById("driverTestMode").click();void 0');
    await until('boatMonitor.driver.testMode');await enable();await engage();await axes(-1,0);
    await until('boatMonitor.driver.inputs().throttle===200');await wait(120);
    assert.ok(server.driverFixture.calls.some(call=>call.action==='input'&&call.testMode===true&&call.mode===0&&call.throttle===200),'Controller preserves the existing real-PWM test scene');
    await button(1,true);await until('!boatMonitor.driver.active');await button(1,false);await button(5,false);await axes(0,0);
    }
    // LB 沿用真实 HTTP 接管 / 释放；长按一次，等待确认时可再次按下取消。
    await evaluate('document.activeElement?.blur();document.getElementById("driverMode").value="0";document.getElementById("driverMode").dispatchEvent(new Event("change"));boatMonitor.driver.lastPoll=0;void boatMonitor.driver.poll()');
    await until('!document.getElementById("driverEnable").disabled');
    await until('document.hasFocus()&&boatMonitor.driver.gamepad.toggleReady&&performance.now()-boatMonitor.driver.gamepad.lastTick<250');
    server.driverFixture.ackDelay=450;const acquisitions=server.driverFixture.calls.filter(call=>call.action==='acquire').length;
    await button(4,true);await until('boatMonitor.driver.pending');
    assert.equal(await evaluate('boatMonitor.driver.active'),false,'LB waits for the vessel acknowledgement');
    await until('boatMonitor.driver.active');await wait(250);
    assert.equal(await evaluate('boatMonitor.driver.active'),true,'Holding LB does not toggle twice');
    assert.equal(server.driverFixture.calls.filter(call=>call.action==='acquire').length,acquisitions+1);
    assert.equal(await evaluate('boatMonitor.driver.gamepad.engaged'),false,'RB remains required after LB acquire');
    await button(4,false);await until('!boatMonitor.driver.gamepad.sample.lb');
    await engage();await axes(-1,0);await until('boatMonitor.driver.inputs().throttle===200');
    await until('boatMonitor.driver.remote?.sequence>=2');
    assert.ok(server.driverFixture.calls.some(call=>call.action==='input'&&call.throttle===200),'LB-acquired lease carries real HTTP motion after RB enable');
    await button(4,true);await until('!boatMonitor.driver.active');
    assert.match(await evaluate('boatMonitor.driver.stopReason'),/LB/);
    await until('!boatMonitor.driver.remote?.active');
    assert.ok(server.driverFixture.calls.some(call=>call.action==='release'&&call.throttle===0&&call.turn===0),'LB releases with zero motion');
    await button(4,false);await button(5,false);await axes(0,0);await until('!boatMonitor.driver.gamepad.sample.lb');
    await evaluate('boatMonitor.driver.lastPoll=0;void boatMonitor.driver.poll()');await until('!document.getElementById("driverEnable").disabled');
    server.driverFixture.ackDelay=1000;await button(4,true);await until('boatMonitor.driver.pending');
    await button(4,false);await until('!boatMonitor.driver.gamepad.sample.lb');await button(4,true);await until('!boatMonitor.driver.pending');
    assert.match(await evaluate('boatMonitor.driver.stopReason'),/LB.*取消/);
    await button(4,false);await wait(1050);assert.equal(await evaluate('boatMonitor.driver.active'),false,'A cancelled acquire cannot reactivate later');
    if(lbOnly)return;
    await evaluate('document.getElementById("driverInputSource").value="gamepad";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));document.getElementById("driverGamepadDeadzone").value="20";document.getElementById("driverGamepadDeadzone").dispatchEvent(new Event("change"));void 0');
    for(const [width,height]of [[1440,900],[375,812],[320,667]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});
      await evaluate('document.getElementById("driverControlOptions").open=true;document.querySelector(".driver-control-options-panel").scrollTop=0');await wait(120);
      for(const theme of ['dark','light']){
        await evaluate('document.documentElement.dataset.theme==="'+theme+'"||document.getElementById("themeToggle").click()');
        const fits=await evaluate('(()=>{const e=document.querySelector(".driver-control-options-panel"),r=e.getBoundingClientRect();return {fits:e.scrollWidth<=e.clientWidth&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};})()');
        assert.equal(fits.fits,true,width+' '+theme+': '+JSON.stringify(fits));
        assert.equal(await evaluate('(()=>{const e=document.getElementById("driverInputSource"),r=e.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e;})()'),true,'Input selector is above map/video/mission layers');
        await click('driverGamepadRefresh');await viewportShot('gamepad-options-'+width+'-'+theme);
      }
    }
    await send('Page.reload');await until('window.boatMonitor?.driver?.gamepad&&BoatAuth.ready');
    assert.equal(await evaluate('boatMonitor.driver.gamepad.source'),'keyboard','Reload always requires selecting the controller again');
    assert.equal(await evaluate('boatMonitor.driver.gamepad.deadzone'),.2,'Deadzone preference persists separately from layouts');
    await evaluate('void BoatAuth.logout()');await until('!BoatAuth.user');await login(browser,'observer','browser-guest-test-only');
    assert.equal(await evaluate('document.getElementById("driverInputSource").disabled'),true,'Guests cannot select a driving input');
  });}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  console.log(dpadOnly?'PASS: actual Chrome D-pad panning on four rotated main maps; A restores follow/recenters once, remains on with repeated presses and takes priority over D-pad; Y swap, video/form exclusion and no vessel commands.':lbOnly?'PASS: actual Chrome/HTTP LB acquire, vessel ACK, long hold, RB motion, zero-input release and pending cancellation with simulated Xbox.':'PASS: actual Chrome/HTTP driver path with simulated Xbox; LB acquire/release/hold/pending cancellation, neutral acquire, proportional axes/deadzone/limits, keyboard exclusion, RB release, B stop, Y edge, disconnect/reconnect, heading control, source switch, real-PWM test scene, 320/375/1440 dark/light options, reload and guest restrictions.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
