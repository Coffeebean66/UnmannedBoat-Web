/* 真实 Chrome：地图点选/编辑/服务器保存/任务运行/关页续航/管理员停止与窄屏布局。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {createMissionFixture,ORIGIN}=require('./mission-fixture.cjs'),N=require('../public/utils/missionNavigation'),{MissionStore}=require('../server/mission-store');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  const f=createMissionFixture({server:true,realClock:true,algorithmControl:true}),server=f.server;
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
    const dragPin=async(selector,dx,dy,{touch=false,cancel=false,beforeDrop}={})=>{
      const start=await evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      if(touch)await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
      else{await send('Input.dispatchMouseEvent',{type:'mouseMoved',...start});await send('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});}
      for(let n=1;n<=8;n++){
        const point={x:start.x+dx*n/8,y:start.y+dy*n/8};
        if(touch)await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point,id:1}]});
        else await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'left',buttons:1});
        await wait(20);
      }
      if(beforeDrop)await beforeDrop();
      if(cancel){await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
      if(touch)await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      else await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x+dx,y:start.y+dy,button:'left',buttons:0,clickCount:1});
      await wait(60);
    };
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:base+'/#missions'});await until('window.boatMonitor&&BoatAuth.ready&&window.BoatMissions');
    assert.equal(await evaluate('document.getElementById("view-missions").hidden'),true,'Task interface stays hidden before authentication');
    await evaluate('BoatAuth.login("operator","browser-admin-test-only")');await until('BoatMissions.deviceId==="boat-01"&&BoatMissions.map?.ready&&BoatWorkspace.current==="missions"');
    assert.equal(f.commands().length,0,'Entering planning never acquires or moves a boat');
    if(!process.argv.includes('--recording-only')){
    await until('boatMonitor.link.connected&&boatMonitor.link.devices[0]?.controlAlgorithm?.id===0');
    await evaluate('boatMonitor.openBoatSettings("boat-01")');
    await until('document.getElementById("settingsDialog").open&&!document.getElementById("applyControlAlgorithm").disabled');
    assert.equal(await evaluate('document.getElementById("controlAlgorithmSelect").value'),'0','Boot state uses original PID');
    await evaluate('document.getElementById("controlAlgorithmSelect").value="1";document.getElementById("applyControlAlgorithm").click()');
    await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").dataset.tone==="success"');
    assert.equal(f.algorithms.get('boat-01'),1);assert.match(await evaluate('document.getElementById("controlAlgorithmCurrent").textContent'),/最优控制/);
    f.algorithmStatus=3;
    await until('!document.getElementById("applyControlAlgorithm").disabled');
    await evaluate('document.getElementById("controlAlgorithmSelect").value="0";document.getElementById("applyControlAlgorithm").click()');
    await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").dataset.tone==="danger"');
    assert.equal(f.algorithms.get('boat-01'),1,'An MCU stopped-state rejection cannot pretend PID was selected');f.algorithmStatus=0;
    for(const [width,height]of [[1440,1100],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(100);
      assert.equal(await evaluate('(()=>{const d=document.getElementById("settingsDialog");return d.scrollWidth<=d.clientWidth+1&&d.querySelector(".dialog-scroll").scrollWidth<=d.querySelector(".dialog-scroll").clientWidth+1;})()'),true,'Algorithm settings fit '+width);
      await shot('algorithm-settings-'+width);
    }
    await evaluate('document.getElementById("settingsClose").click()');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.map.setView('+JSON.stringify(ORIGIN)+',18,{animate:false});document.getElementById("missionEdit").click()');await wait(150);
    for(const p of [ORIGIN,N.destination(ORIGIN,0,30),N.destination(ORIGIN,90,45)])await clickPoint(p);
    assert.equal(await evaluate('BoatMissions.route.points.length'),3);assert.equal(await evaluate('BoatMissions.map.lastTrackLines[0].points.length'),3);
    assert.equal(await evaluate('(()=>{const svg=document.querySelector("#missionMap .leaflet-overlay-pane>svg"),r=svg.getBoundingClientRect(),m=document.getElementById("missionMap").getBoundingClientRect();return r.width>=m.width&&r.height>=m.height;})()'),true,'The actual route SVG fills the map instead of inheriting icon dimensions');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".mission-point-label")].map(n=>n.textContent.split(" · ")[1])'),['开始点','中间点','结束点']);
    assert.equal(await evaluate('document.getElementById("missionStart").disabled'),true,'Unsaved route cannot execute');
    await clickPoint(ORIGIN);assert.equal(await evaluate('BoatMissions.route.points.length'),3,'Marker click never bubbles into adding a duplicate waypoint');
    assert.equal(await evaluate('document.getElementById("missionLoopCount").disabled'),true,'New routes keep the original single-run default');
    await evaluate('document.getElementById("missionLoopEnabled").click();document.getElementById("missionLoopCount").value="0";document.getElementById("missionLoopCount").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.getElementById("missionSave").disabled'),true,'Zero loops cannot be saved');
    await evaluate('document.getElementById("missionLoopCount").value="2";document.getElementById("missionLoopCount").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('!document.getElementById("missionLoopLegend").hidden&&BoatMissions.map.lastTrackLines.length===2'),true,'Loop map visibly includes a separate end-to-start leg');
    assert.deepEqual(await evaluate('BoatMissions.map.lastTrackLines[1].points'),await evaluate('[BoatMissions.route.points.at(-1),BoatMissions.route.points[0]]'));
    await evaluate('document.getElementById("missionName").value="湖区巡检 A";document.getElementById("missionName").dispatchEvent(new Event("input"));document.getElementById("missionSave").click()');
    await until('BoatMissions.route.id&&!BoatMissions.busy&&!BoatMissions.dirty');
    assert.equal(new MissionStore({env:f.env}).list('boat-01').length,1);const routeId=await evaluate('BoatMissions.route.id'),savedRoute=new MissionStore({env:f.env}).get('boat-01',routeId);
    assert.equal(savedRoute.loopEnabled,true);assert.equal(savedRoute.loopCount,2,'Loop count persists through real HTTP and storage reload');
    const editorLines=await evaluate('BoatMissions.map.lastTrackLines'),planningCommands=f.commands().length;
    await evaluate('document.getElementById("missionWaypointsToggle").click()');
    assert.equal(await evaluate('BoatMissions.markers.length===0&&!BoatMissions.editing&&BoatMissions.curveEditing===-1&&!BoatMissions.dirty&&!!BoatMissions.boatMarker'),true,'Hide points without changing a saved route or hiding the live boat');
    assert.deepEqual(await evaluate('BoatMissions.map.lastTrackLines'),editorLines,'Both the task path and loop return remain visible');
    await clickPoint(N.destination(ORIGIN,90,15));assert.deepEqual(await evaluate('BoatMissions.route.points'),savedRoute.points,'Hidden points cannot be edited by an empty-map click');
    assert.equal(await evaluate('[...document.querySelectorAll("[data-mission-point-legend]")].every(n=>getComputedStyle(n).display==="none")'),true);
    await shot('missions-waypoints-hidden');
    await evaluate('document.getElementById("missionWaypointsToggle").click()');assert.equal(await evaluate('BoatMissions.markers.length'),3);
    await evaluate('document.getElementById("missionWaypointsToggle").click();document.getElementById("missionEdit").click()');
    assert.equal(await evaluate('BoatMissions.pointsVisible&&BoatMissions.editing&&BoatMissions.markers.length===3&&!BoatMissions.dirty'),true,'Starting point selection restores visible points automatically');
    assert.equal(f.commands().length,planningCommands,'Visibility never acquires or controls the boat');
    await evaluate('document.getElementById("missionNew").click()');await wait(1200);assert.equal(await evaluate('BoatMissions.route.points.length===0&&!BoatMissions.route.id&&!document.getElementById("missionLoopEnabled").checked&&document.getElementById("missionLoopCount").disabled'),true,'Background polling preserves an explicitly created blank single-run draft');
    await evaluate('document.getElementById("missionRouteSelect").value="'+routeId+'";document.getElementById("missionRouteSelect").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('BoatMissions.route.points.length'),3,'Saved route reloads all ordered waypoints');
    assert.equal(await evaluate('document.getElementById("missionLoopEnabled").checked&&document.getElementById("missionLoopCount").value==="2"'),true,'Loading a route restores its loop settings');
    await evaluate('window.scrollTo(0,0)');await shot('missions-desktop-dark');
    await evaluate('document.getElementById("missionGoto").click()');await until('BoatMissions.run()?.status==="completed"');assert.equal(f.mission.snapshot('boat-01').stopConfirmed,true);
    await evaluate('document.getElementById("missionStart").click()');await until('BoatMissions.run()?.status==="running"');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');
    await until('document.getElementById("driverMissionState").dataset.status==="running"');
    assert.equal(await evaluate('document.getElementById("driverMissionName").textContent'),'湖区巡检 A','Driving summarizes the current vessel server mission');
    assert.equal(await evaluate('document.getElementById("driverMissionProgress").textContent===(BoatMissions.run().targetIndex+1)+" / "+BoatMissions.run().pointCount'),true);
    assert.equal(await evaluate('document.getElementById("driverMissionLoop").textContent'),'1 / 2 圈');
    const immersiveLease=f.mission.jobs.get('boat-01').leaseId;
    await until('boatMonitor.mapMission.markers.length===3');
    await evaluate('document.getElementById("driverMapOptions").open=true;document.getElementById("driverMissionPointsToggle").click()');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&boatMonitor.map._lineOverlays.get("mission").lines.length===2&&document.getElementById("mapMissionPointsToggle").getAttribute("aria-pressed")==="false"'),true,'Driving waypoint control preserves the live route and synchronizes navigation');
    assert.equal(f.mission.jobs.get('boat-01').leaseId,immersiveLease);
    await shot('driver-mission-waypoints-hidden');
    await evaluate('document.getElementById("driverMissionPointsToggle").click();document.getElementById("driverMapOptions").open=false');
    for(const [width,height]of [[1440,900],[375,667],[320,667],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
      await evaluate('boatMonitor.driver.setMediaFocus("video")');await wait(120);
      const summary=await evaluate('(()=>{const box=document.querySelector(".driver-mission-summary").getBoundingClientRect(),strip=document.querySelector(".driver-navigation-data").getBoundingClientRect();return {inside:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=strip.top-3,values:["driverMissionState","driverMissionProgress","driverMissionDistance"].map(id=>{const node=document.getElementById(id),r=node.getBoundingClientRect();return {text:node.textContent,visible:r.width>0&&r.height>0,font:parseFloat(getComputedStyle(node).fontSize)};}),takeover:document.getElementById("driverTakeoverStatus").textContent};})()');
      assert.equal(summary.inside,true,'Compact navigation summary stays above the instruments at '+width+': '+JSON.stringify(summary));
      assert.equal(summary.values.every(value=>value.visible&&value.text!=='--'&&value.font>=9),true,'Real target point, distance and task status remain readable in the inset layout');
      assert.equal(summary.takeover,'服务器已接管');assert.equal(f.mission.jobs.get('boat-01').leaseId,immersiveLease);
      const taskButtons=await evaluate('["driverGoto","driverNavStart","driverNavPause","driverNavResume","driverNavSave"].map(id=>{const node=document.getElementById(id),r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {id,visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,clear:node===hit||node.contains(hit)};})');
      assert.ok(taskButtons.every(button=>button.visible&&button.clear),'Navigation actions remain visible and unobstructed by emergency stop at '+width+'x'+height+': '+JSON.stringify(taskButtons));
      await shot('driver-mission-immersive-'+width);
      await evaluate('document.getElementById("driverImmersiveToggle").click()');
      assert.equal(await evaluate('BoatWorkspace.current'),'missions','Return restores the mission page without stopping server execution');
      await evaluate('BoatWorkspace.navigate("driving",{focus:false})');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await wait(100);
    const staleMission=await evaluate('(()=>{BoatMissions.statusError="同步失败";BoatMissions.render();const state=document.getElementById("driverMissionState").textContent;BoatMissions.statusError="";BoatMissions.render();return state;})()');
    assert.equal(staleMission,'状态过期','A failed mission status query is never shown as current');
    assert.equal(f.mission.snapshot('boat-01').algorithm,1);assert.ok(f.mission.jobs.get('boat-01').optimal);
    assert.match(await evaluate('document.getElementById("missionAlgorithm").textContent'),/最优控制/);
    await evaluate('BoatWorkspace.navigate("navigation",{focus:false});document.getElementById("mapFollow").checked=false');
    await until('boatMonitor.mapMission.markers.length===3&&document.getElementById("mapMissionInfo").dataset.visible==="true"');
    assert.equal(await evaluate('boatMonitor.map._lineOverlays.get("mission").lines.length'),2,'Navigation shows the active route and its loop return leg');
    assert.deepEqual(await evaluate('boatMonitor.map._lineOverlays.get("mission").lines[0].points'),savedRoute.points);
    await evaluate('BoatMissions.load("")');
    assert.equal(await evaluate('BoatMissions.route.points.length'),0);
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),3,'Editing another route never replaces the currently running route overlay');
    await evaluate('document.getElementById("mapMissionPointsToggle").click()');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),0);
    assert.deepEqual(await evaluate('boatMonitor.map._lineOverlays.get("mission").lines[0].points'),savedRoute.points,'Navigation retains the same path without numbered markers');
    await evaluate('BoatMissions.load('+JSON.stringify(routeId)+');document.getElementById("missionWaypointsToggle").click();document.getElementById("mapMissionToggle").click()');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&!boatMonitor.map._lineOverlays.has("mission")'),true);
    assert.equal(f.mission.active('boat-01'),true,'Hiding the route never stops the mission');
    await send('Page.reload');
    await until('window.boatMonitor?.mapMission&&window.BoatMissions?.run()?.status==="running"&&BoatMissions.routes.length>0&&boatMonitor.map.ready');
    assert.equal(await evaluate('BoatWorkspace.current'), 'navigation');
    assert.equal(await evaluate('boatMonitor.mapMission.visible'),false,'Refresh preserves the hidden preference');
    assert.equal(await evaluate('boatMonitor.mapMission.pointsVisible===false&&BoatMissions.pointsVisible===false'),true,'Refresh independently restores both editor and monitoring waypoint preferences');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),0);
    await evaluate('document.getElementById("mapMissionToggle").click();document.getElementById("mapFollow").checked=false');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&boatMonitor.map._lineOverlays.get("mission").lines.length===2'),true,'Restoring the whole route respects the independent hidden-points preference');
    await evaluate('BoatWorkspace.navigate("missions",{focus:false})');await until('BoatMissions.map?.ready&&BoatMissions.route.id==="'+routeId+'"');
    assert.equal(await evaluate('BoatMissions.markers.length===0&&BoatMissions.map.lastTrackLines.length===2&&document.getElementById("missionEdit").disabled&&!document.getElementById("missionWaypointsToggle").disabled'),true,'Visibility remains adjustable on a locked executing route');
    await evaluate('document.getElementById("missionWaypointsToggle").click();BoatWorkspace.navigate("navigation",{focus:false});document.getElementById("mapMissionPointsToggle").click()');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),3);
    await evaluate('boatMonitor.map.switchMode("satellite")');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),3,'Satellite switching restores route markers');
    assert.deepEqual(await evaluate('boatMonitor.map._lineOverlays.get("mission").lines[0].points'),savedRoute.points);
    await evaluate('boatMonitor.map.switchProvider("osm")');
    f.feed('boat-02');
    await evaluate('boatMonitor.selectBoat("boat-02",false)');await until('BoatMissions.deviceId==="boat-02"');
    assert.equal(await evaluate('document.getElementById("driverMissionName").textContent'),'暂无运行中的任务','Selecting a different boat clears the driving mission summary');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),0,'Another vessel never inherits the original mission route');
    assert.equal(f.mission.active('boat-01'),true);
    await evaluate('boatMonitor.selectBoat("boat-01",false)');await until('boatMonitor.mapMission.markers.length===3');
    for(const [width,height]of [[1440,1100],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate('boatMonitor.map.fitLocations(BoatMissions.routes.find(r=>r.id===BoatMissions.run().routeId).points,{maxZoom:18,padding:[35,35]});document.getElementById("navigation").scrollIntoView({block:"start",behavior:"instant"})');await wait(150);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'Navigation route controls fit '+width);
      await shot('navigation-mission-'+width+'-dark');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    const before=f.commands().length;
    await send('Page.navigate',{url:'about:blank'});await wait(1100);assert.equal(f.mission.active('boat-01'),true,'Task runs without any browser page');assert.ok(f.commands().length>before+5,'Server calculates and publishes navigation after the page is closed');
    await send('Page.navigate',{url:base+'/#missions'});await until('window.BoatMissions?.run()?.status==="running"');assert.equal(await evaluate('document.getElementById("missionActiveBar").hidden'),false);
    await evaluate('BoatAuth.logout()');
    assert.equal(await evaluate('BoatWorkspace.current==="fleet"&&document.getElementById("view-missions").hidden&&document.getElementById("missionActiveBar").hidden'),true,'Logging out immediately hides the active task interface');
    await evaluate('BoatAuth.login("observer","browser-guest-test-only")');await until('BoatAuth.user?.role==="guest"');
    await evaluate('BoatMissions.poll(true)');
    assert.equal(await evaluate('BoatMissions.routes.length===0&&BoatMissions.runs.length===0&&document.getElementById("missionActiveBar").children.length===0'),true,'Guest never retains task details or the global task entry');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&!boatMonitor.map._lineOverlays.has("mission")&&document.getElementById("mapMissionToggle").hidden&&document.getElementById("mapMissionPointsToggle").hidden&&document.getElementById("driverMissionPointsToggle").hidden&&document.getElementById("mapMissionInfo").hidden'),true,'Guest cannot retain the private mission overlay');
    for(const view of ['missions','driving'])assert.equal(await evaluate('BoatWorkspace.navigate('+JSON.stringify(view)+')'),'fleet');
    assert.equal(f.mission.active('boat-01'),true,'Hiding the interface and switching accounts do not stop a server task');
    await evaluate('BoatAuth.logout()');await evaluate('BoatAuth.login("operator","browser-admin-test-only")');
    await until('BoatMissions.run()?.status==="running"');
    assert.equal(await evaluate('document.getElementById("missionActiveBar").hidden'),false,'Administrator can see the running task again after login');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');assert.equal(await evaluate('document.getElementById("driverMissionStop").hidden'),false,'Driving station retains a mission stop entry');
    await evaluate('document.activeElement?.blur()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await until('!BoatMissions.run()?.active');assert.equal(f.mission.snapshot('boat-01').status,'stopped');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&!boatMonitor.map._lineOverlays.has("mission")'),true,'Stopping removes the navigation task route');
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("missionStart").click()');
    await until('BoatMissions.run()?.status==="running"&&BoatMissions.run()?.targetIndex===1');
    assert.equal(await evaluate('document.getElementById("missionLoopEnabled").disabled&&document.getElementById("missionLoopCount").disabled'),true,'An executing route cannot change its loop count');
    for(let lap=1;lap<=2;lap++){
      for(let index=1;index<savedRoute.points.length;index++){
        const target=savedRoute.points[index],previous=f.positions.get('boat-01');f.feed('boat-01',{...target,heading:N.bearing(previous,target)});
        await until(index===savedRoute.points.length-1?'BoatMissions.run()?.phase==="returning"&&BoatMissions.run()?.currentLoop==='+lap:'BoatMissions.run()?.phase==="route"&&BoatMissions.run()?.targetIndex==='+(index+1));
      }
      assert.equal(await evaluate('document.getElementById("missionPhase").textContent'),'返回起点');
      assert.equal(await evaluate('document.getElementById("missionLoopProgress").textContent'),lap+' / 2 圈');
      if(lap===1){
        await send('Page.reload');await until('window.BoatMissions?.run()?.phase==="returning"&&BoatMissions.run()?.currentLoop===1&&BoatMissions.map?.ready');
        assert.equal(await evaluate('document.getElementById("missionLoopCount").value'), '2','Refreshing during return preserves the configured and running loops');
        assert.equal(f.mission.active('boat-01'),true);
      }
      f.feed('boat-01',{...savedRoute.points[0],heading:N.bearing(savedRoute.points.at(-1),savedRoute.points[0])});
      await until(lap<2?'BoatMissions.run()?.phase==="route"&&BoatMissions.run()?.currentLoop===2&&BoatMissions.run()?.completedLoops===1':'BoatMissions.run()?.status==="completed"&&BoatMissions.run()?.stopConfirmed');
    }
    assert.equal(f.mission.snapshot('boat-01').completedLoops,2);assert.equal(await evaluate('document.getElementById("missionPhase").textContent'),'已完成');
    assert.equal(await evaluate('document.getElementById("missionLoopProgress").title'),'已完成 2 圈');
    assert.equal(await evaluate('document.getElementById("missionActiveBar").hidden'),true,'Final return completes the task and removes the active task banner');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&!boatMonitor.map._lineOverlays.has("mission")'),true,'Completion removes the navigation task route');
    await evaluate('boatMonitor.openBoatSettings("boat-01")');await until('!document.getElementById("applyControlAlgorithm").disabled');
    await evaluate('document.getElementById("controlAlgorithmSelect").value="0";document.getElementById("applyControlAlgorithm").click()');
    await until('!boatMonitor.params.busy&&document.getElementById("parameterStatus").dataset.tone==="success"');
    assert.equal(f.algorithms.get('boat-01'),0);await evaluate('document.getElementById("settingsClose").click()');
    await shot('missions-loops-completed');
    // 曲线通过真实地图选弯点并保存，刷新与驾驶页调速后不能悄悄变回直线。
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("missionNew").click();document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.map.setView('+JSON.stringify(ORIGIN)+',18,{animate:false});document.getElementById("missionSegmentType").value="curve";if(!BoatMissions.editing)document.getElementById("missionEdit").click()');await wait(150);
    const curveEnd=N.destination(ORIGIN,0,60),curveControl=N.destination(N.destination(ORIGIN,0,30),90,22);
    await clickPoint(ORIGIN);await clickPoint(curveEnd);
    await evaluate('document.getElementById("missionSegmentType").value="line"');await clickPoint(N.destination(curveEnd,90,40));
    assert.deepEqual(await evaluate('BoatMissions.route.segments.map(s=>s.type)'),['curve','line']);
    assert.ok(await evaluate('BoatMissions.map.lastTrackLines[0].points.length')>3,'Curve preview follows the bend instead of connecting only its anchors');
    await evaluate('document.querySelector("[data-curve-pick]").click();document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"})');await wait(250);
    assert.equal(await evaluate('document.getElementById("missionCurveEdit").hidden'),false);await clickPoint(curveControl);
    assert.equal(await evaluate('BoatMissions.route.points.length'),3,'Choosing a bend never inserts a compulsory waypoint');
    assert.equal(await evaluate('BoatMissions.curveEditing'),-1);
    assert.ok(N.distance(await evaluate('BoatMissions.route.segments[0].control'),curveControl)<1,'Real map clicks store WGS84 control coordinates');
    const curveBeforeHiding=await evaluate('BoatMissions.route'),curveDirty=await evaluate('BoatMissions.dirty');
    assert.equal(await evaluate('BoatMissions.map.lastTrackLines.length'),2,'Curve editing includes its control helper before hiding');
    await evaluate('document.getElementById("missionWaypointsToggle").click()');
    assert.equal(await evaluate('BoatMissions.markers.length===0&&BoatMissions.map.lastTrackLines.length===1&&!document.querySelector("#missionMap .mission-curve-pin")'),true,'Hiding removes curve controls and helpers together with waypoints');
    assert.deepEqual(await evaluate('BoatMissions.route'),curveBeforeHiding);assert.equal(await evaluate('BoatMissions.dirty'),curveDirty);
    for(const width of [1440,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
      await evaluate('document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.fit()');await wait(120);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById("missionWaypointsToggle").getBoundingClientRect().width>0'),true,'Hidden-points route controls fit '+width);
      await shot('missions-curve-waypoints-hidden-'+width);
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('document.querySelector("[data-curve-pick]").click()');
    assert.equal(await evaluate('BoatMissions.pointsVisible&&BoatMissions.editing&&BoatMissions.curveEditing===0&&BoatMissions.markers.length===4'),true,'Selecting a curve bend automatically restores its markers');
    await evaluate('document.getElementById("missionCurveCancel").click()');
    await evaluate('document.getElementById("missionName").value="曲线巡航 B";document.getElementById("missionName").dispatchEvent(new Event("input"));document.getElementById("missionSave").click()');await until('!!BoatMissions.route.id&&!BoatMissions.busy&&!BoatMissions.dirty');
    const curveId=await evaluate('BoatMissions.route.id');let savedCurve=new MissionStore({env:f.env}).get('boat-01',curveId);
    assert.deepEqual(savedCurve.segments,await evaluate('BoatMissions.route.segments'));
    await send('Page.reload');await until('window.BoatMissions?.routes?.some(r=>r.id==="'+curveId+'")&&BoatMissions.map?.ready');
    await evaluate('document.getElementById("missionRouteSelect").value="'+curveId+'";document.getElementById("missionRouteSelect").dispatchEvent(new Event("change"))');
    assert.deepEqual(await evaluate('BoatMissions.route.segments'),savedCurve.segments,'Refreshing restores mixed straight and curved segments');
    await evaluate('BoatMissions.saveNavigationSpeed("'+curveId+'",1.1,3)');assert.deepEqual(new MissionStore({env:f.env}).get('boat-01',curveId).segments,savedCurve.segments,'Driving speed settings preserve curve definitions');
    const adjustedLatitude=Number((savedCurve.segments[0].control.latitude+.00001).toFixed(7));
    await evaluate('(()=>{const input=document.querySelector(".mission-curve-coordinates input");input.value='+JSON.stringify(String(adjustedLatitude))+';input.dispatchEvent(new Event("change"));})()');
    assert.equal(await evaluate('BoatMissions.route.segments[0].control.latitude'),adjustedLatitude,'Coordinates still edit the live route after saving or changing its speed');
    assert.equal(await evaluate('BoatMissions.dirty'),true);await evaluate('document.getElementById("missionSave").click()');await until('!BoatMissions.busy&&!BoatMissions.dirty');savedCurve=new MissionStore({env:f.env}).get('boat-01',curveId);assert.equal(savedCurve.segments[0].control.latitude,adjustedLatitude);
    // 真实鼠标拖动只在松手时改草稿；跨过一轮状态轮询也不能拆除正在拖动的标记。
    await evaluate('document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.fit()');await wait(150);
    const beforeDragging=savedCurve.points,controlBeforeDragging=savedCurve.segments[0].control,commandsBeforeDragging=f.commands().length;
    await dragPin('.mission-pin span[data-kind=via]',12,-8,{beforeDrop:async()=>{
      assert.equal(await evaluate('!!BoatMissions.drag'),true);await evaluate('window.__dragNative=BoatMissions.drag.marker.native;void 0');
      await wait(1150);assert.equal(await evaluate('BoatMissions.drag?.marker.native===window.__dragNative'),true,'Polling retains the actual marker throughout a long drag');
      assert.equal(await evaluate('document.getElementById("missionSave").disabled&&document.getElementById("missionStart").disabled'),true);
      assert.deepEqual(await evaluate('BoatMissions.route.points'),beforeDragging,'Moving previews without modifying the saved draft until release');
      assert.ok(N.distance(await evaluate('BoatMissions.map.lastTrackLines[0].points.at(-2)'),beforeDragging[1])>1,'Actual route preview follows the moving waypoint');
      await shot('missions-waypoint-dragging');
    }});
    const movedPoints=await evaluate('BoatMissions.route.points');assert.equal(movedPoints.length,3,'Drag release never adds a waypoint');
    assert.ok(N.distance(movedPoints[1],beforeDragging[1])>1);assert.deepEqual(movedPoints[0],beforeDragging[0]);assert.deepEqual(movedPoints[2],beforeDragging[2]);
    assert.deepEqual(await evaluate('BoatMissions.route.segments[0].control'),controlBeforeDragging,'Moving an endpoint retains the explicit curve control coordinate');
    assert.equal(await evaluate('BoatMissions.dirty&&!BoatMissions.drag&&document.getElementById("missionStart").disabled'),true);
    assert.deepEqual(new MissionStore({env:f.env}).get('boat-01',curveId).points,beforeDragging,'Drag cannot silently save or execute');
    await dragPin('.mission-pin span[data-kind=start]',15,6,{cancel:true});assert.deepEqual(await evaluate('BoatMissions.route.points'),movedPoints,'Escape discards only the current preview, retaining earlier draft changes');
    await evaluate('if(!BoatMissions.editing)document.getElementById("missionEdit").click()');
    await dragPin('.mission-curve-pin span',-8,-6);assert.ok(N.distance(await evaluate('BoatMissions.route.segments[0].control'),controlBeforeDragging)>1);
    assert.equal(await evaluate('BoatMissions.curveEditing'),-1,'A drag cannot also activate click-to-pick a curve point');
    await evaluate('document.getElementById("missionSave").click()');await until('!BoatMissions.busy&&!BoatMissions.dirty');savedCurve=new MissionStore({env:f.env}).get('boat-01',curveId);
    // 松手提交后继续拖动使用新草稿对象；切船时取消预览，不能把旧坐标写到另一艘船。
    await dragPin('.mission-pin span[data-kind=via]',-10,6,{beforeDrop:async()=>{
      await evaluate('boatMonitor.selectBoat("boat-02",false)');await until('BoatMissions.deviceId==="boat-02"&&!BoatMissions.drag');
    }});
    await evaluate('boatMonitor.selectBoat("boat-01",false)');await until('BoatMissions.deviceId==="boat-01"&&BoatMissions.routes.some(r=>r.id==="'+curveId+'")');
    assert.deepEqual(await evaluate('BoatMissions.route.points'),savedCurve.points);assert.equal(await evaluate('BoatMissions.dirty'),false);
    await evaluate('BoatMissions.map.switchProvider("arcgis")');await until('BoatMissions.map.provider==="arcgis"&&!BoatMissions.map.switching');
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    // Leaflet 在加载时探测触屏能力，按真实手机首次进入的方式重新加载页面。
    await send('Page.reload');await until('window.BoatMissions?.routes.some(r=>r.id==="'+curveId+'")&&BoatMissions.map?.ready');await evaluate('BoatMissions.load("'+curveId+'")');
    assert.equal(await evaluate('L.Browser.touch&&navigator.maxTouchPoints>0'),true);
    await evaluate('document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.fit()');await wait(200);
    // 触摸移动超过浏览器自身的手势启动距离，再检查真实拖动状态。
    await dragPin('.mission-pin span[data-kind=end]',-36,24,{touch:true,beforeDrop:async()=>assert.equal(await evaluate('!!BoatMissions.drag'),true,'Touch drags the marker on the satellite map')});
    assert.ok(N.distance(await evaluate('BoatMissions.route.points.at(-1)'),savedCurve.points.at(-1))>1);assert.equal(await evaluate('BoatMissions.route.points.length'),3);await shot('missions-waypoint-touch-375');
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('document.getElementById("missionSave").click()');await until('!BoatMissions.busy&&!BoatMissions.dirty');savedCurve=new MissionStore({env:f.env}).get('boat-01',curveId);
    await send('Page.reload');await until('window.BoatMissions?.routes.some(r=>r.id==="'+curveId+'")&&BoatMissions.map?.ready');
    await evaluate('BoatMissions.load("'+curveId+'")');assert.deepEqual(await evaluate('BoatMissions.route.points'),savedCurve.points);assert.deepEqual(await evaluate('BoatMissions.route.segments'),savedCurve.segments);
    assert.equal(f.commands().length,commandsBeforeDragging,'All planning drag operations stay separate from vessel control');
    console.log('PASS: mouse/touch waypoint and curve dragging, live preview across polling, Escape, vessel switch, satellite map and explicit save/reload.');
    await evaluate('document.querySelectorAll(".mission-point-tools")[1].querySelectorAll("button")[1].click()');
    assert.equal(await evaluate('BoatMissions.route.segments===undefined'),true,'Reordered endpoints do not inherit an unrelated curve');
    await evaluate('BoatMissions.load("'+curveId+'");document.querySelectorAll(".mission-point-tools")[2].lastElementChild.click()');
    assert.deepEqual(await evaluate('BoatMissions.route.segments'),[savedCurve.segments[0]],'Deleting an unrelated endpoint retains the remaining curve');
    await evaluate('BoatMissions.load("'+curveId+'")');
    for(const [width,height]of [[1440,1100],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate('document.getElementById("missionPoints").scrollIntoView({block:"center",behavior:"instant"})');await wait(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll(".mission-segment-editor input,.mission-segment-editor select")].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})'),true,'Curve editor controls fit '+width);
      await shot('missions-curve-editor-'+width);
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissions.fit()');await wait(120);await shot('missions-curve-map');
    f.feed('boat-01',{...ORIGIN,heading:0});await evaluate('document.getElementById("missionStart").click()');await until('BoatMissions.run()?.status==="running"&&BoatMissions.run()?.targetIndex===1');
    assert.equal(await evaluate('document.querySelector("[data-segment-index]").disabled'),true,'Running route shape is locked');
    await until('[...document.querySelectorAll("#missionMap .mission-pin")].every(n=>n.dataset.draggable==="false")');
    await dragPin('.mission-pin span[data-kind=via]',12,0);assert.deepEqual(await evaluate('BoatMissions.route.points'),savedCurve.points,'Running waypoint dragging cannot change the route');
    await evaluate('BoatWorkspace.navigate("navigation",{focus:false})');await until('boatMonitor.map._lineOverlays.get("mission")?.lines[0]?.points.length>3');
    const displayedCurve=await evaluate('boatMonitor.map._lineOverlays.get("mission").lines[0].points'),expectedCurve=require('../public/utils/missionPath').compile(savedCurve).points;
    assert.equal(displayedCurve.length,expectedCurve.length);assert.ok(displayedCurve.every((p,i)=>N.distance(p,expectedCurve[i])<.00001),'Monitoring and driving use the same actual curved route within cross-runtime floating point precision');
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("missionStop").click()');await until('BoatMissions.run()?.status==="stopped"&&BoatMissions.run()?.stopConfirmed');
    await evaluate('document.getElementById("missionRouteSelect").value="'+routeId+'";document.getElementById("missionRouteSelect").dispatchEvent(new Event("change"));window.scrollTo(0,0)');
    // 驾驶页直接使用同一任务 API：修改航速、暂停确认、继续新租约和独立急停。
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});window.scrollTo(0,0);boatMonitor.driver.navigation.selectMode("auto")');
    await evaluate('document.getElementById("driverRouteSelect").value="'+routeId+'";document.getElementById("driverRouteSelect").dispatchEvent(new Event("change"))');
    await until('!document.getElementById("driverNavSave").disabled');
    await evaluate('document.getElementById("driverNavSpeed").value="1.2";document.getElementById("driverNavRadius").value="4";document.getElementById("driverNavSave").click()');
    await until('!boatMonitor.driver.navigation.busy&&BoatMissions.routes[0]?.speedMps===1.2');
    assert.equal(new MissionStore({env:f.env}).get('boat-01',routeId).arrivalRadiusM,4,'Cockpit speed settings really persist to the selected route');
    await until('!document.getElementById("driverNavStart").disabled');await evaluate('document.getElementById("driverNavStart").click()');
    await until('BoatMissions.run()?.status==="running"&&BoatMissions.run()?.targetIndex===1');
    await until('!document.getElementById("driverHudGuidance").hidden');
    assert.match(await evaluate('document.getElementById("driverHudGuideText").textContent'),/航点 2/);
    const firstLease=f.mission.jobs.get('boat-01').leaseId;
    await evaluate('document.getElementById("driverNavPause").click()');await until('BoatMissions.run()?.status==="paused"&&BoatMissions.run()?.stopConfirmed');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),3,'Paused route remains visible');
    assert.equal(await evaluate('document.getElementById("driverHudGuidance").hidden'),true,'Paused navigation does not display a live steering cue');
    await until('!document.getElementById("driverNavResume").disabled');await evaluate('document.getElementById("driverNavResume").click()');await until('BoatMissions.run()?.status==="running"');
    assert.notEqual(f.mission.jobs.get('boat-01').leaseId,firstLease,'Continue obtains a fresh MCU lease');
    assert.equal(f.mission.jobs.get('boat-01').index,1,'Continue preserves the current route waypoint');
    await evaluate('document.getElementById("driverEmergency").click()');await until('BoatMissions.run()?.status==="stopped"&&BoatMissions.run()?.stopConfirmed');
    await evaluate('boatMonitor.driver.navigation.selectMode("hold")');await until('!document.getElementById("driverNavStart").disabled');
    await evaluate('document.getElementById("driverNavStart").click()');await until('BoatMissions.run()?.action==="hold"&&BoatMissions.run()?.status==="running"');
    assert.equal(f.mission.snapshot('boat-01').commandSpeedMps,0,'Station keeping starts at zero speed inside its radius');
    f.feed('boat-01',{...N.destination(ORIGIN,0,10),heading:180});
    await until('BoatMissions.run()?.commandSpeedMps>0');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),1,'The hold anchor appears as a real single-point target');
    await evaluate('document.getElementById("driverEmergency").click()');await until('BoatMissions.run()?.status==="stopped"');
    // 在共享地图上真实鼠标点选返航点；保存前不发控制、不写入存储。
    await until('!document.getElementById("driverHomeSet").disabled');
    await evaluate('document.getElementById("driverMapOptions").open=true');
    assert.equal(await evaluate('document.getElementById("driverHomeSet").getBoundingClientRect().height>=28'),true,'Map and return-home tools expand into real operable controls');
    await evaluate('document.getElementById("driverHomeSet").click();document.getElementById("mapFollow").checked=false;boatMonitor.map.setView('+JSON.stringify(ORIGIN)+',18,{animate:false});window.scrollTo(0,0)');await wait(180);
    const homePoint=N.destination(ORIGIN,0,30),homePixel=await evaluate('(()=>{const p=boatMonitor.map.map.latLngToContainerPoint(['+homePoint.latitude+','+homePoint.longitude+']),r=document.getElementById("map").getBoundingClientRect();return {x:r.left+p.x,y:r.top+p.y};})()');
    await shot('driver-select-home');
    assert.equal(await evaluate('document.elementFromPoint('+homePixel.x+','+homePixel.y+')?.closest("#map")?.id'), 'map','Home click reaches the actual map: '+JSON.stringify(homePixel)+' '+await evaluate('JSON.stringify({editing:boatMonitor.driver.navigation.editingHome,hit:document.elementFromPoint('+homePixel.x+','+homePixel.y+')?.outerHTML.slice(0,500),notice:document.getElementById("driverNavNotice").textContent})'));
    const countBeforeHome=f.commands().length;
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...homePixel,button:'left',clickCount:1});
    await until('!!boatMonitor.driver.navigation.draft');assert.equal(f.store.getHome('boat-01'),null);assert.equal(f.commands().length,countBeforeHome);
    await evaluate('document.getElementById("driverHomeSave").click()');await until('!!BoatMissions.home&&!boatMonitor.driver.navigation.busy');
    const home=f.store.getHome('boat-01');assert.ok(N.distance(home,homePoint)<1,'A rounded screen pixel remains within one metre at zoom 18: '+JSON.stringify({home,homePoint}));assert.deepEqual(new MissionStore({env:f.env}).getHome('boat-01'),home);
    await send('Page.reload');await until('window.boatMonitor?.driver?.navigation&&BoatMissions.home?.revision===1&&boatMonitor.map.ready');
    assert.equal(await evaluate('!!boatMonitor.driver.navigation.marker'),true,'Saved home is restored without automatically controlling the vessel');
    await evaluate('boatMonitor.selectBoat("boat-02",false)');await until('BoatMissions.deviceId==="boat-02"');
    assert.equal(await evaluate('BoatMissions.home===null&&!boatMonitor.driver.navigation.marker'),true,'Home marker is isolated per vessel');
    await evaluate('boatMonitor.selectBoat("boat-01",false);BoatWorkspace.navigate("driving",{focus:false})');await until('!document.getElementById("driverReturnHome").disabled');
    await evaluate('document.getElementById("driverMapOptions").open=true;document.getElementById("driverReturnHome").click()');await until('BoatMissions.run()?.action==="home"&&BoatMissions.run()?.status==="running"');
    assert.deepEqual(f.mission.snapshot('boat-01').route.points,[{latitude:home.latitude,longitude:home.longitude}]);
    await until('document.getElementById("driverHudGuideText").textContent.includes("返航点")');
    await evaluate('document.getElementById("driverEmergency").click()');await until('BoatMissions.run()?.status==="stopped"');
    await evaluate('boatMonitor.driver.navigation.selectMode("hold")');await until('!document.getElementById("driverNavStart").disabled');
    await evaluate('window.__missionFetch=window.fetch;window.fetch=async function(input,options){const response=await window.__missionFetch(input,options);if(input==="/api/missions/run"&&JSON.parse(options?.body||"{}").action==="hold")await new Promise(resolve=>setTimeout(resolve,1200));return response;};document.getElementById("driverNavStart").click()');
    await until('boatMonitor.driver.navigation.motionPending&&!document.getElementById("driverEmergency").disabled');
    await evaluate('document.getElementById("driverEmergency").click()');
    await until('BoatMissions.run()?.status==="stopped"&&!boatMonitor.driver.navigation.motionPending');
    assert.equal(f.mission.snapshot('boat-01').stopConfirmed,true,'Emergency works while the navigation start HTTP response is still pending');
    await wait(1400);assert.equal(f.mission.active('boat-01'),false,'A delayed start response cannot revive cancelled autonomy');
    await evaluate('window.fetch=window.__missionFetch;delete window.__missionFetch');
    await shot('driver-autonomy-dark');
    // 多任务由真实页面保存、排序、启停；服务器在切页和关闭页面后自行转场与循环。
    const queueRoutes=[f.route('boat-01',{name:'队列轨迹一',points:[ORIGIN,N.destination(ORIGIN,0,20)]}),f.route('boat-01',{name:'队列轨迹二',speedMps:1.2,points:[N.destination(ORIGIN,90,20),N.destination(ORIGIN,90,45)],segments:[{type:'curve',control:require('../public/utils/missionPath').defaultControl(N.destination(ORIGIN,90,20),N.destination(ORIGIN,90,45))}]})];
    const originalQueueSources=structuredClone(queueRoutes);
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});BoatMissions.poll(true)');await until('BoatMissions.routes.some(r=>r.id==="'+queueRoutes[1].id+'")&&window.BoatMissionQueue&&!BoatMissions.busy');
    const beforeQueuePlanning=f.commands().length;
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.navigation.selectMode("auto");document.getElementById("driverTaskKind").value="queue";document.getElementById("driverTaskKind").dispatchEvent(new Event("change"));document.getElementById("driverQueueSettings").click()');
    assert.equal(await evaluate('document.getElementById("driverQueueDialog").open&&document.querySelectorAll("#missionQueueCard").length===1&&document.getElementById("driverQueueEditorSlot").contains(document.getElementById("missionQueueCard"))'),true,'Driving settings reuse the single queue editor in a native modal');
    await evaluate('document.getElementById("missionQueueNew").click();document.getElementById("missionQueueName").value="双轨迹巡航";document.getElementById("missionQueueName").dispatchEvent(new Event("input"))');
    for(const route of [queueRoutes[1],queueRoutes[0],queueRoutes[1]])await evaluate('document.getElementById("missionQueueRoute").value="'+route.id+'";document.getElementById("missionQueueAdd").click()');
    assert.equal(await evaluate('BoatMissionQueue.queue.routes[0]!==BoatMissionQueue.queue.routes[2]&&BoatMissionQueue.queue.routes[0].points!==BoatMissionQueue.queue.routes[2].points'),true,'Repeated sources have separate editable copies');
    await evaluate('document.querySelectorAll("#missionQueueList li")[1].querySelectorAll("button")[0].click();document.querySelectorAll("#missionQueueList li")[2].querySelectorAll("button")[2].click()');
    assert.deepEqual(await evaluate('BoatMissionQueue.queue.routeIds'),queueRoutes.map(r=>r.id),'Real queue buttons reorder and remove routes without touching their geometry');
    await evaluate('document.getElementById("missionQueueLoopEnabled").click();document.getElementById("missionQueueLoopCount").value="0";document.getElementById("missionQueueLoopCount").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.getElementById("missionQueueSave").disabled'),true);
    await evaluate('document.getElementById("missionQueueLoopCount").value="2";document.getElementById("missionQueueLoopCount").dispatchEvent(new Event("input"));document.getElementById("missionQueueSave").click()');
    await until('!!BoatMissionQueue.queue.id&&!BoatMissionQueue.dirty&&!BoatMissions.busy');
    const queueId=await evaluate('BoatMissionQueue.queue.id');assert.deepEqual(new MissionStore({env:f.env}).getQueue('boat-01',queueId).routeIds,queueRoutes.map(r=>r.id));
    // 在航线任务页编辑组副本；驾驶弹窗随后复用同一地图和草稿。
    await evaluate('document.getElementById("driverQueueClose").click();BoatWorkspace.navigate("missions",{focus:false});document.getElementById("missionQueueMap").scrollIntoView({block:"center",behavior:"instant"})');
    await until('BoatMissionQueue.preview.map?.ready');await evaluate('BoatMissionQueue.preview.fit()');await wait(160);
    assert.equal(await evaluate('BoatMissionQueue.preview.map.lastTrackLines.filter(l=>l.className==="mission-queue-route-line").length'),2);
    assert.equal(await evaluate('new Set(BoatMissionQueue.preview.map.lastTrackLines.filter(l=>l.className==="mission-queue-route-line").map(l=>l.color)).size'),2,'Each route has its own color');
    assert.equal(await evaluate('BoatMissionQueue.preview.map.lastTrackLines.filter(l=>l.className==="mission-queue-transfer-line"&&l.dashed).length'),2,'Transfers and whole-group return are dashed');
    assert.equal(await evaluate('document.querySelectorAll("#missionQueueLegend button").length'),2);
    await evaluate('document.getElementById("missionQueueEdit").click()');
    const firstBefore=await evaluate('BoatMissionQueue.queue.routes[0].points[1]');
    await dragPin('#missionQueueMap .mission-queue-pin[title*="航点 2"]',12,-16,{beforeDrop:async()=>{
      await wait(1100);assert.equal(await evaluate('!!BoatMissionQueue.preview.drag&&document.getElementById("missionQueueSave").disabled'),true,'Status polling preserves group drag and prevents saving midway');
      assert.deepEqual(await evaluate('BoatMissionQueue.queue.routes[0].points[1]'),firstBefore,'Dragging changes only preview until release');
      assert.notDeepEqual(await evaluate('BoatMissionQueue.preview.map.lastTrackLines.find(l=>l.className==="mission-queue-route-line").points.at(-1)'),firstBefore,'Actual preview path follows the pointer');
    }});
    const firstAfter=await evaluate('BoatMissionQueue.queue.routes[0].points[1]');assert.ok(N.distance(firstAfter,firstBefore)>.5);assert.equal(await evaluate('BoatMissionQueue.dirty'),true);
    await dragPin('#missionQueueMap .mission-queue-pin[title*="航点 2"]',-10,9,{cancel:true});assert.deepEqual(await evaluate('BoatMissionQueue.queue.routes[0].points[1]'),firstAfter,'Esc cancels only the current group drag');
    await evaluate('document.querySelectorAll("#missionQueueLegend button")[1].click()');
    assert.equal(await evaluate('BoatMissionQueue.preview.index===1&&document.querySelectorAll("#missionQueuePoints li").length===2'),true);
    const nextStart=await evaluate('BoatMissionQueue.queue.routes[1].points[0]');
    await evaluate('document.getElementById("missionQueueAlign").click()');assert.deepEqual(await evaluate('BoatMissionQueue.queue.routes[1].points[0]'),firstAfter,'Group start snaps to previous private endpoint');
    const setCoordinate=async(index,field,value)=>evaluate('(()=>{const input=document.querySelectorAll("#missionQueuePoints li")['+index+'].querySelectorAll("input")['+field+'];input.value='+JSON.stringify(String(value))+';input.dispatchEvent(new Event("change"));})()');
    await setCoordinate(0,0,nextStart.latitude);await setCoordinate(0,1,nextStart.longitude);
    await setCoordinate(1,0,nextStart.latitude);await setCoordinate(1,1,nextStart.longitude);
    assert.equal(await evaluate('!document.getElementById("missionQueuePreviewError").hidden&&document.getElementById("missionQueueSave").disabled'),true,'Invalid copied geometry is explained before saving');
    const revisedEnd=N.destination(queueRoutes[1].points[1],90,5);await setCoordinate(1,0,revisedEnd.latitude);await setCoordinate(1,1,revisedEnd.longitude);
    await evaluate('document.getElementById("missionQueueMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissionQueue.preview.fit()');await wait(120);
    const controlBefore=await evaluate('BoatMissionQueue.queue.routes[1].segments[0].control');
    await dragPin('#missionQueueMap .mission-queue-control-pin',0,6);assert.notDeepEqual(await evaluate('BoatMissionQueue.queue.routes[1].segments[0].control'),controlBefore,'Curve control edits remain private too');
    const linesBeforeHide=await evaluate('BoatMissionQueue.preview.map.lastTrackLines.filter(l=>l.className!=="mission-queue-curve-guide")');
    await evaluate('document.getElementById("missionQueueWaypoints").click()');assert.equal(await evaluate('BoatMissionQueue.preview.markers.length'),0);
    assert.deepEqual(await evaluate('BoatMissionQueue.preview.map.lastTrackLines'),linesBeforeHide,'Hiding markers preserves colored curves and transfers');
    await evaluate('document.getElementById("missionQueueEdit").click()');assert.equal(await evaluate('BoatMissionQueue.preview.pointsVisible&&BoatMissionQueue.preview.editable()'),true);
    await evaluate('BoatMissionQueue.preview.map.switchProvider("osm")');
    await evaluate('document.getElementById("missionQueueMapProvider").click()');await until('BoatMissionQueue.preview.map.provider==="arcgis"&&!BoatMissionQueue.preview.map.switching');
    await evaluate('document.getElementById("missionQueueSave").click()');await until('!BoatMissionQueue.dirty&&!BoatMissions.busy');
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await send('Page.reload');await until('window.BoatMissionQueue?.queue.id==="'+queueId+'"&&BoatMissionQueue.preview.map?.ready');
    await evaluate('BoatMissionQueue.preview.select(1);document.getElementById("missionQueueEdit").click();document.getElementById("missionQueueMap").scrollIntoView({block:"center",behavior:"instant"});BoatMissionQueue.preview.fit()');await wait(160);
    const touchBefore=await evaluate('BoatMissionQueue.queue.routes[1].points[1]');
    await dragPin('#missionQueueMap .mission-queue-pin[title*="航点 2"]',30,-15,{touch:true,beforeDrop:async()=>assert.equal(await evaluate('!!BoatMissionQueue.preview.drag'),true,'Mobile browser starts a genuine group waypoint drag')});assert.ok(N.distance(await evaluate('BoatMissionQueue.queue.routes[1].points[1]'),touchBefore)>.3,'Touch dragging on satellite map updates only the selected copy');
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await evaluate('document.getElementById("missionQueueMapProvider").click()');await until('BoatMissionQueue.preview.map.provider==="osm"&&!BoatMissionQueue.preview.map.switching');
    const draftPoints=await evaluate('BoatMissionQueue.queue.routes');
    await evaluate('boatMonitor.selectBoat("boat-02",false)');await until('BoatMissionQueue.deviceId==="boat-02"');assert.equal(await evaluate('BoatMissionQueue.preview.markers.length'),0);
    await evaluate('boatMonitor.selectBoat("boat-01",false)');await until('BoatMissionQueue.deviceId==="boat-01"');assert.deepEqual(await evaluate('BoatMissionQueue.queue.routes'),draftPoints,'Group geometry drafts are isolated per vessel');
    for(const theme of ['dark','light']){
      await evaluate('document.documentElement.dataset.theme==="'+theme+'"||document.getElementById("themeToggle").click()');
      for(const [width,height]of [[1440,1100],[375,812],[320,812]]){
        await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
        await evaluate('document.querySelector(".mission-queue-preview").scrollIntoView({block:"start",behavior:"instant"});BoatMissionQueue.preview.fit()');await wait(100);
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById("missionQueueMap").getBoundingClientRect().height>=300&&["missionQueueMap","missionQueuePreviewRoute","missionQueuePoints"].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})'),true,'Group preview fits '+width+' '+theme);
        await shot('mission-queue-preview-'+width+'-'+theme);
      }
    }
    await evaluate('document.getElementById("themeToggle").click();document.getElementById("missionQueueSave").click()');await until('!BoatMissionQueue.dirty&&!BoatMissions.busy');
    const privateSaved=new MissionStore({env:f.env}).getQueue('boat-01',queueId);assert.deepEqual(privateSaved.routes,draftPoints);assert.deepEqual(new MissionStore({env:f.env}).list('boat-01').filter(r=>queueRoutes.some(s=>s.id===r.id)),originalQueueSources,'Editing group copies leaves the original library byte-for-byte equivalent');
    for(let i=0;i<queueRoutes.length;i++){queueRoutes[i].points=privateSaved.routes[i].points;queueRoutes[i].segments=privateSaved.routes[i].segments;}
    // 来源删除后仍可预览、保存和执行任务组；保留第二条来源验证活动组不会锁定原航线。
    f.store.delete('boat-01',queueRoutes[0].id,queueRoutes[0].revision);await evaluate('BoatMissions.poll(true)');await until('!BoatMissions.routes.some(r=>r.id==="'+queueRoutes[0].id+'")');
    assert.equal(await evaluate('!document.getElementById("missionQueueSave").disabled&&BoatMissionQueue.preview.map.lastTrackLines.some(l=>l.className==="mission-queue-route-line")'),true);
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.navigation.selectMode("auto");document.getElementById("driverTaskKind").value="queue";document.getElementById("driverTaskKind").dispatchEvent(new Event("change"));document.getElementById("driverQueueSettings").click()');
    assert.equal(f.commands().length,beforeQueuePlanning,'Saving and editing a queue never arms the boat');
    for(const [width,height]of [[1440,1100],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate('document.getElementById("missionQueueTitle").scrollIntoView({block:"nearest",behavior:"instant"})');await wait(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&["missionQueueName","missionQueueRoute","missionQueueLoopCount"].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})'),true,'Queue editor fits '+width);
      await shot('driver-queue-settings-'+width+'-dark');
    }
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await evaluate('!document.getElementById("driverQueueDialog").open&&BoatWorkspace.current==="driving"&&document.getElementById("view-missions").contains(document.getElementById("missionQueueCard"))'),true,'Escape closes only group settings and restores the original editor');
    assert.equal(await evaluate('document.getElementById("driverQueueSelect").value'),queueId,'The saved group is selected for one-click start');
    assert.match(await evaluate('document.getElementById("driverQueueSummary").textContent'),/2 条航线.*2 轮/);
    for(const [width,height]of [[1440,900],[375,667],[320,667]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});await wait(100);
      assert.equal(await evaluate('["driverTaskKind","driverQueueSelect","driverQueueSettings","driverGoto","driverNavStart","driverNavPause","driverNavResume"].every(id=>{const node=document.getElementById(id),r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&(hit===node||node.contains(hit));})'),true,'Driver group selection and start controls fit '+width);
      await shot('driver-queue-'+width+'-dark');
    }
    await evaluate('document.getElementById("driverQueueSettings").click();document.getElementById("missionQueueName").value="临时未保存修改";document.getElementById("missionQueueName").dispatchEvent(new Event("input"));document.getElementById("driverQueueClose").click()');
    await until('!document.getElementById("driverNavStart").disabled');await evaluate('document.getElementById("driverNavStart").click()');await until('!boatMonitor.driver.navigation.busy');
    assert.match(await evaluate('document.getElementById("driverNavNotice").textContent'),/未保存/);assert.equal(f.mission.active('boat-01'),false,'Driving cannot start a group with unsaved edits');
    await evaluate('document.getElementById("driverQueueSettings").click();document.getElementById("missionQueueName").value="双轨迹巡航";document.getElementById("missionQueueName").dispatchEvent(new Event("input"));document.getElementById("missionQueueSave").click()');await until('!BoatMissionQueue.dirty&&!BoatMissions.busy');
    await evaluate('boatMonitor.selectBoat("boat-02",false)');await until('!document.getElementById("driverQueueDialog").open&&BoatMissions.deviceId==="boat-02"');
    assert.equal(await evaluate('document.getElementById("driverQueueSelect").options.length'),1,'Switching boats closes settings and clears the previous group list');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('boatMonitor.selectBoat("boat-02",false)');await until('BoatMissions.deviceId==="boat-02"&&BoatMissionQueue.deviceId==="boat-02"');
    assert.equal(await evaluate('BoatMissionQueue.queue.routeIds.length'),0,'Queue drafts and definitions belong to one vessel');
    await evaluate('boatMonitor.selectBoat("boat-01",false)');await until('BoatMissionQueue.queue.id==="'+queueId+'"&&BoatMissions.queues.length===1');
    await send('Page.reload');await until('window.BoatMissionQueue?.queue.id==="'+queueId+'"&&boatMonitor.driver?.remote?.ready');
    assert.equal(await evaluate('document.getElementById("missionQueueLoopCount").value'),'2','Saved queue and loops restore after reload');
    await evaluate('boatMonitor.driver.navigation.selectMode("auto");document.getElementById("driverTaskKind").value="queue";document.getElementById("driverTaskKind").dispatchEvent(new Event("change"));document.getElementById("driverQueueSelect").value="'+queueId+'";document.getElementById("driverQueueSelect").dispatchEvent(new Event("change"))');
    f.feed('boat-01',{...ORIGIN,heading:0});await until('!document.getElementById("driverGoto").disabled');await evaluate('document.getElementById("driverGoto").click()');await until('BoatMissions.run()?.queue?.id==="'+queueId+'"&&BoatMissions.run()?.status==="completed"');
    assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,0,'Goto only reaches the first start and stops');
    await until('!document.getElementById("driverNavStart").disabled');await evaluate('document.getElementById("driverNavStart").click()');await until('BoatMissions.run()?.queue?.id==="'+queueId+'"&&BoatMissions.run()?.status==="running"&&BoatMissions.run()?.targetIndex===1');
    const queueLease=f.mission.jobs.get('boat-01').leaseId;
    await evaluate('BoatMissions.load("'+queueRoutes[1].id+'")');assert.equal(await evaluate('!document.getElementById("missionSave").disabled&&document.getElementById("missionQueueSave").disabled&&document.getElementById("missionQueueLoopCount").disabled&&!BoatMissionQueue.preview.editable()'),true,'Running private group is locked while its original routes stay editable');
    assert.deepEqual(f.mission.snapshot('boat-01').route.points,privateSaved.routes[0].points,'Server navigates the edited private waypoints');
    f.feed('boat-01',{...queueRoutes[0].points[1],heading:0});await until('BoatMissions.run()?.phase==="transit"&&BoatMissions.run()?.queue?.routeIndex===1');
    await evaluate('BoatWorkspace.navigate("navigation",{focus:false})');await until('boatMonitor.map._lineOverlays.get("mission")?.lines.some(l=>l.className==="map-mission-line map-mission-transfer")');
    const transferLine=await evaluate('boatMonitor.map._lineOverlays.get("mission").lines.find(l=>l.className==="map-mission-line map-mission-transfer").points');
    assert.ok(N.distance(transferLine[0],queueRoutes[0].points[1])<.02);assert.deepEqual(transferLine[1],queueRoutes[1].points[0]);
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');assert.match(await evaluate('document.getElementById("driverMissionName").textContent'),/双轨迹巡航.*2 \/ 2/);assert.equal(f.mission.jobs.get('boat-01').leaseId,queueLease);
    assert.equal(await evaluate('document.getElementById("driverTaskKind").value==="queue"&&document.getElementById("driverQueueSelect").value==="'+queueId+'"&&document.getElementById("driverQueueSelect").disabled'),true,'A running group restores and locks its driving selection');
    await evaluate('document.getElementById("driverNavPause").click()');await until('BoatMissions.run()?.status==="paused"&&BoatMissions.run()?.resumable');
    await until('!document.getElementById("driverNavResume").disabled');await evaluate('document.getElementById("driverNavResume").click()');await until('BoatMissions.run()?.status==="running"&&BoatMissions.run()?.phase==="transit"');
    assert.notEqual(f.mission.jobs.get('boat-01').leaseId,queueLease,'Resume acquires a fresh lease and preserves the current route');
    await send('Page.navigate',{url:'about:blank'});const beforeQueueClosed=f.commands().length;await wait(1100);assert.equal(f.mission.active('boat-01'),true);assert.ok(f.commands().length>beforeQueueClosed+5,'Server keeps the sequence active with no browser');
    await send('Page.navigate',{url:base+'/#missions'});await until('window.BoatMissionQueue?.queue.id==="'+queueId+'"&&BoatMissions.run()?.phase==="transit"');
    for(let lap=1;lap<=2;lap++){
      if(lap>1){f.feed('boat-01',{...queueRoutes[0].points[1],heading:0});await until('BoatMissions.run()?.phase==="transit"&&BoatMissions.run()?.queue?.routeIndex===1');}
      f.feed('boat-01',{...queueRoutes[1].points[0],heading:90});await until('BoatMissions.run()?.phase==="route"&&BoatMissions.run()?.queue?.routeIndex===1&&BoatMissions.run()?.targetIndex===1');
      f.feed('boat-01',{...queueRoutes[1].points[1],heading:90});await until('BoatMissions.run()?.phase==="queueReturning"');
      assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,lap-1);
      f.feed('boat-01',{...ORIGIN,heading:270});await until(lap===1?'BoatMissions.run()?.queue?.completedLoops===1&&BoatMissions.run()?.phase==="route"&&BoatMissions.run()?.queue?.routeIndex===0':'BoatMissions.run()?.status==="completed"&&BoatMissions.run()?.stopConfirmed');
    }
    assert.equal(f.mission.snapshot('boat-01').queue.completedLoops,2);assert.match(await evaluate('document.getElementById("missionQueueProgress").textContent'),/已完成 2 轮/);
    await evaluate('document.getElementById("missionQueueStart").click()');await until('BoatMissions.run()?.status==="running"');
    await evaluate('document.getElementById("missionQueueStop").click()');await until('BoatMissions.run()?.status==="stopped"&&BoatMissions.run()?.stopConfirmed');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');await until('!document.getElementById("driverNavStart").disabled');
    await evaluate('window.__missionFetch=window.fetch;window.fetch=async function(input,options){const response=await window.__missionFetch(input,options);if(input==="/api/missions/run"&&JSON.parse(options?.body||"{}").action==="queueStart")await new Promise(resolve=>setTimeout(resolve,1200));return response;};document.getElementById("driverNavStart").click()');
    await until('boatMonitor.driver.navigation.motionPending&&BoatMissions.run()?.active');
    await evaluate('document.getElementById("driverEmergency").click()');await until('BoatMissions.run()?.status==="stopped"&&!boatMonitor.driver.navigation.motionPending');
    await wait(1400);assert.equal(f.mission.active('boat-01'),false,'Late queue-start HTTP response cannot revive a group cancelled from the driving emergency button');
    await evaluate('window.fetch=window.__missionFetch;delete window.__missionFetch');
    console.log('PASS: multicolor group preview, private coordinate/mouse/touch/curve edits, Esc/invalid-geometry feedback, original-library isolation/deletion, dark/light responsive layouts, save/reload, private execution, group locks, transfers, pause/resume and two whole-queue loops.');
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("themeToggle").click()');
    for(const [width,height]of [[1440,1100],[1024,900],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(100);
      await evaluate('BoatMissions.map.invalidateSize();BoatMissions.fit()');await wait(120);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'No horizontal overflow at '+width);
      assert.equal(await evaluate('document.getElementById("missionMap").getBoundingClientRect().height>=300'),true);
      await evaluate('document.getElementById("view-missions").scrollIntoView({block:"start",behavior:"instant"})');await shot('missions-'+width+'-light');
    }
    }
    // 实线/虚线为独立航段属性；真实按钮启动专用记录，关闭网页后仍按段采样。
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("missionNew").click();document.getElementById("missionSegmentType").value="line";document.getElementById("missionName").value="分段记录巡航";document.getElementById("missionName").dispatchEvent(new Event("input"));');
    const recordingPoints=[0,30,60,90].map(m=>N.destination(ORIGIN,0,m));
    for(let i=0;i<recordingPoints.length;i++)await evaluate('document.getElementById("missionSegmentRecord").value='+JSON.stringify(i===2?'skip':'record')+';BoatMissions.addPoint('+JSON.stringify(recordingPoints[i])+')');
    assert.deepEqual(await evaluate('BoatMissions.map.lastTrackLines.filter(l=>l.color==="#467dff").map(l=>l.dashed)'),[false,true,false]);
    await evaluate('(()=>{const s=document.querySelectorAll("[data-segment-record]")[0];s.value="skip";s.dispatchEvent(new Event("change"));BoatMissions.changeSegment(0,"curve");})()');
    assert.equal(await evaluate('BoatMissions.route.segments[0].record'),false,'Changing the segment shape preserves recording choice');
    await evaluate('BoatMissions.changeSegment(0,"line");(()=>{const s=document.querySelectorAll("[data-segment-record]")[0];s.value="record";s.dispatchEvent(new Event("change"));})();document.getElementById("missionSave").click()');
    await until('BoatMissions.route.id&&!BoatMissions.busy&&!BoatMissions.dirty');const recordingRouteId=await evaluate('BoatMissions.route.id');
    assert.equal(f.store.get('boat-01',recordingRouteId).segments[1].record,false);
    f.feed('boat-01',{...ORIGIN,heading:0});await until('!document.getElementById("missionStartRecord").disabled');
    await evaluate('document.getElementById("missionStartRecord").click()');await until('BoatMissions.run()?.status==="running"&&BoatMissions.run()?.targetIndex===1&&!!BoatMissions.run()?.trackId');
    const recordingId=f.mission.snapshot('boat-01').trackId;
    f.feed('boat-01',recordingPoints[1]);await until('BoatMissions.run()?.targetIndex===2');
    const recordedCount=f.mission.tracks.get('boat-01',recordingId).pointCount;
    await until('BoatMissionTracks.track?.pointCount>1&&BoatMissions.map._lineOverlays.has("mission-recording")');
    await evaluate('document.getElementById("missionTrackToggle").click()');
    assert.equal(await evaluate('BoatMissions.map._lineOverlays.has("mission-recording")'),false,'Display switch clears only recorded overlays');
    assert.equal(f.mission.active('boat-01'),true);await evaluate('document.getElementById("missionTrackToggle").click()');
    await send('Page.navigate',{url:'about:blank'});f.feed('boat-01',{...N.destination(ORIGIN,0,45),heading:0});await wait(1200);
    assert.equal(f.mission.tracks.get('boat-01',recordingId).pointCount,recordedCount,'No browser is needed; skipped segment adds no point');
    assert.ok(f.commands().at(-1).payload.readInt16LE(30)>0,'Skipped segment continues navigation');
    f.feed('boat-01',recordingPoints[2]);for(let n=0;n<30&&f.mission.snapshot('boat-01').targetIndex!==3;n++)await wait(50);
    assert.equal(f.mission.snapshot('boat-01').targetIndex,3);f.feed('boat-01',recordingPoints[3]);
    for(let n=0;n<30&&f.mission.snapshot('boat-01').status!=='completed';n++)await wait(50);assert.equal(f.mission.snapshot('boat-01').status,'completed');
    await send('Page.navigate',{url:base+'/#missions'});await until('window.BoatMissions?.deviceId==="boat-01"&&window.BoatMissionTracks?.track?.status==="completed"&&BoatMissions.map?.ready');
    assert.deepEqual(await evaluate('BoatMissionTracks.track.chunks.map(c=>c.segmentIndex)'),[0,2]);
    await evaluate('BoatMissions.load('+JSON.stringify(recordingRouteId)+');document.getElementById("missionTrackFit").click()');
    assert.equal(await evaluate('BoatMissions.map._lineOverlays.get("mission-recording").lines.length'),2,'Skipped leg never gets a bridge line');
    await evaluate('BoatWorkspace.navigate("navigation",{focus:false})');await until('boatMonitor.map.ready&&boatMonitor.map._lineOverlays.has("mission-recording")');
    assert.equal(await evaluate('boatMonitor.map.lastTrackLines.length'),0,'Dedicated recording hides full telemetry path while selected');
    assert.match(await evaluate('document.getElementById("trackStatus").textContent'),/任务分段实测轨迹/);
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("missionQueueNew").click();document.getElementById("missionQueueRoute").value='+JSON.stringify(recordingRouteId)+';document.getElementById("missionQueueAdd").click();document.getElementById("missionQueueEdit").click()');
    await evaluate('(()=>{const s=document.querySelectorAll("[data-queue-segment-record]")[0];s.value="skip";s.dispatchEvent(new Event("change"));})();document.getElementById("missionQueueSave").click()');
    await until('BoatMissionQueue.queue.id&&!BoatMissionQueue.dirty&&!BoatMissions.busy');
    assert.equal(await evaluate('BoatMissionQueue.queue.routes[0].segments[0].record'),false);assert.equal(f.store.get('boat-01',recordingRouteId).segments[0].record,undefined,'Private group recording edits never change source route');
    f.feed('boat-01',ORIGIN);await until('!document.getElementById("missionQueueStartRecord").disabled');
    await evaluate('document.getElementById("missionQueueStartRecord").click()');await until('BoatMissions.run()?.status==="running"&&BoatMissions.run()?.recordTrack===true');
    await evaluate('document.getElementById("missionQueueStop").click()');await until('BoatMissions.run()?.status==="stopped"');
    await evaluate('document.getElementById("missionTrackSelect").value='+JSON.stringify(recordingId)+';document.getElementById("missionTrackSelect").dispatchEvent(new Event("change"))');await until('BoatMissionTracks.track?.id==='+JSON.stringify(recordingId));
    await evaluate('document.getElementById("themeToggle").click()');
    for(const width of [1440,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await wait(120);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'Recording controls fit '+width);
      await evaluate('document.getElementById("missionTrackCard").scrollIntoView({block:"center",behavior:"instant"})');await shot('mission-recording-'+width);
    }
    console.log('PASS: recording selectors, line/curve attribute independence, real start-and-record buttons, headless server recording, skipped legs, persisted playback, map overlays, private group settings and 320/375/1440px layouts.');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.navigation.selectMode("auto");document.getElementById("driverQueueSettings").click()');
    assert.equal(await evaluate('document.getElementById("driverQueueDialog").open'),true);
    await evaluate('BoatAuth.logout()');await evaluate('BoatAuth.login("observer","browser-guest-test-only")');await until('BoatAuth.user?.role==="guest"');
    assert.equal(await evaluate('!document.getElementById("driverQueueDialog").open&&document.getElementById("view-missions").contains(document.getElementById("missionQueueCard"))'),true,'Losing driving rights closes group settings and restores the shared editor');
    assert.equal(await evaluate('document.getElementById("view-missions").hidden&&document.getElementById("view-driving").hidden&&document.getElementById("missionActiveBar").hidden'),true,'Guest cannot see task, driver or global task interface');
    assert.equal(await evaluate('BoatMissions.routes.length===0&&BoatMissions.queues.length===0&&BoatMissions.runs.length===0&&BoatMissionQueue.queue.routeIds.length===0'),true,'Role change clears private task and queue UI state');
    await evaluate('BoatMissions.poll(true)');assert.equal(await evaluate('BoatMissions.routes.length'),0,'Guest does not poll or repopulate the task interface');
    assert.deepEqual(errors,[]);console.log(process.argv.includes('--recording-only')?'PASS: recording browser checks, responsive layouts and guest permission cleanup.':'PASS: real Chrome algorithm selection/MCU rejection/PID return and 320/375/1440px settings; LQR missions; actual map clicks and return-leg preview; loop persistence/reload; goto; MCU ACK and two loops; page closure/reopen; driving Space stop; guest permissions; dark/light responsive layouts.');
  }finally{socket?.close();browser.kill();server.closeAllConnections?.();await f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
