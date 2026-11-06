/* 真实 Chrome / Leaflet 旋转：底图使用本地替身，高德通过公开 API 模拟。 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {withServer,startTelemetry,login}=require('./amap-browser.cjs');
const N=require('../public/utils/missionNavigation'),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const dir=fs.mkdtempSync(path.resolve(__dirname,'../.test-output/map-rotation-'));
  await withServer({BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only',
    BOAT_AMAP_KEY:'a'.repeat(32),BOAT_AMAP_SECURITY_CODE:'b'.repeat(32),BOAT_TIANDITU_KEY:'c'.repeat(32),
    BOAT_MISSION_FILE:path.join(dir,'missions.json')},'satellite',async context=>{
    const {evaluate,until,send,viewportShot}=context;
    const click=async selector=>{
      await until('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');if(!n||n.disabled)return false;const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.width>0&&r.height>0&&(hit===n||n.contains(hit));})()');
      const point=await evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    };
    const drag=async(selector,dx,dy,beforeDrop)=>{
      const start=await evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
      for(let i=1;i<=8;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+dx*i/8,y:start.y+dy*i/8,button:'left',buttons:1});await wait(20);}
      if(beforeDrop)await beforeDrop();
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x+dx,y:start.y+dy,button:'left',buttons:0,clickCount:1});await wait(70);return {x:start.x+dx,y:start.y+dy};
    };
    await login(context,'operator','browser-admin-test-only');await until('boatMonitor.map.ready');await startTelemetry(context);
    await evaluate('document.getElementById("trackStart").click();document.getElementById("mapFollow").checked=false;BoatWorkspace.navigate("navigation",{focus:false});void boatMonitor.map.setZoom(18);');
    const track=await evaluate('boatMonitor.track.segments');
    for(const provider of ['amap','osm','arcgis','tianditu']){
      await evaluate('boatMonitor.map.switchProvider('+JSON.stringify(provider)+')');await until('!boatMonitor.map.switching');
      await evaluate('feedTelemetry();document.getElementById("map").scrollIntoView({block:"center",behavior:"instant"})');await wait(120);
      const before=await evaluate('({center:boatMonitor.map.getCenter(),zoom:boatMonitor.map.getZoom()})');
      await click('#navigation [data-map-rotation="right"]');
      assert.equal(await evaluate('boatMonitor.map.getRotation()'),15,provider+' supports a real rotation button');
      await evaluate('void boatMonitor.map.setRotation(73)');
      const sample=await evaluate('(()=>{const m=boatMonitor.map,marker=boatMonitor.mapVectors.marker,fix=marker.position,el=marker.getElement(),r=el.getBoundingClientRect(),box=m.container.getBoundingClientRect(),p=m.latLngToContainerPoint(fix),g=el.querySelector("[data-vector=actual]"),heading=Number(g.dataset.bearing),tip=m.latLngToContainerPoint(BoatModules.missionNavigation.destination(fix,heading,100)),screen=(Math.atan2(tip.x-p.x,-(tip.y-p.y))*180/Math.PI+360)%360;return {anchorError:Math.hypot(r.left-box.left-p.x,r.top-box.top-p.y),screen,arrow:Number(g.getAttribute("transform").match(/rotate\\(([^)]+)\\)/)[1]),center:m.getCenter(),zoom:m.getZoom(),boat:document.querySelector("#map .boat-pin span").style.transform};})()');
      assert.ok(sample.anchorError<2,provider+' retains the vector anchor: '+sample.anchorError);
      assert.ok(Math.abs(N.angleError(sample.screen,sample.arrow))<1,provider+' vector points along its geographic direction');
      assert.ok(Math.abs(N.angleError(Number(sample.boat.match(/rotate\(([^)]+)deg\)/)[1]),359+73))<.01,provider+' ship bow keeps the fixture RTK heading of 359 degrees relative to the map');
      assert.ok(N.distance(sample.center,before.center)<.1,provider+' keeps the same center: '+JSON.stringify({before:before.center,after:sample.center,distance:N.distance(sample.center,before.center)}));assert.equal(sample.zoom,before.zoom);
      await click('#navigation [data-map-rotation="reset"]');assert.equal(await evaluate('boatMonitor.map.getRotation()'),0);
      assert.deepEqual(await evaluate('boatMonitor.track.segments'),track,'Rotation never records additional track points');
    }
    await evaluate('boatMonitor.map.setRotation(40);boatMonitor.map.switchProvider("arcgis")');assert.equal(await evaluate('boatMonitor.map.getRotation()'),40,'Switching base layers retains rotation');
    await click('#navigation [data-map-rotation="reset"]');
    const gesture=await evaluate('(()=>{const r=boatMonitor.map.container.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,zoom:boatMonitor.map.getZoom()};})()');
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:gesture.x,y:gesture.y,deltaX:0,deltaY:120,modifiers:8});
    await until('boatMonitor.map.getRotation()!==0');assert.equal(await evaluate('boatMonitor.map.getZoom()'),gesture.zoom,'Shift wheel rotates without zooming');
    await click('#navigation [data-map-rotation="reset"]');
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
    const fingers=angle=>[1,-1].map((sign,index)=>({x:gesture.x+sign*45*Math.cos(angle),y:gesture.y+sign*45*Math.sin(angle),id:index+1}));
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:fingers(0)});
    for(let i=1;i<=8;i++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:fingers(Math.PI/4*i/8)});await wait(20);}
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(150);
    assert.ok(Math.abs(N.angleError(await evaluate('boatMonitor.map.getRotation()'),0))>20,'Two fingers rotate the actual map');
    assert.equal(await evaluate('boatMonitor.map.map.getPitch()'),0,'Rotation keeps the ground plane flat');
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await click('#navigation [data-map-rotation="reset"]');assert.deepEqual(await evaluate('boatMonitor.track.segments'),track);
    await evaluate('BoatWorkspace.navigate("fleet",{focus:false})');await until('boatMonitor.fleetMapView.map?.ready');
    await evaluate('document.querySelector("#fleetMap [data-map-rotation=left]").click()');assert.equal(await evaluate('boatMonitor.fleetMapView.map.getRotation()'),345);
    await evaluate('BoatWorkspace.navigate("missions",{focus:false})');await until('BoatMissions.map?.ready&&BoatMissions.deviceId');
    await evaluate('document.getElementById("missionNew").click();document.getElementById("missionEdit").click();BoatMissions.map.setView({latitude:31.23,longitude:121.47},18,{animate:false});BoatMissions.map.setRotation(60);document.getElementById("missionMap").scrollIntoView({block:"center",behavior:"instant"})');await wait(100);
    const points=[{latitude:31.23,longitude:121.47},N.destination({latitude:31.23,longitude:121.47},0,35)];
    for(const point of points){
      const location=await evaluate('(()=>{const m=document.getElementById("missionMap"),p=BoatMissions.map.latLngToContainerPoint('+JSON.stringify(point)+'),r=m.getBoundingClientRect();return {x:r.left+m.clientLeft+p.x,y:r.top+m.clientTop+p.y};})()');
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...location,button:'left',clickCount:1});
    }
    assert.equal(await evaluate('BoatMissions.route.points.length'),2);
    // 18 级每像素约半米；Leaflet 投影及浏览器鼠标事件均有像素取整。
    const original=await evaluate('BoatMissions.route.points');for(let i=0;i<2;i++)assert.ok(N.distance(original[i],points[i])<1,'Rotated map click returns the intended WGS84 coordinate: '+JSON.stringify({i,actual:original[i],expected:points[i],distance:N.distance(original[i],points[i])}));
    const drop=await drag('#missionMap .mission-pin span[data-kind=end]',24,-18);
    const actual=await evaluate('(()=>{const m=document.getElementById("missionMap"),p=BoatMissions.map.latLngToContainerPoint(BoatMissions.route.points[1]),r=m.getBoundingClientRect();return {x:r.left+m.clientLeft+p.x,y:r.top+m.clientTop+p.y};})()');
    assert.ok(Math.hypot(drop.x-actual.x,drop.y-actual.y)<2,'Dragged waypoint stays at the actual pointer under rotation');
    const after=await evaluate('BoatMissions.route.points');
    await drag('#missionMap .mission-pin span[data-kind=end]',12,12,async()=>evaluate('void BoatMissions.map.setRotation(90)'));
    assert.deepEqual(await evaluate('BoatMissions.route.points'),after,'Changing rotation cancels an incomplete drag');
    const count=after.length;await click('#missionMap [data-map-rotation="reset"]');assert.equal(await evaluate('BoatMissions.route.points.length'),count,'Reset click cannot add a waypoint');
    await evaluate('document.getElementById("missionName").value="旋转地图测试";document.getElementById("missionName").dispatchEvent(new Event("input"));document.getElementById("missionSave").click()');
    await until('BoatMissions.route.id&&!BoatMissions.busy&&!BoatMissions.dirty');
    await evaluate('document.getElementById("missionQueueNew").click();document.getElementById("missionQueueRoute").value=BoatMissions.route.id;document.getElementById("missionQueueAdd").click();document.getElementById("missionQueueMap").scrollIntoView({block:"center",behavior:"instant"})');
    await until('BoatMissionQueue.preview.map?.ready');await evaluate('BoatMissionQueue.preview.map.setRotation(45);BoatMissionQueue.preview.fit();document.getElementById("missionQueueEdit").click()');await wait(150);
    const source=await evaluate('BoatMissions.route.points');await drag('#missionQueueMap .mission-queue-pin[title*="航点 2"]',18,-12);
    assert.notDeepEqual(await evaluate('BoatMissionQueue.queue.routes[0].points'),source);assert.deepEqual(await evaluate('BoatMissions.route.points'),source,'Rotated group editing keeps the source route independent');
    await evaluate('document.querySelector("#missionQueueMap [data-map-rotation=reset]").click()');assert.equal(await evaluate('BoatMissionQueue.preview.map.getRotation()'),0);
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');
    for(const theme of ['dark','light']){
      await evaluate('document.documentElement.dataset.theme==="'+theme+'"||document.getElementById("themeToggle").click()');
      for(const [width,height]of [[1440,1000],[375,812],[320,667]]){
        await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
        for(const focus of ['video','map']){
          await evaluate('boatMonitor.driver.setMediaFocus("'+focus+'");void boatMonitor.map.setRotation(35)');await wait(120);
          const controls=await evaluate('(()=>{const map=boatMonitor.map.container.getBoundingClientRect(),buttons=[...document.querySelectorAll("#navigation .boat-map-rotation button")];return {map:map.toJSON(),overflow:document.documentElement.scrollWidth>innerWidth+1,buttons:buttons.map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {rect:r.toJSON(),hit:hit?.className,accessible:r.width>0&&r.height>=28&&r.left>=map.left&&r.right<=map.right+1&&r.top>=map.top&&r.bottom<=map.bottom&&(hit===n||n.contains(hit))};})};})()');
          await viewportShot('map-rotation-driver-'+width+'-'+focus+'-'+theme);
          assert.ok(controls.buttons.length===3&&controls.buttons.every(n=>n.accessible)&&!controls.overflow,'Rotation buttons remain accessible in '+width+' '+focus+' '+theme+': '+JSON.stringify(controls));
          await click('#navigation [data-map-rotation="reset"]');assert.equal(await evaluate('boatMonitor.map.getRotation()'),0);
          await viewportShot('map-rotation-driver-'+width+'-'+focus+'-'+theme);
        }
      }
    }
    await evaluate('BoatWorkspace.navigate("navigation",{focus:false});boatMonitor.map.setRotation(120);window.rotationBeforeReload=true');await send('Page.reload');
    await until('!window.rotationBeforeReload&&window.boatMonitor?.map?.ready');assert.equal(await evaluate('boatMonitor.map.getRotation()'),0,'A fresh page starts facing north');
    console.log('PASS: four map providers rotate/reset with correct WGS84 anchors and geographic arrows, unchanged raw tracks/viewport, layer switching, fleet/planning/group maps, rotated click/drag isolation and 320/375/1440px driving controls in both themes.');
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
