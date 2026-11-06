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
    await evaluate('BoatMissions.load('+JSON.stringify(routeId)+');document.getElementById("mapMissionToggle").click()');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&!boatMonitor.map._lineOverlays.has("mission")'),true);
    assert.equal(f.mission.active('boat-01'),true,'Hiding the route never stops the mission');
    await send('Page.reload');
    await until('window.boatMonitor?.mapMission&&window.BoatMissions?.run()?.status==="running"&&BoatMissions.routes.length>0&&boatMonitor.map.ready');
    assert.equal(await evaluate('BoatWorkspace.current'), 'navigation');
    assert.equal(await evaluate('boatMonitor.mapMission.visible'),false,'Refresh preserves the hidden preference');
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length'),0);
    await evaluate('document.getElementById("mapMissionToggle").click();document.getElementById("mapFollow").checked=false');
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
    assert.equal(await evaluate('boatMonitor.mapMission.markers.length===0&&!boatMonitor.map._lineOverlays.has("mission")&&document.getElementById("mapMissionToggle").hidden&&document.getElementById("mapMissionInfo").hidden'),true,'Guest cannot retain the private mission overlay');
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
    await evaluate('BoatWorkspace.navigate("missions",{focus:false});document.getElementById("themeToggle").click()');
    for(const [width,height]of [[1440,1100],[1024,900],[375,812],[320,812]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(100);
      await evaluate('BoatMissions.map.invalidateSize();BoatMissions.fit()');await wait(120);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true,'No horizontal overflow at '+width);
      assert.equal(await evaluate('document.getElementById("missionMap").getBoundingClientRect().height>=300'),true);
      await evaluate('document.getElementById("view-missions").scrollIntoView({block:"start",behavior:"instant"})');await shot('missions-'+width+'-light');
    }
    await evaluate('BoatAuth.logout()');await evaluate('BoatAuth.login("observer","browser-guest-test-only")');await until('BoatAuth.user?.role==="guest"');
    assert.equal(await evaluate('document.getElementById("view-missions").hidden&&document.getElementById("view-driving").hidden&&document.getElementById("missionActiveBar").hidden'),true,'Guest cannot see task, driver or global task interface');
    assert.equal(await evaluate('BoatMissions.routes.length===0&&BoatMissions.runs.length===0'),true,'Role change clears private task UI state');
    await evaluate('BoatMissions.poll(true)');assert.equal(await evaluate('BoatMissions.routes.length'),0,'Guest does not poll or repopulate the task interface');
    assert.deepEqual(errors,[]);console.log('PASS: real Chrome algorithm selection/MCU rejection/PID return and 320/375/1440px settings; LQR missions; actual map clicks and return-leg preview; loop persistence/reload; goto; MCU ACK and two loops; page closure/reopen; driving Space stop; guest permissions; dark/light responsive layouts.');
  }finally{socket?.close();browser.kill();server.closeAllConnections?.();await f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
