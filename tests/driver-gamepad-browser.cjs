/* 真实 Chrome 与本机 HTTP 接管链路；只替换浏览器的 Gamepad 设备读数。 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {browserSession,login,startTelemetry}=require('./amap-browser.cjs');
const {createDriverFixture}=require('./driver-browser-fixture.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gamepadScript=`window.gamepadTest={pads:[{index:0,id:'Xbox Wireless Controller · browser test',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0})),timestamp:0}]};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>gamepadTest.pads});window.setPadButton=(index,value)=>{gamepadTest.pads[0].buttons[index]={pressed:value,value:Number(value)};};`;
async function main(){
  const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
  const directory=fs.mkdtempSync(path.join(output,'gamepad-state-'));
  const server=createDriverFixture({env:{BOAT_ACCOUNTS_FILE:path.join(directory,'accounts.json'),BOAT_MAP_CONFIG_FILE:path.join(directory,'map.json'),BOAT_DRIVER_LAYOUT_FILE:path.join(directory,'driver-layout.json'),BOAT_TELEMETRY_HISTORY_FILE:path.join(directory,'history.json'),BOAT_OTA_KEY:''}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await browserSession(server,'gamepad',async browser=>{
    const {evaluate,until,send,viewportShot}=browser;
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
    await evaluate('document.getElementById("driverInputSource").value="gamepad";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));document.getElementById("driverTestMode").click();void 0');
    await until('boatMonitor.driver.testMode');await enable();await engage();await axes(-1,0);
    await until('boatMonitor.driver.inputs().throttle===200');await wait(120);
    assert.ok(server.driverFixture.calls.some(call=>call.action==='input'&&call.testMode===true&&call.mode===0&&call.throttle===200),'Controller preserves the existing real-PWM test scene');
    await button(1,true);await until('!boatMonitor.driver.active');await button(1,false);await button(5,false);await axes(0,0);
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
  console.log('PASS: actual Chrome/HTTP driver path with simulated Xbox; neutral acquire, proportional axes/deadzone/limits, keyboard exclusion, RB release, B stop, Y edge, disconnect/reconnect, heading control, source switch, real-PWM test scene, 320/375/1440 dark/light options, reload and guest restrictions.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
