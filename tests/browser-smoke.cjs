/* 真浏览器集成检查：真实页面/WebGL/协议，蓝牙由测试外设替代，不连接电机。 */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {createServer}=require('../server');
const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const mock='('+function(){
  const tx=new EventTarget();tx.uuid='49535343-1e4d-4bd9-ba61-23c647249616';tx.properties={notify:true};tx.startNotifications=async()=>tx;
  window.testWrites=[];window.replyStatus=0;window.suppressReply=false;let buffer=[];
  function send(bytes){for(let offset=0;offset<bytes.length;offset+=17){const b=bytes.slice(offset,offset+17);tx.value=new DataView(b.buffer);tx.dispatchEvent(new Event('characteristicvaluechanged'));}}
  const rx={uuid:'49535343-8841-43f4-a8d4-ecbe34729bb3',properties:{write:true},async writeValueWithResponse(bytes){
    buffer.push(...bytes);window.testWrites.push([...bytes]);if(buffer.length<56)return;
    const request=new Uint8Array(buffer.splice(0,56)),v=new DataView(request.buffer);window.lastCommand=request[3];
    if(window.suppressReply)return;
    if(request[3]===0x10){
      const values={...BoatParameters.tuning,turnAtFullSpeedPercent:50,motor1Reversed:0,motor2Reversed:1,headingKpX100:200,headingKiX100:0,headingKdX100:0,headingIntegralLimitX2:30,headingOutputLimitX2:60,headingDeadbandCdeg:200,headingReversed:0};
      Object.keys(BoatParameters.ranges).forEach((k,i)=>v.setUint16(14+i*2,values[k],true));
    }
    request[3]=0x90;request[5]=window.replyStatus;v.setUint16(54,BoatModules.uart4Protocol.crc16CcittFalse(request,2,52),true);setTimeout(()=>send(request),10);
  }};
  const service={uuid:'49535343-fe7d-4ae5-8fa9-9fafd205e455',getCharacteristics:async()=>[tx,rx]};
  const device=new EventTarget();device.id='browser-test';device.name='T10 TEST';
  device.gatt={connected:false,async connect(){this.connected=true;return {getPrimaryServices:async()=>[service]};},disconnect(){this.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));}};
  Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>device}});
  function frame(type,size,version,flags,seq){
    const b=new Uint8Array(size);b.set([0xa5,0x5a,version,type,size,flags]);const v=new DataView(b.buffer);v.setUint32(6,seq,true);v.setUint32(10,seq*100,true);
    return {b,v,finish(){v.setUint16(size-2,BoatModules.uart4Protocol.crc16CcittFalse(b,2,size-4),true);send(b);}};
  }
  window.telemetryOverrides={};
  let seq=0;window.feedTelemetry=()=>{
    const o=window.telemetryOverrides;
    seq++;let f=frame(1,64,1,0xf3,seq);
    for(const base of [14,38]){f.b[base]=7;f.b[base+1]=32;f.v.setUint16(base+2,2450,true);f.v.setUint16(base+4,1230,true);f.v.setUint32(base+12,1500,true);f.v.setUint32(base+8,10500,true);f.v.setInt16(base+18,120,true);f.v.setUint16(base+20,10,true);}f.finish();
    f=frame(2,40,2,3,seq);f.v.setInt16(14,Math.round((o.x??1.5)*1000),true);f.v.setInt16(16,Math.round((o.y??.4)*1000),true);f.v.setUint16(20,20,true);f.v.setInt32(26,311234567+seq*160,true);f.v.setInt32(30,1217654321,true);f.v.setUint16(34,Math.round((o.rtkHeading??359)*100),true);f.b[36]=o.rtkFlags??15;if(!o.skipVelocity)f.finish();
    f=frame(3,36,2,47,seq);f.v.setInt16(14,Math.round((o.target??1.8)*1000),true);f.v.setUint16(16,1552,true);f.v.setInt16(18,120,true);f.v.setUint16(20,20,true);f.v.setInt16(22,2000,true);f.v.setUint16(26,Math.round((o.targetHeading??1)*100),true);f.v.setUint16(28,Math.round((o.actualHeading??359)*100),true);f.v.setInt16(30,200,true);f.b[32]=o.mode??2;f.b[33]=o.headingFlags??3;if(!o.skipBoat)f.finish();
    f=frame(4,36,1,3,seq);f.v.setInt16(14,120,true);f.v.setInt16(20,600,true);f.v.setInt16(22,-400,true);f.v.setInt16(24,3200,true);f.v.setUint16(26,20,true);f.b[32]=127;f.finish();
  };
  window.startTelemetry=()=>{feedTelemetry();window.telemetryTimer=setInterval(feedTelemetry,100);};window.stopTelemetry=()=>clearInterval(telemetryTimer);
}.toString()+')();';
async function main(){
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
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
    await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:mock});await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await until('!!window.boatMonitor && !!window.boatMonitor.viewer.renderer');assert.deepEqual(errors,[]);
    assert.equal(await evaluate("document.documentElement.dataset.theme"),'dark','Monitoring dashboard starts in dark mode');
    assert.equal(await evaluate("(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return new Set(ids).size===ids.length;})()"),true,'Dashboard element IDs remain unique after rearranging panels');
    const assertDesktopLayout=async width=>{
      const layout=await evaluate("(()=>{const map=document.querySelector('.map-stage').getBoundingClientRect(),attitude=document.querySelector('.attitude-stage').getBoundingClientRect(),chart=document.getElementById('analysis').getBoundingClientRect(),panels=Object.fromEntries(['#navigation','#attitude','.telemetry-card','.map-stage','.systems-grid'].map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect(),s=getComputedStyle(el);return [selector,{width:r.width,height:r.height,fontSize:s.fontSize,lineHeight:s.lineHeight}];}));return {map:{left:map.left,top:map.top,width:map.width,height:map.height,bottom:map.bottom},attitude:{left:attitude.left,top:attitude.top,width:attitude.width,height:attitude.height},chart:{top:chart.top},panels,overflow:document.documentElement.scrollWidth>innerWidth};})()");
      console.log('Dashboard layout '+width+': '+JSON.stringify(layout.panels));
      assert.equal(layout.overflow,false,'Desktop page overflow at '+width);
      assert.ok(layout.map.width>layout.attitude.width*1.5,'Map remains the primary desktop panel at '+width);
      assert.ok(layout.map.width*layout.map.height>layout.attitude.width*layout.attitude.height,'Map has more display area than the attitude preview at '+width);
      assert.ok(layout.map.left+layout.map.width<=layout.attitude.left,'Map and attitude panels share the desktop row at '+width);
      assert.ok(layout.map.bottom<=layout.chart.top,'Control chart follows the navigation area at '+width);
    };
    await assertDesktopLayout(1440);
    await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});await wait(300);
    await assertDesktopLayout(1920);await shot('desktop-wide-empty');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await wait(300);
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),false,'Waiting map has an empty state');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.parameter-group')].map(group=>group.querySelectorAll('input,select').length)"),[10,7,3]);
    assert.equal(await evaluate("new Set([...document.querySelectorAll('#parameterFields [data-key]')].map(input=>input.dataset.key)).size"),20);
    assert.equal(await evaluate("document.querySelectorAll('#presets .preset.empty').length"),3);
    await shot('desktop-empty');
    await evaluate("document.getElementById('connectButton').click()");await until('boatMonitor.link.connected');
    await evaluate("window.testLatestFrames={};boatMonitor.link.addEventListener('frame',({detail})=>{if(detail.boat)testLatestFrames.boat=detail;if(detail.velocity)testLatestFrames.velocity=detail;});startTelemetry();document.getElementById('trackStart').click()");await wait(1200);
    assert.equal(await evaluate("document.getElementById('boatActual').textContent"),'1.552');assert.equal(await evaluate("document.getElementById('roll').textContent"),'6.00');
    assert.equal(await evaluate("document.getElementById('chartTarget').textContent"),'1.800 m/s');
    assert.equal(await evaluate("document.getElementById('chartActual').textContent"),'1.552 m/s');
    assert.equal(await evaluate("document.getElementById('chartError').textContent"),'-0.248 m/s');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Live position replaces the empty state');
    assert.equal(await evaluate("document.getElementById('motor1Voltage').textContent"),'24.50');
    assert.ok(await evaluate("parseFloat(document.getElementById('motor1Dial').style.strokeDasharray)>0"));
    assert.equal(await evaluate("boatMonitor.track.segments[0][0].longitude"),121.7654321);assert.ok(await evaluate('boatMonitor.track.pointCount>=2'));
    const assertTelemetryTab=async selected=>{
      const imu=selected==='imu';
      assert.deepEqual(await evaluate("['rtkPanel','imuPanel'].map(id=>document.getElementById(id).hidden)"),[imu,!imu],'Only the selected telemetry panel is visible');
      assert.deepEqual(await evaluate("['rtkTab','imuTab'].map(id=>document.getElementById(id).getAttribute('aria-selected'))"),[String(!imu),String(imu)],'Telemetry tab selection is exposed to assistive technology');
      assert.deepEqual(await evaluate("['rtkTab','imuTab'].map(id=>document.getElementById(id).tabIndex)"),imu?[-1,0]:[0,-1],'Only the selected telemetry tab is in the keyboard tab sequence');
    };
    await assertTelemetryTab('rtk');
    await evaluate("document.getElementById('imuTab').click()");await assertTelemetryTab('imu');await shot('desktop-imu');
    await evaluate("document.getElementById('rtkTab').click()");await assertTelemetryTab('rtk');
    for(const [from,key,selected] of [['rtk','ArrowRight','imu'],['imu','ArrowRight','rtk'],['rtk','ArrowLeft','imu'],['imu','Home','rtk'],['rtk','End','imu']]){
      await evaluate('document.getElementById('+JSON.stringify(from+'Tab')+').dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(key)+',bubbles:true,cancelable:true}))');
      await assertTelemetryTab(selected);
      assert.equal(await evaluate('document.activeElement.id'),selected+'Tab','Telemetry keyboard navigation moves focus with selection');
    }
    await evaluate("document.getElementById('rtkTab').click()");await assertTelemetryTab('rtk');
    const vector=kind=>"document.querySelector('.map-velocity-anchor [data-vector=\""+kind+"\"]')";
    await until(vector('target')+" && getComputedStyle("+vector('target')+").display!=='none'");
    assert.equal(await evaluate("document.querySelector('.map-velocity-vectors').getBoundingClientRect().width"),264,'Map SVG retains its own size instead of the 19px UI icon size');
    assert.equal(await evaluate("(()=>{const icon=document.querySelector('.map-velocity-anchor').getBoundingClientRect(),svg=document.querySelector('.map-velocity-vectors').getBoundingClientRect();return Math.abs(svg.left+svg.width/2-icon.left)<1&&Math.abs(svg.top+svg.height/2-icon.top)<1;})()"),true,'Velocity arrows start at the boat anchor');
    assert.equal(await evaluate(vector('target')+'.dataset.bearing'),'1');
    assert.ok(Math.abs(await evaluate('Number('+vector('actual')+'.dataset.bearing)')-75.06858282186246)<1e-8,'Actual direction follows east/north speed, not bow heading');
    assert.ok(Math.abs(await evaluate('Number('+vector('actual')+'.dataset.length)')-Math.hypot(1.5,.4)*28)<1e-8);
    const override=async values=>{await evaluate('window.telemetryOverrides='+JSON.stringify(values)+';feedTelemetry()');await wait(230);};
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
    await override({});
    await evaluate("document.getElementById('mapFollow').checked=false;boatMonitor.map.panBy([40,20],{animate:false});boatMonitor.map.setZoom(17,{animate:false});void 0");
    assert.equal(await evaluate("(()=>{const el=boatMonitor.mapVectors.marker.getElement().getBoundingClientRect(),rect=document.getElementById('map').getBoundingClientRect(),point=boatMonitor.map.latLngToContainerPoint(boatMonitor.mapVectors.marker.getLatLng());return Math.abs(el.left-rect.left-point.x)<1&&Math.abs(el.top-rect.top-point.y)<1;})()"),true,'Arrows stay anchored to the boat through pan and zoom');
    await evaluate("document.getElementById('mapFollow').checked=true;boatMonitor.map.setZoom(16,{animate:false});void 0");
    for(const source of ['skipBoat','skipVelocity']){
      await override({[source]:true});await wait(1100);
      assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,source+' expires without reusing a stale vector');
      await override({});
    }
    await shot('desktop-speed');
    await mapShot('map-vectors-directions');
    const canvasPixel="[...document.getElementById('chart').getContext('2d').getImageData(0,0,1,1).data]";
    assert.deepEqual(await evaluate(canvasPixel),[6,21,37,255]);
    await evaluate("document.getElementById('themeToggle').click()");
    assert.equal(await evaluate("document.documentElement.dataset.theme"),'light');
    assert.deepEqual(await evaluate(canvasPixel),[255,255,255,255]);
    await shot('desktop-light');await evaluate("document.getElementById('themeToggle').click()");
    await evaluate("document.getElementById('settingsToggle').click();document.getElementById('readParameters').click()");await until('!!boatMonitor.params.confirmed && !boatMonitor.params.busy');
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
    assert.equal(await evaluate("document.getElementById('parameterStatus').dataset.tone"),'danger');
    await evaluate("suppressReply=false;document.querySelector('[data-slot=\"0\"][data-action=\"use\"]').click()");await until("!boatMonitor.params.busy && document.getElementById('parameterStatus').textContent.includes('写入成功')");
    await shot('desktop-settings');
    await evaluate("document.getElementById('presets').scrollIntoView({behavior:'instant',block:'center'})");await shot('desktop-presets');
    await evaluate("document.getElementById('settingsClose').click();document.getElementById('chartModeButton').click()");
    await until("document.getElementById('chartActual').textContent==='359.00°'");
    assert.equal(await evaluate("document.getElementById('chartTarget').textContent"),'1.00°');
    assert.equal(await evaluate("document.getElementById('chartError').textContent"),'2.00°');
    await shot('desktop-live');
    await evaluate("document.getElementById('boatCanvas').scrollIntoView();document.getElementById('animationEnabled').click()");
    const frozen=await evaluate('boatMonitor.viewer.phase');await wait(300);assert.equal(await evaluate('boatMonitor.viewer.phase'),frozen);
    await evaluate("document.getElementById('quality').value='low';document.getElementById('quality').dispatchEvent(new Event('change'))");await shot('desktop-attitude');
    await evaluate('stopTelemetry()');await wait(1400);
    for(const id of ['boatActual','roll','motor1Rpm','chartActual','chartTarget','chartError'])assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),'--');
    assert.equal(await evaluate("parseFloat(document.getElementById('motor1Dial').style.strokeDasharray)"),0);
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Expired position retains the recorded track for review');
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Stale telemetry removes velocity arrows');
    for(const width of [1024,768,640,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:true});await evaluate('window.scrollTo(0,0)');await wait(300);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Page overflow at '+width);await shot('mobile-'+width);
      await evaluate("document.getElementById('settingsToggle').click();document.querySelector('.dialog-scroll').scrollTop=0");
      assert.equal(await evaluate("document.getElementById('settingsDialog').scrollWidth<=document.getElementById('settingsDialog').clientWidth"),true);await shot('mobile-settings-'+width);
      await evaluate("document.getElementById('presets').scrollIntoView({behavior:'instant',block:'center'})");
      assert.equal(await evaluate("document.querySelector('.dialog-scroll').scrollWidth<=document.querySelector('.dialog-scroll').clientWidth"),true,'Settings content overflow at '+width);await shot('mobile-presets-'+width);
      await evaluate("document.getElementById('settingsClose').click();startTelemetry()");await wait(250);await shot('mobile-live-'+width);
      assert.ok(await evaluate('Number('+vector('target')+'.dataset.length)')>0,'Velocity arrows visible at '+width);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Live page overflow at '+width);
      if(width===375||width===320){
        assert.equal(await evaluate('boatMonitor.viewer.settings.animation'),false,'Mobile viewport restores a frame while animation remains paused');
        await evaluate("(()=>{const renderer=boatMonitor.viewer.renderer;if(!window.testAttitudeOriginalDraw)window.testAttitudeOriginalDraw=renderer.draw.bind(renderer);window.testAttitudeFrames={draws:0,colors:0,nonBlack:0};renderer.draw=(...args)=>{testAttitudeOriginalDraw(...args);const gl=renderer.gl,pixels=new Uint8Array(renderer.canvas.width*renderer.canvas.height*4),colors=new Set();gl.readPixels(0,0,renderer.canvas.width,renderer.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let nonBlack=0;for(let i=0;i<pixels.length;i+=64){colors.add(pixels[i]+','+pixels[i+1]+','+pixels[i+2]);if(pixels[i]||pixels[i+1]||pixels[i+2])nonBlack++;}testAttitudeFrames={draws:testAttitudeFrames.draws+1,colors:colors.size,nonBlack};};document.getElementById('boatCanvas').scrollIntoView({block:'center',behavior:'instant'});})()");
        await until('boatMonitor.viewer.visible && boatMonitor.viewer.fresh && !!boatMonitor.viewer.pose && testAttitudeFrames.draws>0');
        const frame=await evaluate('testAttitudeFrames');
        assert.ok(frame.nonBlack>0&&frame.colors>10,'Visible paused 3D canvas contains rendered boat/water pixels at '+width);
        assert.equal(await evaluate('boatMonitor.viewer.error'),null,'Mobile 3D view has no rendering error');
        const pausedPhase=await evaluate('boatMonitor.viewer.phase');await wait(150);assert.equal(await evaluate('boatMonitor.viewer.phase'),pausedPhase,'Restoring the visible frame does not resume animation');
        await viewportShot('mobile-attitude-'+width);
      }
      await evaluate('stopTelemetry()');
    }
    await evaluate("document.getElementById('disconnectButton').click()");assert.equal(await evaluate('boatMonitor.link.connected'),false);
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Disconnect clears arrows immediately');
    await evaluate("document.getElementById('connectButton').click()");await until('boatMonitor.link.connected');await evaluate('feedTelemetry()');await wait(250);
    assert.equal(await evaluate("document.getElementById('parsedFrames').textContent"),'4','Reconnect has only one listener');assert.deepEqual(errors,[]);
    await evaluate("document.getElementById('disconnectButton').click();document.getElementById('themeToggle').click();document.getElementById('mapVectorsToggle').click()");
    await send('Page.reload');await until('!!window.boatMonitor && !!window.boatMonitor.viewer.renderer');
    assert.equal(await evaluate("document.documentElement.dataset.theme"),'light','Explicit light theme persists across reload instead of reverting to the default dark theme');
    assert.equal(await evaluate('boatMonitor.params.slots[0].values.kpX2PerMps'),91,'Presets persist across reload');
    assert.equal(await evaluate('boatMonitor.mapVectors.visible'),false,'Hidden velocity arrows persist across reload');
    await evaluate("document.getElementById('connectButton').click()");await until('boatMonitor.link.connected');await evaluate('feedTelemetry()');await wait(250);
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Hidden arrows stay hidden when new data arrives');
    await evaluate("document.getElementById('mapVectorsToggle').click()");await until("!!document.querySelector('.map-velocity-anchor')");
    assert.deepEqual(errors,[]);
    console.log('PASS: browser/WebGL, BLE split frames, parameters/Flash rejection/timeout, grouped settings, preset/theme persistence, map velocity vectors/direction/scale/reverse/overlap/zero/stale/pan/zoom/hide persistence, primary desktop map layout, unique element IDs, RTK/IMU tabs and keyboard navigation, map empty state, themed charts, stale values, animation freeze and mobile viewport restoration, reconnect, 320/375/640/768/1024/1440/1920px.');
    console.log('Screenshots: '+output);
  }finally{socket?.close();browser.kill();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
