/* 真实 Chrome：地图点选/编辑/服务器保存/任务运行/关页续航/管理员停止与窄屏布局。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {createMissionFixture,ORIGIN}=require('./mission-fixture.cjs'),N=require('../public/utils/missionNavigation'),{MissionStore}=require('../server/mission-store');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  const f=createMissionFixture({server:true,realClock:true}),server=f.server;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const output=path.resolve(__dirname,'../.test-output'),profile=fs.mkdtempSync(path.join(output,'chrome-missions-')),errors=[];
  const browser=spawn(process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'google-chrome'),['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const file=path.join(profile,'DevToolsActivePort');for(let n=0;n<100&&!fs.existsSync(file)&&!errors.length;n++)await wait(100);
    if(!fs.existsSync(file))throw Error(errors.join('\n')||'Chrome did not start');
    const port=fs.readFileSync(file,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    socket.onmessage=event=>{const v=JSON.parse(event.data);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.exception?.description||v.params.exceptionDetails.text);const p=pending.get(v.id);if(p){pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(v.exceptionDetails)throw Error(v.exceptionDetails.exception?.description||v.exceptionDetails.text);return v.result.value;};
    const until=async expression=>{for(let n=0;n<140;n++){if(await evaluate(expression))return;await wait(50);}throw Error('Condition timed out: '+expression+'\n'+errors.join('\n')+'\n'+await evaluate('document.getElementById("missionNotice")?.textContent'));};
    const shot=async name=>{const v=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(v.data,'base64'));};
    const clickPoint=async p=>{
      const target=await evaluate('(()=>{const view=BoatMissions.map,point=view.map.latLngToContainerPoint(['+p.latitude+','+p.longitude+']),r=document.getElementById("missionMap").getBoundingClientRect();return {x:r.left+point.x,y:r.top+point.y};})()');
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...target,button:'left',clickCount:1});
    };
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:base+'/#missions'});await until('window.boatMonitor&&BoatAuth.ready&&window.BoatMissions?.map?.ready');
    await evaluate('BoatAuth.login("operator","browser-admin-test-only")');await until('BoatMissions.deviceId==="boat-01"');
    assert.equal(f.commands().length,0,'Entering planning never acquires or moves a boat');
    await evaluate('document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.map.setView('+JSON.stringify(ORIGIN)+',18,{animate:false});document.getElementById("missionEdit").click()');await wait(150);
    for(const p of [ORIGIN,N.destination(ORIGIN,0,30),N.destination(ORIGIN,90,45)])await clickPoint(p);
    assert.equal(await evaluate('BoatMissions.route.points.length'),3);assert.equal(await evaluate('BoatMissions.map.lastTrackLines[0].points.length'),3);
    assert.equal(await evaluate('(()=>{const svg=document.querySelector("#missionMap .leaflet-overlay-pane>svg"),r=svg.getBoundingClientRect(),m=document.getElementById("missionMap").getBoundingClientRect();return r.width>=m.width&&r.height>=m.height;})()'),true,'The actual route SVG fills the map instead of inheriting icon dimensions');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".mission-point-label")].map(n=>n.textContent.split(" · ")[1])'),['开始点','中间点','结束点']);
    assert.equal(await evaluate('document.getElementById("missionStart").disabled'),true,'Unsaved route cannot execute');
    await clickPoint(ORIGIN);assert.equal(await evaluate('BoatMissions.route.points.length'),3,'Marker click never bubbles into adding a duplicate waypoint');
    await evaluate('document.getElementById("missionName").value="湖区巡检 A";document.getElementById("missionName").dispatchEvent(new Event("input"));document.getElementById("missionSave").click()');
    await until('BoatMissions.route.id&&!BoatMissions.busy&&!BoatMissions.dirty');
    assert.equal(new MissionStore({env:f.env}).list('boat-01').length,1);const routeId=await evaluate('BoatMissions.route.id');
    await evaluate('document.getElementById("missionNew").click()');await wait(1200);assert.equal(await evaluate('BoatMissions.route.points.length===0&&!BoatMissions.route.id'),true,'Background polling preserves an explicitly created blank draft');
    await evaluate('document.getElementById("missionRouteSelect").value="'+routeId+'";document.getElementById("missionRouteSelect").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('BoatMissions.route.points.length'),3,'Saved route reloads all ordered waypoints');
    await evaluate('window.scrollTo(0,0)');await shot('missions-desktop-dark');
    await evaluate('document.getElementById("missionGoto").click()');await until('BoatMissions.run()?.status==="completed"');assert.equal(f.mission.snapshot('boat-01').stopConfirmed,true);
    await evaluate('document.getElementById("missionStart").click()');await until('BoatMissions.run()?.status==="running"');const before=f.commands().length;
    await send('Page.navigate',{url:'about:blank'});await wait(1100);assert.equal(f.mission.active('boat-01'),true,'Task runs without any browser page');assert.ok(f.commands().length>before+5,'Server calculates and publishes navigation after the page is closed');
    await send('Page.navigate',{url:base+'/#missions'});await until('window.BoatMissions?.run()?.status==="running"');assert.equal(await evaluate('document.getElementById("missionActiveBar").hidden'),false);
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');assert.equal(await evaluate('document.getElementById("driverMissionStop").hidden'),false,'Driving station retains a mission stop entry');
    await evaluate('document.activeElement?.blur()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await until('!BoatMissions.run()?.active');assert.equal(f.mission.snapshot('boat-01').status,'stopped');
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("themeToggle").click()');
    for(const [width,height]of [[1440,1100],[1024,900],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(100);
      await evaluate('BoatMissions.map.invalidateSize();BoatMissions.fit()');await wait(120);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'No horizontal overflow at '+width);
      assert.equal(await evaluate('document.getElementById("missionMap").getBoundingClientRect().height>=300'),true);
      await evaluate('document.getElementById("view-missions").scrollIntoView({block:"start",behavior:"instant"})');await shot('missions-'+width+'-light');
    }
    await evaluate('BoatAuth.logout();');await evaluate('BoatAuth.login("observer","browser-guest-test-only")');await until('BoatMissions.routes.length===1');
    assert.equal(await evaluate('document.getElementById("missionSave").disabled&&document.getElementById("missionStart").disabled&&document.getElementById("missionEdit").disabled'),true,'Guest can browse but cannot edit or execute');
    assert.deepEqual(errors,[]);console.log('PASS: mission planner in real Chrome; actual map clicks and connected ordered waypoints; server persistence/reload; goto; hardware ACK and task progress; page closure/reopen; driving Space stop; guest permissions; dark/light and 1440/1024/375/320 px layouts.');
  }finally{socket?.close();browser.kill();server.closeAllConnections?.();await f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
