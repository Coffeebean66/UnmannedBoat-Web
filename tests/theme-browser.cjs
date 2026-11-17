/* 真实Chrome检查颜色插值、连点收尾、减弱动态，以及驾驶时输入/遥测持续工作。 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {browserSession,startTelemetry}=require('./amap-browser.cjs');
const {createDriverFixture}=require('./driver-browser-fixture.cjs');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'theme-state-'));
  const server=createDriverFixture({env:{STATE_DIRECTORY:run,BOAT_ACCOUNTS_FILE:path.join(run,'accounts.json')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await browserSession(server,'theme',async browser=>{
    const {evaluate,until,send,viewportShot}=browser;
    await until('window.BoatUI&&window.BoatThemeTransition&&window.BoatAuth?.ready&&!window.BoatStartup?.active');
    assert.equal(await evaluate('document.documentElement.dataset.theme'),'dark');
    assert.equal(await evaluate('document.documentElement.hasAttribute("data-theme-transition")'),false,'Restore does not animate');
    await evaluate('boatMonitor.viewer.configure("animation",false);void 0');
    await startTelemetry(browser);
    await evaluate('window.themeEvents=[];window.themeMap=boatMonitor.map;window.themeViewer=boatMonitor.viewer;window.themeVideo=document.getElementById("boatVideo");window.addEventListener("boat-theme-change",()=>themeEvents.push({theme:document.documentElement.dataset.theme,chart:getComputedStyle(document.documentElement).getPropertyValue("--chart-bg").trim()}))');
    const before=await evaluate('getComputedStyle(document.body).backgroundColor');
    const middle=await evaluate('(()=>{document.getElementById("themeToggle").click();const a=document.getAnimations().find(a=>a.id==="boat-theme-palette");if(!a)return null;a.pause();a.currentTime=150;return {color:getComputedStyle(document.body).backgroundColor,phase:document.documentElement.dataset.themeTransition,theme:document.documentElement.dataset.theme,event:themeEvents.at(-1),count:document.getAnimations().filter(a=>a.id.startsWith("boat-theme-")).length};})()');
    assert.ok(middle,'Native color animation starts from a real button click');
    assert.equal(middle.theme,'light');assert.equal(middle.phase,'active');assert.notEqual(middle.color,before);
    assert.notEqual(middle.color,'rgb(250, 251, 252)','Intermediate frame is a blended palette');
    const sequence=await evaluate('Number(document.getElementById("motor1Sequence").textContent)');
    await wait(220);
    assert.ok(await evaluate('Number(document.getElementById("motor1Sequence").textContent)')>sequence,'Telemetry continues while colors animate');
    await viewportShot('theme-dark-to-light-middle');
    await evaluate('document.getAnimations().find(a=>a.id==="boat-theme-palette").play()');
    await until('!document.documentElement.hasAttribute("data-theme-transition")');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(250, 251, 252)');
    assert.equal(middle.event.chart,await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--chart-bg").trim()'),'Canvas listeners receive the final palette');
    assert.equal(await evaluate('localStorage.getItem("boat_web_theme_v1")'),'light');
    assert.equal(await evaluate('document.getElementById("driverThemeToggle").title'),'切换到深色主题');
    await viewportShot('theme-light-complete');
    await evaluate('for(let i=0;i<7;i++)document.getElementById("themeToggle").click()');
    await until('!document.documentElement.hasAttribute("data-theme-transition")');
    assert.equal(await evaluate('document.documentElement.dataset.theme'),'dark');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),before);
    assert.equal(await evaluate('document.getAnimations().filter(a=>a.id.startsWith("boat-theme-")).length'),0);
    assert.equal(await evaluate('themeEvents.length'),8,'Each click sends only one theme event');
    assert.equal(await evaluate('themeMap===boatMonitor.map&&themeViewer===boatMonitor.viewer&&themeVideo===document.getElementById("boatVideo")'),true,'Map, video and renderer retain their instances');

    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await evaluate('document.getElementById("themeToggle").click()');
    assert.equal(await evaluate('document.documentElement.hasAttribute("data-theme-transition")'),false);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(250, 251, 252)');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await evaluate('document.getElementById("themeToggle").click()');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await until('!document.documentElement.hasAttribute("data-theme-transition")');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),before,'Changing motion preference finishes at the requested theme');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await send('Page.reload');
    await until('window.boatMonitor&&window.BoatAuth?.ready&&!window.BoatStartup?.active');
    assert.equal(await evaluate('document.documentElement.dataset.theme'),'dark');
    assert.equal(await evaluate('document.documentElement.hasAttribute("data-theme-transition")'),false);
    await evaluate('boatMonitor.viewer.configure("animation",false);void 0');
    await startTelemetry(browser);

    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');
    await until('!document.getElementById("driverEnable").disabled');
    await evaluate('document.getElementById("driverEnable").click()');await until('boatMonitor.driver.active');
    const lease=server.driverFixture.leaseId;
    const point=await evaluate('(()=>{const r=document.getElementById("driverThemeToggle").getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.closest("button")?.id};})()');
    assert.equal(point.hit,'driverThemeToggle','Driver theme button is reachable: '+JSON.stringify(point));
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:point.x,y:point.y});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x,y:point.y});
    assert.equal(await evaluate('document.documentElement.dataset.theme'),'light','Driver proxy toggles the same theme');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
    await until('boatMonitor.driver.inputs().throttle===200');
    await wait(150);
    assert.ok(server.driverFixture.calls.some(call=>call.action==='input'&&call.throttle===200));
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
    await until('!document.documentElement.hasAttribute("data-theme-transition")');
    assert.equal(await evaluate('boatMonitor.driver.active'),true,'Theme switching preserves active control');
    assert.equal(server.driverFixture.leaseId,lease);
    assert.equal(await evaluate('document.documentElement.dataset.theme'),'light');
    assert.equal(await evaluate('document.getElementById("driverThemeToggle").title'),'切换到深色主题');
    await evaluate('boatMonitor.driver.stop("主题动画检查结束")');await until('!boatMonitor.driver.active');
    for(const width of [375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:false});
      await evaluate('document.getElementById("driverThemeToggle").click()');
      await until('!document.documentElement.hasAttribute("data-theme-transition")');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      await viewportShot('theme-driver-'+width);
    }
    console.log('Theme animation passed: interpolated colors, final Canvas palette, live telemetry, rapid toggles, reduced-motion changes, persistence, driver button/key input/lease continuity, retained media/map/renderer and 320/375px layouts.');
  });}finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
