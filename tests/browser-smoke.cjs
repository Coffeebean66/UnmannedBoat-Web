/* 真浏览器集成检查：真实页面/WebGL/协议与本地 MQTT HTTP/SSE，不连接电机。 */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {createFixtureServer,fixtureScript:mock}=require('./mqtt-browser-fixture.cjs');
const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  // 默认烟测固定验证无 Key 回退，避免开发机环境变量意外触发真实 SDK 请求。
  const server=createFixtureServer();server.mqttFixture.running=false;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile=fs.mkdtempSync(path.join(output,'chrome-')),errors=[];
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    socket.onmessage=event=>{
      const m=JSON.parse(event.data);
      if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
      if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const until=async expr=>{for(let i=0;i<100;i++){if(await evaluate(expr))return;await wait(50);}throw Error('Condition timed out: '+expr+'\n'+errors.join('\n'));};
    const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
    const viewportShot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
    const mapShot=async name=>{
      const clip=await evaluate("(()=>{const r=document.querySelector('.map-stage').getBoundingClientRect();return {x:scrollX+r.left,y:scrollY+r.top,width:r.width,height:r.height,scale:1};})()");
      const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));
    };
    const sensorShot=async name=>{
      const clip=await evaluate("(()=>{const r=document.querySelector('.telemetry-card').getBoundingClientRect();return {x:scrollX+r.left,y:scrollY+r.top,width:r.width,height:r.height,scale:1};})()");
      const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));
    };
    const deviceShot=async name=>{
      const clip=await evaluate("(()=>{const r=document.getElementById('deviceSummary').getBoundingClientRect();return {x:scrollX+r.left,y:scrollY+r.top,width:r.width,height:r.height,scale:1};})()");
      const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));
    };
    const deviceSummary=()=>evaluate("(()=>{const text=id=>document.getElementById(id).textContent;return {state:document.getElementById('deviceSummary').dataset.state,name:text('deviceName'),source:text('sourceChip'),connection:text('deviceConnectionState'),frames:text('frameCount'),updated:text('deviceLastUpdate'),datetime:document.getElementById('deviceLastUpdate').getAttribute('datetime'),latency:text('deviceLatency')};})()");
    const views=['fleet','overview','navigation','attitude','analysis','propulsion','diagnostics','video'];
    const assertView=async id=>{
      await until('BoatWorkspace.current==='+JSON.stringify(id));
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.workspace-view[data-workspace-view]')].filter(panel=>!panel.hidden&&panel.getBoundingClientRect().width>0).map(panel=>panel.dataset.workspaceView)"),[id],'Only the selected workspace page is visible');
      assert.equal(await evaluate('location.hash'),'#'+id,'The URL identifies the selected page');
      assert.equal(await evaluate("document.querySelector('.side-nav a[aria-current=page]')?.hash"),'#'+id,'Desktop navigation identifies the active page');
      assert.equal(await evaluate("document.querySelector('.mobile-nav a[aria-current=page]')?.hash"),'#'+id,'Mobile navigation follows the same active page');
    };
    const view=async id=>{
      await evaluate("document.querySelector((innerWidth<=740?'.mobile-nav':'.side-nav')+' a[href=\"#"+id+"\"]').click()");
      await assertView(id);await wait(200);
      assert.ok(await evaluate('Math.abs(scrollY)<1'),'Page changes start at the top instead of scrolling to a content anchor');
    };
    const openSettings=async()=>{
      await view('fleet');
      const button="document.querySelector('.fleet-card[data-device-id=\"boat-mqtt-test\"] .fleet-parameter-button')";
      await until(button+' && !'+button+'.hidden && !'+button+'.disabled');
      await evaluate(button+'.click()');await until("document.getElementById('settingsDialog').open");
      assert.equal(await evaluate("document.getElementById('parameterDeviceName').textContent"),'boat-mqtt-test');
    };
    const assertDeviceCardLayout=async width=>{
      const layout=await evaluate("(()=>{const card=document.getElementById('deviceSummary'),rect=card.getBoundingClientRect();return {width:rect.width,height:rect.height,visible:getComputedStyle(card).display!=='none'&&rect.width>0,overflow:card.scrollWidth>card.clientWidth,rows:[...card.querySelectorAll('dd')].map(row=>({overflow:row.scrollWidth>row.clientWidth,right:row.getBoundingClientRect().right})),right:rect.right};})()");
      assert.equal(layout.visible,true,'Current-device card is visible on desktop at '+width);
      assert.equal(layout.overflow,false,'Current-device card has no horizontal overflow at '+width);
      assert.ok(layout.rows.every(row=>!row.overflow&&row.right<=layout.right+1),'Current-device statistics fit their card at '+width);
    };
    await send('Runtime.enable');await send('Page.enable');
    // 地图覆盖物与布局测试不依赖外网瓦片；离线提示本身也须不影响遥测。
    await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://tile.openstreetmap.org/*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:mock});await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await until('!!window.boatMonitor && !!window.boatMonitor.viewer.renderer && !!window.BoatWorkspace');assert.deepEqual(errors,[]);
    await evaluate('ensureTestLogin()');
    await assertView('fleet');
    await view('navigation');assert.equal(await evaluate('document.activeElement.id'),'viewTitle','Page navigation moves keyboard focus to the page heading');
    await view('attitude');await evaluate('history.back()');await assertView('navigation');await evaluate('history.forward()');await assertView('attitude');
    await view('overview');
    await until("boatMonitor.map?.ready && boatMonitor.map.provider==='osm'");
    await until("(()=>{const image=document.querySelector('#deviceSummary img');return image.complete&&image.naturalWidth>0;})()");
    assert.deepEqual(await deviceSummary(),{state:'waiting',name:'boat-mqtt-test',source:'MQTT',connection:'等待遥测',frames:'0',updated:'--',datetime:null,latency:'--'},'Automatic subscription cannot invent telemetry before the simulated boat actually sends it');
    assert.equal(await evaluate('navigator.bluetooth'),undefined,'The platform works without the Web Bluetooth API');
    assert.equal(await evaluate("!!document.querySelector('#telemetrySource,#notifyCharacteristic,#writeCharacteristic')"),false,'Bluetooth source and UUID controls are absent');
    assert.equal(await evaluate("performance.getEntriesByType('resource').some(entry=>/\\/transport\\.js(?:$|\\?)/.test(entry.name))"),false,'No Bluetooth transport resource loads');
    assert.match(await evaluate("document.getElementById('mapStatus').textContent"),/未配置/,'Missing AMap credentials are explained');
    assert.match(await evaluate("document.getElementById('mapStatus').textContent"),/OpenStreetMap|OSM/,'Missing AMap credentials retain the existing map');
    assert.deepEqual(await evaluate("(()=>{const h=document.getElementById('imuHorizon');return {valid:h.dataset.valid,state:h.dataset.state,roll:h.dataset.roll,pitch:h.dataset.pitch};})()"),
      {valid:'false',state:'waiting',roll:'--',pitch:'--'},'Initial neutral horizon is explicitly invalid before IMU data arrives');
    assert.equal(await evaluate("document.documentElement.dataset.theme"),'dark','Monitoring dashboard starts in dark mode');
    assert.equal(await evaluate("(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return new Set(ids).size===ids.length;})()"),true,'Dashboard element IDs remain unique after rearranging panels');
    const assertDesktopLayout=async width=>{
      const layout=await evaluate("(()=>{const map=document.querySelector('.map-stage').getBoundingClientRect(),attitude=document.querySelector('.attitude-stage').getBoundingClientRect(),panels=Object.fromEntries(['#navigation','#attitude','.telemetry-card','.map-stage'].map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect(),s=getComputedStyle(el);return [selector,{width:r.width,height:r.height,fontSize:s.fontSize,lineHeight:s.lineHeight}];}));return {map:{left:map.left,top:map.top,width:map.width,height:map.height,bottom:map.bottom},attitude:{left:attitude.left,top:attitude.top,width:attitude.width,height:attitude.height},panels,overflow:document.documentElement.scrollWidth>innerWidth};})()");
      console.log('Dashboard layout '+width+': '+JSON.stringify(layout.panels));
      assert.equal(layout.overflow,false,'Desktop page overflow at '+width);
      assert.ok(layout.map.width>layout.attitude.width*1.5,'Map remains the primary desktop panel at '+width);
      assert.ok(layout.map.width*layout.map.height>layout.attitude.width*layout.attitude.height,'Map has more display area than the attitude preview at '+width);
      assert.ok(layout.map.left+layout.map.width<=layout.attitude.left,'Map and attitude panels share the desktop row at '+width);
      assert.equal(await evaluate("document.getElementById('analysis').getBoundingClientRect().width"),0,'Detailed control charts live on their own page');
      assert.equal(await evaluate("document.getElementById('motors').getBoundingClientRect().width"),0,'Detailed motor data lives on its own page');
      await assertDeviceCardLayout(width);
    };
    await assertDesktopLayout(1440);await deviceShot('device-card-offline-1440');
    await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});await wait(300);
    await assertDesktopLayout(1920);await shot('desktop-wide-empty');await deviceShot('device-card-offline-1920');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await wait(300);
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'A ready map remains visible before the first fix');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'Waiting for a fix uses a small map hint');
    assert.match(await evaluate("document.getElementById('mapFixStatus').textContent"),/等待有效定位/);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('mapFixStatus')).pointerEvents"),'none','Fix hint never intercepts map gestures');
    assert.equal(await evaluate("!!document.querySelector('.boat-pin,.map-velocity-anchor')"),false,'No synthetic boat or vectors appear before a valid fix');
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),5,'Map keeps its existing default zoom without a fix');
    await evaluate('boatMonitor.map.setZoom(6);void 0');await until('boatMonitor.map.getZoom()===6');
    const waitingPoint=await evaluate('boatMonitor.map.latLngToContainerPoint([31.23,121.47])');
    await evaluate('boatMonitor.map.panBy([40,20],{animate:false});void 0');
    const pannedWaitingPoint=await evaluate('boatMonitor.map.latLngToContainerPoint([31.23,121.47])');
    assert.ok(Math.hypot(pannedWaitingPoint.x-waitingPoint.x,pannedWaitingPoint.y-waitingPoint.y)>10,'Map pans normally without a fix');
    await evaluate('boatMonitor.map.setView([31.23,121.47],5,{animate:false});void 0');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.parameter-group')].map(group=>group.querySelectorAll('input,select').length)"),[10,7,3]);
    assert.equal(await evaluate("new Set([...document.querySelectorAll('#parameterFields [data-key]')].map(input=>input.dataset.key)).size"),20);
    assert.equal(await evaluate("document.querySelectorAll('#presets .preset.empty').length"),3);
    await shot('desktop-empty');
    await evaluate('connectTestBoat()');await until('boatMonitor.link.connected');
    assert.equal((await deviceSummary()).name,'boat-mqtt-test','The MQTT device ID is used as the boat name');
    assert.equal((await deviceSummary()).source,'MQTT');
    assert.equal((await deviceSummary()).state,'online');
    await evaluate("window.testLatestFrames={};boatMonitor.link.addEventListener('frame',({detail})=>{if(detail.boat)testLatestFrames.boat=detail;if(detail.velocity)testLatestFrames.velocity=detail;});startTelemetry();if(!boatMonitor.track.active)document.getElementById('trackStart').click()");await wait(1200);
    await until("Number(document.getElementById('frameCount').textContent.replaceAll(',',''))===Number(document.getElementById('parsedFrames').textContent)&&Number(document.getElementById('parsedFrames').textContent)>0");
    const liveDevice=await deviceSummary();
    assert.equal(liveDevice.connection,'已连接');assert.notEqual(liveDevice.updated,'--');assert.ok(Number.isFinite(Date.parse(liveDevice.datetime)),'A live device records a machine-readable receive time');
    assert.match(liveDevice.latency,/^\d+ ms$/,'MQTT reports its server forwarding delay');
    await assertDeviceCardLayout(1440);await deviceShot('device-card-connected-1440');await shot('desktop-device-connected-1440');
    await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});await wait(300);
    await assertDeviceCardLayout(1920);await deviceShot('device-card-connected-1920');await shot('desktop-device-connected-1920');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await wait(300);
    await evaluate("window.workspaceReferences={link:boatMonitor.link,parser:boatMonitor.link.parser,map:boatMonitor.map,viewer:boatMonitor.viewer,horizon:boatMonitor.horizon,track:boatMonitor.track,canvas:document.getElementById('boatCanvas'),connectionCount:testConnections,pointCount:boatMonitor.track.pointCount,frames:boatMonitor.link.parser.getStats().framesReceived};void 0");
    const overviewMapWidth=await evaluate("document.getElementById('map').clientWidth");
    for(const id of views){
      await view(id);
      assert.equal(await evaluate('boatMonitor.link.connected&&testConnections===workspaceReferences.connectionCount'),true,'Page changes preserve the existing MQTT SSE connection');
      assert.equal(await evaluate('boatMonitor.map===workspaceReferences.map&&boatMonitor.viewer===workspaceReferences.viewer&&boatMonitor.link.parser===workspaceReferences.parser&&boatMonitor.horizon===workspaceReferences.horizon&&boatMonitor.track===workspaceReferences.track&&document.getElementById("boatCanvas")===workspaceReferences.canvas'),true,'Map, 3D canvas, parser, horizon and track are reused across pages');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Desktop page fits: '+id);
      if(id==='navigation')assert.ok(await evaluate("document.getElementById('map').clientWidth")>overviewMapWidth*1.25,'Dedicated navigation gives the map more room');
      if(id==='attitude'){
        await until('boatMonitor.viewer.visible&&boatMonitor.viewer.fresh');
        assert.ok(await evaluate("document.getElementById('boatCanvas').clientHeight")>=260,'Dedicated attitude page enlarges the 3D canvas');
      }
      if(id==='analysis')assert.ok(await evaluate("document.getElementById('chart').width")>0,'Control chart resizes when its page opens');
      if(id==='diagnostics'){
        await until('!boatMonitor.viewer.visible');const phase=await evaluate('boatMonitor.viewer.phase');await wait(180);
        assert.equal(await evaluate('boatMonitor.viewer.phase'),phase,'Hidden 3D view stops water animation');
      }
      await viewportShot('workspace-desktop-'+id);
    }
    assert.ok(await evaluate('boatMonitor.track.pointCount')>=await evaluate('workspaceReferences.pointCount'),'Navigation preserves recorded track points');
    assert.ok(await evaluate('boatMonitor.link.parser.getStats().framesReceived')>await evaluate('workspaceReferences.frames'),'Telemetry continues while switching pages');
    await view('analysis');
    assert.equal(await evaluate("document.getElementById('boatActual').textContent"),'1.552');assert.equal(await evaluate("document.getElementById('roll').textContent"),'6.00');
    assert.equal(await evaluate("document.getElementById('chartTarget').textContent"),'1.800 m/s');
    assert.equal(await evaluate("document.getElementById('chartActual').textContent"),'1.552 m/s');
    assert.equal(await evaluate("document.getElementById('chartError').textContent"),'-0.248 m/s');
    await view('overview');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Live position remains on the ready map');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),true,'A valid fix clears the waiting hint');
    assert.equal(await evaluate("document.getElementById('motor1Voltage').textContent"),'24.50');
    assert.ok(await evaluate("parseFloat(document.getElementById('motor1Dial').style.strokeDasharray)>0"));
    assert.equal(await evaluate("boatMonitor.track.segments[0][0].longitude"),121.7654321);assert.ok(await evaluate('boatMonitor.track.pointCount>=2'));
    const assertCombinedTelemetry=async()=>{
      assert.deepEqual(await evaluate("['rtkPanel','imuPanel'].map(id=>{const panel=document.getElementById(id),rect=panel.getBoundingClientRect();return !panel.hidden&&getComputedStyle(panel).display!=='none'&&rect.width>0&&rect.height>0;})"),[true,true],'RTK and IMU telemetry remain visible together without switching tabs');
      assert.equal(await evaluate("document.getElementById('rtkPanel').closest('.telemetry-card')===document.getElementById('imuPanel').closest('.telemetry-card')"),true,'Position and attitude readings share the same sensor card');
    };
    const assertImuLayout=async width=>{
      const layout=await evaluate("(()=>{const values=document.querySelector('.imu-euler-values').getBoundingClientRect(),horizon=document.getElementById('imuHorizon').getBoundingClientRect(),gyro=document.getElementById('gyroX').closest('dl').getBoundingClientRect(),svg=document.querySelector('#imuHorizon svg').getBoundingClientRect(),instruments=document.querySelector('.sensor-instruments').getBoundingClientRect(),panel=document.querySelector('.telemetry-card').getBoundingClientRect();return {values:{left:values.left,right:values.right,top:values.top,bottom:values.bottom},horizon:{left:horizon.left,right:horizon.right,top:horizon.top,bottom:horizon.bottom},gyro:{left:gyro.left,right:gyro.right,top:gyro.top,bottom:gyro.bottom},svg:{width:svg.width,height:svg.height},instruments:{left:instruments.left,right:instruments.right},panel:{left:panel.left,right:panel.right},overflow:document.documentElement.scrollWidth>innerWidth};})()");
      console.log('IMU layout '+width+': '+JSON.stringify(layout));
      assert.ok(layout.values.right<=layout.horizon.left+1,'Euler readings stay on the left of the horizon at '+width);
      assert.ok(layout.horizon.top<layout.values.bottom&&layout.horizon.bottom>layout.values.top,'Euler readings and horizon share the same row at '+width);
      assert.ok(layout.horizon.right<=layout.gyro.left+1,'Angular velocity readings stay on the right of the horizon at '+width);
      assert.ok(layout.horizon.top<layout.gyro.bottom&&layout.horizon.bottom>layout.gyro.top,'Angular velocity readings and horizon share the same row at '+width);
      assert.ok(Math.abs(layout.svg.width-layout.svg.height)<.5,'Artificial horizon retains a circular aspect at '+width);
      assert.ok(layout.svg.width>=100,'Artificial horizon remains readable at '+width);
      assert.ok(layout.gyro.right<=layout.instruments.right+1&&layout.values.left>=layout.instruments.left-1,'All three instrument columns fit the shared instrument row at '+width);
      assert.ok(layout.instruments.right<=layout.panel.right+1&&layout.instruments.left>=layout.panel.left-1,'IMU instruments fit the combined sensor card at '+width);
      assert.equal(layout.overflow,false,'IMU page has no horizontal overflow at '+width);
      assert.equal(await evaluate("[...document.querySelectorAll('.imu-euler-values dd')].every(row=>row.scrollWidth<=row.clientWidth&&row.lastElementChild.getBoundingClientRect().right<=row.getBoundingClientRect().right+1)"),true,'Euler numbers and degree units fit their left column at '+width);
    };
    const override=async values=>{await evaluate('window.telemetryOverrides='+JSON.stringify(values)+';feedTelemetry()');await wait(230);};
    const horizonPose=()=>evaluate("(()=>{const host=document.getElementById('imuHorizon');return {valid:host.dataset.valid,state:host.dataset.state,roll:host.querySelector('.ah-roll-disc').getAttribute('transform'),pitch:host.querySelector('.ah-pitch-disc').getAttribute('transform')};})()");
    await assertCombinedTelemetry();await assertImuLayout(1440);await shot('desktop-imu');await sensorShot('desktop-sensors');
    await override({roll:13,pitch:9,yaw:45});
    assert.deepEqual(await horizonPose(),{valid:'true',state:'live',roll:'rotate(-13 120 120)',pitch:'translate(0 -18)'},'Live horizon follows the X-forward/Y-left/Z-up roll and pitch convention');
    assert.deepEqual(await evaluate("['roll','pitch','yaw'].map(id=>document.getElementById(id).textContent)"),['13.00','9.00','45.00'],'Left column shows live roll, pitch and yaw');
    const beforeYaw=await horizonPose();await override({roll:13,pitch:9,yaw:-145});
    assert.deepEqual(await horizonPose(),beforeYaw,'Yaw changes update the number without rotating the artificial horizon');
    assert.equal(await evaluate("document.getElementById('yaw').textContent"),'-145.00');
    await override({roll:16,pitch:8,yaw:-21,imuFlags:95});
    assert.equal((await horizonPose()).valid,'true','Fresh Euler angles remain usable when only the gyro validity bit is clear');
    assert.equal(await evaluate("document.getElementById('gyroX').textContent"),'--');
    const lastValid=await horizonPose();
    await override({roll:-20,pitch:-15,imuFlags:63});
    assert.deepEqual(await horizonPose(),{...lastValid,valid:'false',state:'stale'},'Invalid Euler angles freeze the last valid disc');
    assert.equal(await evaluate("document.getElementById('roll').textContent"),'--');
    assert.match(await evaluate("document.querySelector('#imuHorizon .ah-status').textContent"),/欧拉角无效.*保持最后姿态/);
    await override({roll:-35,pitch:-25,imuAge:1000});
    assert.deepEqual(await horizonPose(),{...lastValid,valid:'false',state:'stale'},'Expired source data cannot overwrite the last valid pose');
    assert.match(await evaluate("document.querySelector('#imuHorizon .ah-status').textContent"),/过期.*保持最后姿态/);
    await override({roll:-179.99,pitch:-89.99,yaw:-179.99});await assertImuLayout(1440);
    await override({});const beforeMissingImu=await horizonPose();
    await override({skipImu:true});await wait(1100);
    assert.deepEqual(await horizonPose(),{...beforeMissingImu,valid:'false',state:'stale'},'A missing IMU stream expires while other telemetry continues');
    assert.notEqual(await evaluate("document.getElementById('longitude').textContent"),'--','Fresh RTK position remains available while the IMU stream is stale');
    await assertCombinedTelemetry();
    await override({});
    await assertCombinedTelemetry();
    const vector=kind=>"document.querySelector('.map-velocity-anchor [data-vector=\""+kind+"\"]')";
    await until(vector('target')+" && getComputedStyle("+vector('target')+").display!=='none'");
    assert.equal(await evaluate("document.querySelector('.map-velocity-vectors').getBoundingClientRect().width"),264,'Map SVG retains its own size instead of the 19px UI icon size');
    assert.equal(await evaluate("(()=>{const icon=document.querySelector('.map-velocity-anchor').getBoundingClientRect(),svg=document.querySelector('.map-velocity-vectors').getBoundingClientRect();return Math.abs(svg.left+svg.width/2-icon.left)<1&&Math.abs(svg.top+svg.height/2-icon.top)<1;})()"),true,'Velocity arrows start at the boat anchor');
    assert.equal(await evaluate(vector('target')+'.dataset.bearing'),'1');
    assert.ok(Math.abs(await evaluate('Number('+vector('actual')+'.dataset.bearing)')-75.06858282186246)<1e-8,'Actual direction follows east/north speed, not bow heading');
    assert.ok(Math.abs(await evaluate('Number('+vector('actual')+'.dataset.length)')-Math.hypot(1.5,.4)*28)<1e-8);
    await evaluate("document.getElementById('mapVectorsToggle').click()");await until("!document.querySelector('.map-velocity-anchor')");
    assert.equal(await evaluate("document.getElementById('mapVectorsToggle').getAttribute('aria-pressed')"),'false');
    assert.equal(await evaluate("document.getElementById('mapVectorReadouts').hidden"),true);
    await evaluate("document.getElementById('mapVectorsToggle').click()");await until("!!document.querySelector('.map-velocity-anchor')");
    await override({target:.5});const shortLength=await evaluate('Number('+vector('target')+'.dataset.length)');
    await override({target:2});assert.ok(await evaluate('Number('+vector('target')+'.dataset.length)')>shortLength,'Higher target speed produces a longer arrow');
    await override({target:-2,mode:1});assert.equal(await evaluate(vector('target')+'.dataset.bearing'),'179','Reverse in speed mode rotates true bow heading by 180 degrees');
    await override({target:-2,targetHeading:90});assert.equal(await evaluate(vector('target')+'.dataset.bearing'),'270','Reverse in angle mode rotates the target heading');
    await override({target:1.5,targetHeading:90,x:1.5,y:0});
    assert.equal(await evaluate(vector('target')+'.dataset.length'),await evaluate(vector('actual')+'.dataset.length'));
    assert.ok(await evaluate('parseFloat(getComputedStyle('+vector('target')+".querySelector('.vector-shaft')).strokeWidth)>parseFloat(getComputedStyle("+vector('actual')+".querySelector('.vector-halo')).strokeWidth)"),'Coincident arrows retain visible target edges');
    await mapShot('map-vectors-overlap');
    await override({target:0,x:0,y:0});
    try{
      await until("['target','actual'].every(kind=>document.querySelector('.map-velocity-anchor [data-vector=\"'+kind+'\"]')?.dataset.speed==='0')");
      for(const kind of ['target','actual']){
        assert.equal(await evaluate('getComputedStyle('+vector(kind)+".querySelector('circle')).display!=='none'"),true,'Zero speed shows a point');
        assert.equal(await evaluate('getComputedStyle('+vector(kind)+".querySelector('.vector-shaft')).display"),'none');
      }
    }catch(error){
      console.error('Zero-speed diagnostics: '+JSON.stringify(await evaluate("({hidden:document.hidden,overrides:telemetryOverrides,latest:testLatestFrames,lastView:boatMonitor.mapVectors.lastView,svg:document.querySelector('.map-velocity-vectors')?.outerHTML,parser:boatMonitor.link.parser.getStats()})"),null,2));
      throw error;
    }
    await override({rtkFlags:13});
    assert.equal(await evaluate('getComputedStyle('+vector('actual')+").display"),'none','Invalid RTK velocity removes actual arrow');
    assert.equal(await evaluate('getComputedStyle('+vector('target')+").display!=='none'"),true);
    await override({mode:1,headingFlags:2,rtkFlags:11});
    assert.equal(await evaluate('getComputedStyle('+vector('target')+").display"),'none','Missing true heading removes target independently');
    assert.equal(await evaluate('getComputedStyle('+vector('actual')+").display!=='none'"),true);
    await override({mode:0});assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Open loop hides both arrows');
    await override({rtkFlags:14});assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Invalid fix hides both arrows');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Invalid fix does not cover the ready map');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'Invalid fix is explained by the corner hint');
    await override({});
    await evaluate("document.getElementById('mapFollow').checked=false;boatMonitor.map.panBy([40,20],{animate:false});boatMonitor.map.setZoom(17,{animate:false});void 0");
    assert.equal(await evaluate("(()=>{const el=boatMonitor.mapVectors.marker.getElement().getBoundingClientRect(),rect=document.getElementById('map').getBoundingClientRect(),point=boatMonitor.map.latLngToContainerPoint(boatMonitor.mapVectors.marker.getLatLng());return Math.abs(el.left-rect.left-point.x)<1&&Math.abs(el.top-rect.top-point.y)<1;})()"),true,'Arrows stay anchored to the boat through pan and zoom');
    await evaluate("document.getElementById('mapFollow').checked=true;boatMonitor.map.setZoom(16,{animate:false});void 0");
    for(const source of ['skipBoat','skipVelocity']){
      await until("!!document.querySelector('.map-velocity-anchor')");
      await override({[source]:true});
      // 超时由 200 ms 的渲染周期更新，等待实际清除而非卡在 1 秒边界附近。
      await until("!document.querySelector('.map-velocity-anchor')");
      assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,source+' expires without reusing a stale vector');
      await override({});
    }
    await shot('desktop-speed');
    await mapShot('map-vectors-directions');
    await view('analysis');
    const canvasPixel="[...document.getElementById('chart').getContext('2d').getImageData(0,0,1,1).data]";
    assert.deepEqual(await evaluate(canvasPixel),[25,25,30,255]);
    await evaluate("document.getElementById('themeToggle').click()");
    assert.equal(await evaluate("document.documentElement.dataset.theme"),'light');
    assert.deepEqual(await evaluate(canvasPixel),[255,255,255,255]);
    await shot('desktop-light');
    await view('overview');
    await assertCombinedTelemetry();await assertImuLayout(1440);await shot('light-imu');await sensorShot('light-sensors');
    await evaluate("document.getElementById('themeToggle').click()");
    await openSettings();await until("!document.getElementById('readParameters').disabled");
    await evaluate("document.getElementById('readParameters').click()");await until('!!boatMonitor.params.confirmed && !boatMonitor.params.busy');
    assert.equal(await evaluate("document.getElementById('parameterStatus').dataset.tone"),'success');
    assert.equal(await evaluate("document.getElementById('toast').parentElement.id"),'settingsDialog');
    assert.equal(await evaluate("document.querySelector('[data-key=kpX2PerMps]').value"),'80');
    await evaluate("document.querySelector('[data-key=kpX2PerMps]').value='91';document.getElementById('saveFlash').click()");await wait(100);assert.equal(await evaluate('lastCommand'),0x10);
    await evaluate("document.getElementById('writeParameters').click()");await until('!boatMonitor.params.busy && boatMonitor.params.confirmed.kpX2PerMps===91');
    await evaluate("document.querySelector('[data-slot=\"0\"][data-action=\"save\"]').click()");await until('!!boatMonitor.params.slots[0]');
    assert.equal(await evaluate("document.querySelectorAll('#presets .preset.saved').length"),1);
    await evaluate("replyStatus=3;document.getElementById('saveFlash').click()");await until("!boatMonitor.params.busy && document.getElementById('parameterStatus').textContent.includes('CH6')");
    assert.equal(await evaluate("document.getElementById('parameterStatus').dataset.tone"),'warning');
    await evaluate("replyStatus=0;document.getElementById('saveFlash').click()");await until("document.getElementById('parameterStatus').textContent.includes('下次上电')");
    await evaluate("suppressReply=true;document.getElementById('readParameters').click()");await until("document.getElementById('parameterStatus').textContent.includes('超时')");
    assert.equal(await evaluate("document.getElementById('parameterStatus').dataset.tone"),'warning');
    await evaluate("suppressReply=false;document.getElementById('readParameters').click()");await until("!boatMonitor.params.busy && document.getElementById('parameterStatus').textContent.includes('读取成功')");
    await evaluate("document.querySelector('[data-slot=\"0\"][data-action=\"use\"]').click()");await until("!boatMonitor.params.busy && document.getElementById('parameterStatus').textContent.includes('写入成功')");
    await shot('desktop-settings');
    await evaluate("document.getElementById('presets').scrollIntoView({behavior:'instant',block:'center'})");await shot('desktop-presets');
    await evaluate("document.getElementById('settingsClose').click()");await view('analysis');await evaluate("document.getElementById('chartModeButton').click()");
    await until("document.getElementById('chartActual').textContent==='359.00°'");
    assert.equal(await evaluate("document.getElementById('chartTarget').textContent"),'1.00°');
    assert.equal(await evaluate("document.getElementById('chartError').textContent"),'2.00°');
    await shot('desktop-live');
    await view('attitude');await evaluate("document.getElementById('boatCanvas').scrollIntoView();document.getElementById('animationEnabled').click()");
    const frozen=await evaluate('boatMonitor.viewer.phase');await wait(300);assert.equal(await evaluate('boatMonitor.viewer.phase'),frozen);
    await evaluate("document.getElementById('quality').value='low';document.getElementById('quality').dispatchEvent(new Event('change'))");await shot('desktop-attitude');
    await evaluate('stopTelemetry()');await wait(1400);
    await view('analysis');
    for(const id of ['boatActual','roll','motor1Rpm'])assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),'--');
    assert.equal(await evaluate("document.getElementById('chartActual').textContent"),'359.00°','Offline curves retain their final recorded values');
    assert.equal(await evaluate("document.getElementById('chartTarget').textContent"),'1.00°');
    assert.equal(await evaluate("document.getElementById('chartError').textContent"),'2.00°');
    assert.match(await evaluate("document.getElementById('chartHistoryState').textContent"),/最后记录/,'Retained curves are explicitly historical');
    assert.equal(await evaluate("parseFloat(document.getElementById('motor1Dial').style.strokeDasharray)"),0);
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Expired position retains the recorded track for review');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'Expired position shows a non-blocking fix hint');
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Stale telemetry removes velocity arrows');
    for(const width of [1024,768,640,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:true});await evaluate('window.scrollTo(0,0)');await wait(300);
      for(const id of views){
        await view(id);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Workspace '+id+' fits '+width+'px');
        if(width===375||width===320)await viewportShot('workspace-mobile-'+width+'-'+id);
      }
      await view('overview');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Page overflow at '+width);await shot('mobile-'+width);
      await openSettings();await evaluate("document.querySelector('#settingsDialog .dialog-scroll').scrollTop=0");
      assert.equal(await evaluate("document.getElementById('settingsDialog').scrollWidth<=document.getElementById('settingsDialog').clientWidth"),true);await shot('mobile-settings-'+width);
      await evaluate("document.getElementById('presets').scrollIntoView({behavior:'instant',block:'center'})");
      assert.equal(await evaluate("document.querySelector('.dialog-scroll').scrollWidth<=document.querySelector('.dialog-scroll').clientWidth"),true,'Settings content overflow at '+width);await shot('mobile-presets-'+width);
      await evaluate("document.getElementById('settingsClose').click();startTelemetry()");await view('overview');await wait(250);await shot('mobile-live-'+width);
      assert.ok(await evaluate('Number('+vector('target')+'.dataset.length)')>0,'Velocity arrows visible at '+width);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Live page overflow at '+width);
      await view('attitude');await evaluate("document.getElementById('imuPanel').scrollIntoView({block:'center',behavior:'instant'})");
      if(width===375||width===320)assert.ok(await evaluate("(()=>{const r=document.getElementById('boatCanvas').getBoundingClientRect();return r.width/r.height>=1.5;})()"),'Mobile 3D camera keeps a landscape viewport so the full boat remains in frame at '+width);
      await assertCombinedTelemetry();await assertImuLayout(width);
      if(width===375||width===320){await viewportShot('mobile-imu-'+width);await sensorShot('mobile-sensors-'+width);}
      await override({roll:-179.99,pitch:-89.99,yaw:-179.99});await assertImuLayout(width);
      if(width===375||width===320){
        await viewportShot('mobile-imu-extreme-'+width);
        await override({skipImu:true});
        await until("document.querySelector('#imuHorizon .ah-status').textContent.includes('过期')");
        assert.equal(await evaluate("(()=>{const status=document.querySelector('#imuHorizon .ah-status');return status.scrollWidth<=status.clientWidth;})()"),true,'Long stale IMU status wraps without clipping at '+width);
        await assertImuLayout(width);await viewportShot('mobile-imu-stale-'+width);
      }
      await override({});
      if(width===375||width===320){
        // 上面的 IMU 面板滚动可能仍让 3D 局部可见，先离屏再验证重新进入视口的恢复绘制。
        await view('diagnostics');
        await until('!boatMonitor.viewer.visible');
        assert.equal(await evaluate('boatMonitor.viewer.settings.animation'),false,'Mobile viewport restores a frame while animation remains paused');
        await evaluate("(()=>{const renderer=boatMonitor.viewer.renderer;if(!window.testAttitudeOriginalDraw)window.testAttitudeOriginalDraw=renderer.draw.bind(renderer);window.testAttitudeFrames={draws:0,colors:0,nonBlack:0};renderer.draw=(...args)=>{testAttitudeOriginalDraw(...args);const gl=renderer.gl,pixels=new Uint8Array(renderer.canvas.width*renderer.canvas.height*4),colors=new Set();gl.readPixels(0,0,renderer.canvas.width,renderer.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let nonBlack=0;for(let i=0;i<pixels.length;i+=64){colors.add(pixels[i]+','+pixels[i+1]+','+pixels[i+2]);if(pixels[i]||pixels[i+1]||pixels[i+2])nonBlack++;}testAttitudeFrames={draws:testAttitudeFrames.draws+1,colors:colors.size,nonBlack};};})()");
        await view('attitude');await evaluate("document.getElementById('boatCanvas').scrollIntoView({block:'center',behavior:'instant'})");
        await until('boatMonitor.viewer.visible && boatMonitor.viewer.fresh && !!boatMonitor.viewer.pose && testAttitudeFrames.draws>0');
        const frame=await evaluate('testAttitudeFrames');
        assert.ok(frame.nonBlack>0&&frame.colors>10,'Visible paused 3D canvas contains rendered boat/water pixels at '+width);
        assert.equal(await evaluate('boatMonitor.viewer.error'),null,'Mobile 3D view has no rendering error');
        const pausedPhase=await evaluate('boatMonitor.viewer.phase');await wait(150);assert.equal(await evaluate('boatMonitor.viewer.phase'),pausedPhase,'Restoring the visible frame does not resume animation');
        await viewportShot('mobile-attitude-'+width);
      }
      await evaluate('stopTelemetry()');
    }
    // 停止遥测后先刷新最后一帧；避免 200 ms 显示周期让断开前的 DOM 时间落后一帧。
    await evaluate("window.dispatchEvent(new Event('resize'))");
    const lastDeviceUpdate=(await deviceSummary()).datetime;
    await evaluate("document.getElementById('disconnectButton').click()");assert.equal(await evaluate('boatMonitor.link.connected'),false);
    const disconnectedDevice=await deviceSummary();
    assert.equal(disconnectedDevice.state,'offline');assert.equal(disconnectedDevice.connection,'未连接');assert.equal(disconnectedDevice.name,'boat-mqtt-test');
    assert.equal(disconnectedDevice.datetime,lastDeviceUpdate,'Disconnect retains the last receive time for reference');
    assert.equal(disconnectedDevice.latency,'--','Disconnected devices show no current forwarding latency');
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Disconnect clears arrows immediately');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Disconnect leaves the ready map and track available');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'Disconnect returns the waiting hint without covering the map');
    assert.deepEqual(await horizonPose(),{valid:'false',state:'waiting',roll:'rotate(0 120 120)',pitch:'translate(0 0)'},'Disconnect clears the old horizon pose and returns to an invalid neutral view');
    assert.equal(await evaluate("document.getElementById('imuHorizon').dataset.roll"),'--');
    await evaluate('connectTestBoat()');await evaluate('stopTelemetry()');await wait(150);
    const beforeReconnectFeed=await evaluate('boatMonitor.link.parser.getStats().framesReceived');
    await evaluate('feedTelemetry()');await wait(250);
    assert.equal(await evaluate('boatMonitor.link.parser.getStats().framesReceived'),beforeReconnectFeed+4,'One MQTT packet parses exactly four frames after reconnect');assert.deepEqual(errors,[]);
    await view('navigation');await evaluate("document.getElementById('disconnectButton').click();document.getElementById('themeToggle').click();document.getElementById('mapVectorsToggle').click()");
    await send('Page.reload');await until('!!window.boatMonitor && !!window.boatMonitor.viewer.renderer');
    await assertView('navigation');assert.equal(await evaluate('document.getElementById("navigation").closest("[data-workspace-view]").dataset.workspaceView'),'navigation','A direct URL restores its page after reload');
    assert.ok(await evaluate('Math.abs(scrollY)<1'),'Refreshing a direct page URL retains its header instead of jumping to the map anchor');
    assert.equal(await evaluate("document.documentElement.dataset.theme"),'light','Explicit light theme persists across reload instead of reverting to the default dark theme');
    assert.equal(await evaluate('boatMonitor.params.slots[0].values.kpX2PerMps'),91,'Presets persist across reload');
    assert.equal(await evaluate('boatMonitor.mapVectors.visible'),false,'Hidden velocity arrows persist across reload');
    await evaluate('connectTestBoat()');await wait(250);
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Hidden arrows stay hidden when new data arrives');
    await evaluate("document.getElementById('mapVectorsToggle').click()");await until("!!document.querySelector('.map-velocity-anchor')");
    await evaluate("location.hash='#unknown-page'");await assertView('fleet');
    assert.deepEqual(errors,[]);
    console.log('PASS: eight independent workspace pages, desktop/mobile navigation, URL/back/forward/reload/unknown route, focus and aria-current, preserved MQTT/map/WebGL/parser/track instances, larger map/3D/chart views, hidden-animation stop and visible-frame recovery; real local HTTP/SSE packets without Web Bluetooth, parameters/Flash rejection/timeout, settings/presets/themes, map vectors/track/expiry, current-device metadata, simultaneous RTK/IMU telemetry and horizon, reconnect, 320/375/640/768/1024/1440/1920px.');
    console.log('Screenshots: '+output);
  }finally{socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
// 地图供应商集成测试复用同一份 MQTT 浏览器测试控制器。
module.exports={mock};
