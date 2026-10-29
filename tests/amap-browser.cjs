/* 高德接入的浏览器合约测试：拦截官方 SDK，以本地 Leaflet 模拟公开 API。
 * 不访问高德、不使用真实 Key；此测试不能替代配置真实 Key 后的现场联网验证。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createFixtureServer,fixtureScript:mock}=require('./mqtt-browser-fixture.cjs');
const output=path.resolve(__dirname,'../.test-output');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const testKey='a'.repeat(32),testCode='b'.repeat(32);

// 只模拟门面实际调用的公开 AMap API；投影与 DOM 定位交给本地 Leaflet。
const fakeSdk='('+function(){
  const calls=window.amapTestCalls={maps:[],markers:[],polylines:[],events:[],security:window._AMapSecurityConfig?.securityJsCode};
  const coord=p=>Array.isArray(p)?[p[1],p[0]]:[p.lat,p.lng];
  class Pixel{constructor(x,y){this.x=x;this.y=y;}getX(){return this.x;}getY(){return this.y;}}
  class Map{
    constructor(container,options){
      this.options=options;calls.maps.push(this);
      const host=typeof container==='string'?document.getElementById(container):container;
      host.dataset.testMap='fake-amap';
      host.style.background='#153147';
      this.map=L.map(host,{zoomControl:false,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false})
        .setView(coord(options.center||[121.47,31.23]),options.zoom||5);
      const label=L.control({position:'bottomleft'});label.onAdd=()=>{const node=document.createElement('div');node.style.cssText='background:#061525;color:#c7dbe7;padding:4px 8px;font:11px sans-serif';node.textContent='高德 SDK 模拟测试 · 非真实底图';return node;};label.addTo(this.map);
    }
    on(name,fn){
      this.map.on(name,fn);
      // 真实 SDK 先构造 Map，底图/渲染器完成后才异步通知 complete。
      if(name==='complete'&&!this.completeScheduled){
        this.completeScheduled=true;
        this.completeTimer=setTimeout(()=>{
          if(this.destroyed||window.amapTestMode==='map-incomplete')return;
          const event=window.amapTestMode==='map-error'?'error':'complete';
          calls.events.push(event);this.map.fire(event,{type:event,message:event==='error'?'Simulated map renderer failure':undefined});
        },window.amapTestMode==='map-delayed'?650:100);
      }
      return this;
    }
    off(name,fn){this.map.off(name,fn);return this;}
    add(overlay){for(const item of Array.isArray(overlay)?overlay:[overlay])item.setMap(this);return this;}
    remove(overlay){for(const item of Array.isArray(overlay)?overlay:[overlay])item.setMap(null);return this;}
    getZoom(){return this.map.getZoom();}
    getCenter(){const p=this.map.getCenter();return {lng:p.lng,lat:p.lat,getLng:()=>p.lng,getLat:()=>p.lat};}
    setZoom(zoom){this.map.setZoom(zoom,{animate:false});return this;}
    setCenter(center){this.map.setView(coord(center),this.getZoom(),{animate:false});return this;}
    setZoomAndCenter(zoom,center){this.map.setView(coord(center),zoom,{animate:false});return this;}
    panBy(x,y){this.map.panBy(Array.isArray(x)?x:[x,y],{animate:false});return this;}
    getSize(){const p=this.map.getSize();return {width:p.x,height:p.y,getWidth:()=>p.x,getHeight:()=>p.y};}
    lngLatToContainer(point){const p=this.map.latLngToContainerPoint(coord(point));return new Pixel(p.x,p.y);}
    setMapStyle(style){this.style=style;return this;}
    resize(){this.map.invalidateSize({pan:false,animate:false});return this;}
    destroy(){this.destroyed=true;clearTimeout(this.completeTimer);this.map.remove();}
  }
  class Marker{
    constructor(options){this.options=options;this.position=[...options.position];this.content=options.content;this.map=null;calls.markers.push(this);}
    setMap(map){
      this.marker?.remove();this.marker=null;this.map=map;
      if(map){const offset=this.options.offset||{x:0,y:0};this.marker=L.marker(coord(this.position),{icon:L.divIcon({className:'amap-test-anchor',html:this.content,iconSize:[0,0],iconAnchor:[-offset.x,-offset.y]}),zIndexOffset:this.options.zIndex||0,interactive:false,keyboard:false}).addTo(map.map);}
      return this;
    }
    setPosition(position){this.position=[...position];this.marker?.setLatLng(coord(position));return this;}
    setOpacity(value){this.opacity=value;this.marker?.setOpacity(value);return this;}
    getContent(){return this.content;}
    getPosition(){return {lng:this.position[0],lat:this.position[1]};}
  }
  class Polyline{
    constructor(options){this.options=options;this.path=options.path.map(p=>[...p]);this.map=null;calls.polylines.push(this);}
    setMap(map){this.line?.remove();this.line=null;this.map=map;if(map)this.line=L.polyline(this.path.map(coord),{color:this.options.strokeColor,weight:this.options.strokeWeight}).addTo(map.map);return this;}
  }
  window.AMap={Map,Marker,Polyline,Pixel};
  const callback=new URL(document.currentScript.src).searchParams.get('callback');
  if(callback)window[callback]();
}.toString()+')();';

async function browserSession(server,mode,run){
  const profile=fs.mkdtempSync(path.join(output,'amap-chrome-')),errors=[],sdkRequests=[],configRequests=[],settingsRequests=[];
  const failures={settingsRead:false,settingsWrite:false,sdk:false};
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--remote-debugging-port=0','--user-data-dir='+profile
  ],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let chromeLog='';browser.stderr.on('data',data=>{chromeLog=(chromeLog+data).slice(-1500);});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map(),recent=[];
    socket.onclose=event=>recent.push('socket closed '+event.code);
    socket.onerror=event=>recent.push('socket error '+(event.error?.message||event.message||'unknown'));
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);
      recent.push(message.method||'response '+message.id);if(recent.length>8)recent.shift();
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(message.method==='Fetch.requestPaused'){
        const request=message.params;
        const url=new URL(request.request.url);
        if(url.hostname==='webapi.amap.com'){
          sdkRequests.push(url.href);
          void (mode==='sdk-failed'||failures.sdk
            ?send('Fetch.failRequest',{requestId:request.requestId,errorReason:'Failed'})
            :send('Fetch.fulfillRequest',{requestId:request.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript; charset=utf-8'}],body:Buffer.from('window.amapTestMode='+JSON.stringify(mode)+';'+fakeSdk).toString('base64')}))
            .catch(error=>errors.push(error.message));
        }else if(url.pathname==='/api/map/settings'){
          settingsRequests.push({method:request.request.method,body:request.request.postData});
          const fail=request.request.method==='PUT'?failures.settingsWrite:failures.settingsRead;
          void (fail
            ?send('Fetch.fulfillRequest',{requestId:request.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"模拟地图配置保存失败"}').toString('base64')})
            :send('Fetch.continueRequest',{requestId:request.requestId}))
            .catch(error=>errors.push(error.message));
        }else{
          configRequests.push(url.href);
          void (mode==='config-failed'
            ?send('Fetch.fulfillRequest',{requestId:request.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"test-unavailable"}').toString('base64')})
            :send('Fetch.continueRequest',{requestId:request.requestId}))
            .catch(error=>errors.push(error.message));
        }
      }
      if(pending.has(message.id)){
        const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timer);
        message.error?p.reject(Error(message.error.message)):p.resolve(message.result);
      }
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method+'; recent: '+recent.join(' | ')+'; Chrome: '+chromeLog));},15000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result.value;
    };
    const until=async(expression,timeout=8000)=>{for(let i=0;i<Math.ceil(timeout/50);i++){if(await evaluate(expression))return;await wait(50);}throw Error('Condition timed out: '+expression+'\n'+errors.join('\n'));};
    const shot=async(name)=>{
      const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
      fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));
    };
    const viewportShot=async(name)=>{
      const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));
    };
    await send('Runtime.enable');await send('Page.enable');
    await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://tile.openstreetmap.org/*']});
    await send('Fetch.enable',{patterns:[{urlPattern:'https://webapi.amap.com/*'},{urlPattern:'*/api/map/config'},{urlPattern:'*/api/map/settings'}]});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:mock});
    // 单船地图测试显式打开概览；自动选船不再替用户从船队页切换页面。
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/#overview'});
    await until('!!window.boatMonitor && !!window.boatMonitor.viewer.renderer');
    await run({send,evaluate,until,shot,viewportShot,errors,sdkRequests,configRequests,settingsRequests,failures});
    assert.deepEqual(errors,[],'Page has no unhandled JavaScript errors in '+mode);
  }finally{socket?.close();browser.kill();}
}

async function withServer(env,mode,run,options={}){
  const base=fs.mkdtempSync(path.join(output,'map-settings-browser-'));
  const server=createFixtureServer({...options,env:{BOAT_ACCOUNTS_ENABLED:'0',...env},mapOptions:{file:path.join(base,'map-settings.json'),...options.mapOptions}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await browserSession(server,mode,run);}finally{await new Promise(resolve=>server.close(resolve));}
}

async function startTelemetry({evaluate,until}){
  await evaluate('connectTestBoat()');await until('boatMonitor.link.connected');
  await until('boatMonitor.track.active');
  await until("document.getElementById('roll').textContent==='6.00' && document.getElementById('boatActual').textContent==='1.552'");
}

async function login({evaluate,until},username,password){
  await until('window.BoatAuth?.ready');
  if(!await evaluate('document.getElementById("accountLoginDialog").open'))await evaluate('document.getElementById("accountLoginOpen").click()');
  await evaluate('document.getElementById("accountUsername").value='+JSON.stringify(username)+';document.getElementById("accountPassword").value='+JSON.stringify(password)+';document.getElementById("accountLoginForm").requestSubmit()');
  await until('!!BoatAuth.user && !BoatAuth.busy && !document.getElementById("accountLoginDialog").open');
}

async function settingsBrowser(){
  const base=fs.mkdtempSync(path.join(output,'amap-settings-persist-')),file=path.join(base,'map-settings.json');
  const accounts={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only',BOAT_GUEST_USERNAME:'visitor',BOAT_GUEST_PASSWORD:'browser-guest-test-only'};
  const newKey='c'.repeat(32),newCode='d'.repeat(32),options={mapOptions:{file}};
  const api="fetch('/api/map/config').then(response=>response.json())";
  const fill=(key,code)=>"document.getElementById('amapKey').value="+JSON.stringify(key)+";document.getElementById('amapSecurityCode').value="+JSON.stringify(code)+";for(const id of ['amapKey','amapSecurityCode'])document.getElementById(id).dispatchEvent(new Event('input',{bubbles:true}))";
  const open=async({evaluate,until})=>{
    await evaluate("document.getElementById('platformSettingsToggle').click()");
    await until("document.getElementById('platformSettingsDialog').open && !document.getElementById('mapSettingsForm').hidden && !document.getElementById('mapSettingsSave').disabled");
  };
  await withServer(accounts,'settings-admin',async context=>{
    const {evaluate,until,send,viewportShot,settingsRequests,failures,sdkRequests}=context;
    await login(context,'operator',accounts.BOAT_ADMIN_PASSWORD);await until('boatMonitor.map.ready');
    assert.equal(await evaluate('boatMonitor.link.connected'),false,'Platform settings are available without a boat connection');
    await open(context);
    assert.equal(await evaluate("document.getElementById('amapKey').value"),'');
    assert.equal(await evaluate("document.getElementById('amapSecurityCode').value"),'');
    assert.ok(settingsRequests.some(request=>request.method==='GET'),'Opening settings reads the current server configuration');
    await evaluate(fill('invalid',testCode));
    const writesBefore=settingsRequests.filter(request=>request.method==='PUT').length;
    await evaluate("document.getElementById('mapSettingsForm').requestSubmit()");
    await until("document.getElementById('mapSettingsStatus').dataset.tone==='error'");
    assert.equal(settingsRequests.filter(request=>request.method==='PUT').length,writesBefore,'Invalid fields do not send a settings write');
    await evaluate(fill(testKey,testCode));failures.settingsWrite=true;
    await evaluate("document.getElementById('mapSettingsForm').requestSubmit()");
    await until("/失败/.test(document.getElementById('mapSettingsStatus').textContent) && !document.getElementById('mapSettingsSave').disabled");
    assert.notEqual(await evaluate("document.getElementById('mapSettingsStatus').dataset.tone"),'success','A failed save never displays success');
    assert.equal((await evaluate(api)).configured,false,'Failed save does not change active server configuration');
    failures.settingsWrite=false;
    await evaluate("document.getElementById('mapSettingsForm').requestSubmit()");
    await until("/刷新/.test(document.getElementById('mapSettingsStatus').textContent) && document.getElementById('mapSettingsStatus').dataset.tone==='success'");
    assert.equal((await evaluate(api)).key,testKey);assert.equal((await evaluate(api)).securityJsCode,testCode);
    assert.equal(await evaluate('boatMonitor.map.provider'),'osm','Saving does not replace the running map before an explicit refresh');
    assert.equal(sdkRequests.length,0,'Saving does not automatically load a new SDK');
    await send('Page.reload');await until("window.boatMonitor?.map?.ready && boatMonitor.map.provider==='amap' && window.BoatAuth?.canManage");
    assert.equal(sdkRequests.length,1,'Explicit page refresh applies the saved configuration');
    await startTelemetry(context);await open(context);
    assert.equal(await evaluate("document.getElementById('amapKey').value"),testKey,'Saved configuration is read back into the form');
    assert.match(await evaluate("document.getElementById('mapSettingsSource').textContent"),/保存|文件/);
    await evaluate(fill(newKey,newCode));
    await evaluate("document.getElementById('mapSettingsForm').requestSubmit()");
    await until("document.getElementById('mapSettingsStatus').dataset.tone==='success' && /刷新/.test(document.getElementById('mapSettingsStatus').textContent)");
    assert.equal(await evaluate('boatMonitor.link.connected'),true,'Saving map settings keeps the active telemetry connection');
    assert.equal(await evaluate('amapTestCalls.security'),testCode,'Running SDK retains its current configuration until refresh');
    assert.equal((await evaluate(api)).key,newKey);
    for(const width of [1440,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await evaluate("document.getElementById('mapSettings').scrollIntoView({block:'center',behavior:'instant'})");await wait(200);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth && document.getElementById('platformSettingsDialog').scrollWidth<=document.getElementById('platformSettingsDialog').clientWidth && document.querySelector('#platformSettingsDialog .dialog-scroll').scrollWidth<=document.querySelector('#platformSettingsDialog .dialog-scroll').clientWidth"),true,'Map settings do not overflow at '+width);
      assert.equal(await evaluate("['amapKey','amapSecurityCode'].every(id=>{const input=document.getElementById(id),parent=input.closest('label').getBoundingClientRect(),r=input.getBoundingClientRect();return r.left>=parent.left-1&&r.right<=parent.right+1;})"),true,'Map inputs fit their labels at '+width);
      await viewportShot('amap-settings-admin-'+width);
    }
    await evaluate("document.getElementById('platformSettingsClose').click();document.getElementById('accountLogout').click()");await until('!BoatAuth.user && !BoatAuth.busy');
    await login(context,'visitor',accounts.BOAT_GUEST_PASSWORD);
    assert.equal(await evaluate("document.getElementById('mapSettings').hidden"),true,'Guest cannot see map administration');
    assert.equal(await evaluate("document.getElementById('amapKey').value"),'','Account downgrade clears the administrator key field');
    assert.equal(await evaluate("fetch('/api/map/settings').then(response=>response.status)"),403,'Server refuses guest settings reads');
    assert.equal(await evaluate("fetch('/api/map/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'',securityJsCode:''})}).then(response=>response.status)"),403,'Server refuses guest settings writes');
    assert.equal((await evaluate(api)).key,newKey,'Guest attempts cannot change the persisted configuration');
    console.log('PASS: map administration in Chrome, disconnected admin read/edit/save, invalid/save-failure feedback, explicit refresh, live-connection preservation, guest guards and 320/1440px layout.');
  },options);
  assert.equal(fs.existsSync(file),true,'A successful save creates the independent persistent settings file');
  await withServer(accounts,'settings-restarted',async context=>{
    const {evaluate,until}=context;
    await until("boatMonitor.map?.ready && boatMonitor.map.provider==='amap'");
    const config=await evaluate(api);assert.equal(config.key,newKey);assert.equal(config.securityJsCode,newCode);
    assert.equal(await evaluate("fetch('/api/map/settings').then(response=>response.status)"),401,'Anonymous visitors cannot read management settings');
    await login(context,'operator',accounts.BOAT_ADMIN_PASSWORD);await open(context);
    assert.equal(await evaluate("document.getElementById('amapKey').value"),newKey);
    assert.equal(await evaluate("document.getElementById('amapSecurityCode').value"),newCode);
    console.log('PASS: saved map configuration survives a server restart and is read by the next administrator session.');
  },options);
  await withServer({},'settings-legacy',async context=>{
    const {evaluate,until,viewportShot}=context;
    await until('BoatAuth.ready');await evaluate("document.getElementById('platformSettingsToggle').click()");
    await until("document.getElementById('platformSettingsDialog').open && !document.getElementById('mapSettings').hidden");
    assert.equal(await evaluate("document.getElementById('mapSettingsForm').hidden"),true,'Legacy deployments do not expose an unauthenticated settings form');
    assert.match(await evaluate("document.getElementById('mapSettingsAccess').textContent"),/账户|管理员|登录/);
    assert.equal(await evaluate("fetch('/api/map/settings').then(response=>response.status)"),503,'Legacy deployments refuse unauthenticated configuration access');
    await evaluate("document.getElementById('mapSettings').scrollIntoView({block:'center',behavior:'instant'})");await viewportShot('amap-settings-legacy');
    console.log('PASS: legacy account-disabled mode explains the prerequisite and blocks server configuration edits.');
  });
}

// 使用真实按钮切换提供方，验证切换过程不会重置遥测链路或原始 WGS84 轨迹。
async function providerSwitchBrowser(){
  await withServer({BOAT_AMAP_KEY:testKey,BOAT_AMAP_SECURITY_CODE:testCode},'provider-switch',async context=>{
    const {evaluate,until,send,viewportShot,sdkRequests,failures}=context;
    await until("boatMonitor.map?.ready && boatMonitor.map.provider==='amap'");
    assert.match(await evaluate("document.getElementById('mapProviderToggle').textContent"),/OSM/,'AMap offers a direct switch to OSM');
    await startTelemetry(context);
    await until('boatMonitor.track.pointCount>=2 && !!document.querySelector(".map-velocity-anchor")');
    await evaluate("stopTelemetry();document.getElementById('trackStart').click();document.getElementById('mapFollow').checked=false;boatMonitor.map.setZoom(17);boatMonitor.map.panBy([70,30],{animate:false});window.providerSwitchStates=[];boatMonitor.map.on('switching',()=>providerSwitchStates.push({busy:boatMonitor.map.switching,disabled:document.getElementById('mapProviderToggle').disabled}));void 0");
    const trackBefore=await evaluate('({segments:boatMonitor.track.segments,pointCount:boatMonitor.track.pointCount,lines:boatMonitor.map.lastTrackLines})');
    const centerBefore=await evaluate('boatMonitor.map.getCenter()');
    const assertPreserved=async provider=>{
      await evaluate('feedTelemetry()');await wait(250);
      assert.equal(await evaluate('boatMonitor.link.connected'),true,'Switching keeps the telemetry connection on '+provider);
      assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'The new base layer is visible on '+provider);
      assert.equal(await evaluate('boatMonitor.map.getZoom()'),17,'Switching retains the user-selected zoom on '+provider);
      const center=await evaluate('boatMonitor.map.getCenter()');
      assert.ok(Math.abs(center.latitude-centerBefore.latitude)<1e-6&&Math.abs(center.longitude-centerBefore.longitude)<1e-6,'Switching retains the manually panned viewport on '+provider);
      assert.equal(await evaluate("document.getElementById('mapFollow').checked"),false,'Switching retains the follow setting on '+provider);
      assert.deepEqual(await evaluate('({segments:boatMonitor.track.segments,pointCount:boatMonitor.track.pointCount,lines:boatMonitor.map.lastTrackLines})'),trackBefore,'Switching retains raw track points and speed-colored line definitions on '+provider);
      assert.equal(await evaluate("document.querySelectorAll('.boat-pin').length"),1,'Exactly one boat marker is visible on '+provider);
      assert.equal(await evaluate("document.querySelectorAll('.map-velocity-anchor').length"),1,'Exactly one velocity overlay is visible on '+provider);
      const position=await evaluate("(()=>{const marker=boatMonitor.mapVectors.marker;return {raw:marker.getLatLng(),display:marker.mapPosition,lat:Number(document.getElementById('latitude').textContent),lng:Number(document.getElementById('longitude').textContent),expected:BoatModules.mapCoordinates.wgs84ToGcj02(Number(document.getElementById('latitude').textContent),Number(document.getElementById('longitude').textContent))};})()");
      assert.equal(position.raw.lat,position.lat,'Facade and displayed latitude stay WGS84 on '+provider);
      assert.equal(position.raw.lng,position.lng,'Facade and displayed longitude stay WGS84 on '+provider);
      const expected=provider==='amap'?position.expected:{latitude:position.lat,longitude:position.lng};
      assert.ok(Math.abs(position.display.latitude-expected.latitude)<2e-7&&Math.abs(position.display.longitude-expected.longitude)<2e-7,'The new provider projects raw coordinates exactly once on '+provider);
    };
    await evaluate("document.getElementById('mapProviderToggle').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='osm'");
    assert.equal(await evaluate("localStorage.getItem('boat.map.provider')"),'osm','Selecting OSM is saved in this browser');
    assert.match(await evaluate("document.getElementById('mapProviderToggle').textContent"),/高德/,'OSM offers a direct switch to AMap');
    await assertPreserved('osm');
    await evaluate("document.getElementById('mapProviderToggle').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='amap'");
    await assertPreserved('amap');
    assert.equal(sdkRequests.length,1,'Switching back reuses the already loaded official SDK');
    assert.equal(await evaluate("localStorage.getItem('boat.map.provider')"),'amap','Selecting AMap is saved in this browser');
    assert.equal(await evaluate('providerSwitchStates.some(state=>state.busy&&state.disabled)'),true,'Switching disables the button while provider work is in progress');
    assert.equal(await evaluate("document.getElementById('mapProviderToggle').disabled"),false,'The map switch button becomes available after switching');
    for(const width of [1440,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});await wait(200);
      assert.equal(await evaluate("(()=>{const button=document.getElementById('mapProviderToggle'),r=button.getBoundingClientRect(),controls=button.closest('.map-controls').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.width>0&&r.left>=controls.left-1&&r.right<=controls.right+1;})()"),true,'Provider switch fits the map controls at '+width+'px');
      await evaluate("document.getElementById('mapProviderToggle').scrollIntoView({block:'center',behavior:'instant'})");
      await viewportShot('map-provider-switch-'+width);
    }
    await evaluate("document.getElementById('mapProviderToggle').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='osm'");
    await evaluate('window.beforeMapReload=true');await send('Page.reload');
    await until("!window.beforeMapReload && window.boatMonitor?.map?.ready && boatMonitor.map.provider==='osm'");
    assert.equal(sdkRequests.length,1,'Reloading a remembered OSM selection does not load the AMap SDK');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Remembered OSM is usable before a new location fix');
    failures.sdk=true;
    await evaluate("window.originalOsmMap=boatMonitor.map.map;document.getElementById('mapProviderToggle').click()");
    await until("document.getElementById('toast').classList.contains('show') && !boatMonitor.map.switching");
    assert.equal(await evaluate("boatMonitor.map.ready && boatMonitor.map.provider==='osm' && boatMonitor.map.map===originalOsmMap"),true,'A failed SDK request keeps the original usable OSM map');
    assert.equal(await evaluate("localStorage.getItem('boat.map.provider')"),'osm','A failed switch does not change the saved selection');
    failures.sdk=false;
    await evaluate("document.getElementById('mapProviderToggle').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='amap'");
    await evaluate('window.beforeMapReload=true');await send('Page.reload');
    await until("!window.beforeMapReload && window.boatMonitor?.map?.ready && boatMonitor.map.provider==='amap'");
    assert.equal(await evaluate("localStorage.getItem('boat.map.provider')"),'amap','Reloading retains a remembered AMap selection');
    console.log('PASS: map provider button switches AMap/OSM without losing connection, raw WGS84 track or overlays; preferences survive reload; busy and 320/375/1440px layouts verified (simulated SDK).');
  });
  await withServer({},'provider-unconfigured',async context=>{
    const {evaluate,until,sdkRequests}=context;
    await until("boatMonitor.map?.ready && boatMonitor.map.provider==='osm'");
    await evaluate("window.originalOsmMap=boatMonitor.map.map;document.getElementById('mapProviderToggle').click()");
    await until("document.getElementById('toast').classList.contains('show') && !document.getElementById('mapProviderToggle').disabled");
    assert.match(await evaluate("document.getElementById('toast').textContent"),/高德|Key/,'Missing credentials explain how to enable AMap');
    assert.equal(await evaluate("boatMonitor.map.ready && boatMonitor.map.provider==='osm' && boatMonitor.map.map===originalOsmMap"),true,'Missing credentials retain the running OSM map');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Missing credentials do not cover the available base layer');
    assert.equal(sdkRequests.length,0,'Missing credentials never request the SDK');
    console.log('PASS: an unconfigured AMap selection explains missing credentials and leaves the current OSM map usable.');
  });
}

async function main(){
  const configured={BOAT_AMAP_KEY:testKey,BOAT_AMAP_SECURITY_CODE:testCode};
  await withServer(configured,'configured',async context=>{
    const {evaluate,until,send,shot,sdkRequests,configRequests}=context;
    await until("boatMonitor.map?.ready && boatMonitor.map.provider==='amap'");
    assert.equal(configRequests.length,1,'Runtime map configuration loads once');
    assert.equal(sdkRequests.length,1,'Official SDK loads once');
    const sdkUrl=new URL(sdkRequests[0]);
    assert.equal(sdkUrl.origin,'https://webapi.amap.com');assert.equal(sdkUrl.pathname,'/maps');
    assert.equal(sdkUrl.searchParams.get('v'),'2.0');assert.equal(sdkUrl.searchParams.get('key'),testKey);
    assert.match(sdkUrl.searchParams.get('callback'),/^__boatAmapReady/);
    assert.equal(await evaluate('amapTestCalls.security'),testCode,'Security config exists before SDK execution');
    assert.deepEqual(await evaluate('(()=>{const o=amapTestCalls.maps[0].options;return {rotation:o.rotation,pitch:o.pitch,rotateEnable:o.rotateEnable,pitchEnable:o.pitchEnable};})()'),
      {rotation:0,pitch:0,rotateEnable:false,pitchEnable:false},'Navigation remains north-up to keep bearings accurate');
    assert.equal(await evaluate('amapTestCalls.maps[0].style'),'amap://styles/darkblue','AMap initially follows the dark dashboard');
    await evaluate("document.getElementById('themeToggle').click()");
    assert.equal(await evaluate('amapTestCalls.maps[0].style'),'amap://styles/normal','AMap follows the light dashboard');
    await evaluate("document.getElementById('themeToggle').click()");
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'AMap is visible before a location fix arrives');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'AMap shows only a corner hint while waiting for a fix');
    assert.match(await evaluate("document.getElementById('mapFixStatus').textContent"),/等待有效定位/);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('mapFixStatus')).pointerEvents"),'none','AMap fix hint allows gestures through it');
    assert.equal(await evaluate("!!document.querySelector('.boat-pin,.map-velocity-anchor')"),false,'AMap has no fabricated boat or velocity overlay');
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),5,'AMap keeps the previous default zoom without a fix');
    await evaluate("document.querySelector('.boat-map-zoom [aria-label=地图放大]').click()");
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),6,'AMap zoom control works without a fix');
    const waitingPoint=await evaluate('boatMonitor.map.latLngToContainerPoint([31.23,121.47])');
    await evaluate('boatMonitor.map.panBy([40,20]);void 0');
    const pannedWaitingPoint=await evaluate('boatMonitor.map.latLngToContainerPoint([31.23,121.47])');
    assert.ok(Math.hypot(pannedWaitingPoint.x-waitingPoint.x,pannedWaitingPoint.y-waitingPoint.y)>10,'AMap pans without a fix');
    await evaluate('boatMonitor.map.setView([31.23,121.47],5,{animate:false});void 0');
    await shot('amap-sdk-simulation-waiting');
    await evaluate('telemetryOverrides={rtkFlags:14}');
    await startTelemetry(context);await wait(1400);
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Live telemetry without a fix leaves AMap visible');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'Invalid RTK fix keeps the corner hint');
    assert.equal(await evaluate("!!document.querySelector('.boat-pin,.map-velocity-anchor')"),false,'Invalid fix never places a boat or arrow');
    await evaluate('telemetryOverrides={};feedTelemetry()');await wait(1400);
    await until('boatMonitor.track.pointCount>=2 && !!document.querySelector(".map-velocity-anchor")');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),true,'A fresh fix clears the AMap waiting hint');
    // 船位逐帧更新、数字每 200 ms 更新；固定同一帧后比较，避免把刷新频率差当坐标偏移。
    await evaluate('stopTelemetry();feedTelemetry()');await wait(250);
    const coordinates=await evaluate(`(()=>{
      const markers=amapTestCalls.markers.filter(marker=>marker.map),boat=markers.find(marker=>marker.content.classList.contains('boat-pin')),
        arrows=markers.find(marker=>marker.content.classList.contains('map-velocity-anchor')),
        lines=amapTestCalls.polylines.filter(line=>line.map),track=boatMonitor.track.segments[0],
        first=track[0],last=track[track.length-1],convert=BoatModules.mapCoordinates.wgs84ToGcj02;
      return {raw:{lat:Number(document.getElementById('latitude').textContent),lng:Number(document.getElementById('longitude').textContent)},
        boat:boat.position,arrows:arrows.position,expected:convert(Number(document.getElementById('latitude').textContent),Number(document.getElementById('longitude').textContent)),
        trackFirst:first,lineFirst:lines[0].path[0],expectedFirst:convert(first.latitude,first.longitude),
        trackLast:last,lineLast:lines.at(-1).path.at(-1),expectedLast:convert(last.latitude,last.longitude),
        arrowRaw:boatMonitor.mapVectors.marker.getLatLng()};})()`);
    const close=(actual,expected,message)=>{
      assert.ok(Math.abs(actual[0]-expected.longitude)<2e-7&&Math.abs(actual[1]-expected.latitude)<2e-7,message+': '+JSON.stringify({actual,expected}));
    };
    assert.equal(coordinates.raw.lng,121.7654321,'Displayed WGS84 longitude is not converted');
    assert.equal(coordinates.trackFirst.longitude,121.7654321,'Stored track remains WGS84');
    close(coordinates.boat,coordinates.expected,'Boat converts WGS84 to GCJ02 once');
    close(coordinates.arrows,coordinates.expected,'Arrows share the converted boat origin');
    close(coordinates.lineFirst,coordinates.expectedFirst,'First track point converts exactly once');
    close(coordinates.lineLast,coordinates.expectedLast,'Last track point converts exactly once');
    assert.ok(Math.abs(coordinates.boat[0]-coordinates.raw.lng)>.001,'Mainland location is meaningfully transformed');
    assert.equal(coordinates.arrowRaw.lng,coordinates.raw.lng,'Marker facade retains raw WGS84 coordinates');
    await evaluate('startTelemetry()');
    assert.match(await evaluate("document.getElementById('mapStatus').textContent"),/高德/);
    await evaluate("document.getElementById('mapFollow').checked=false;boatMonitor.map.panBy([40,20]);boatMonitor.map.setZoom(17);void 0");
    assert.equal(await evaluate("(()=>{const node=boatMonitor.mapVectors.marker.getElement().getBoundingClientRect(),rect=document.getElementById('map').getBoundingClientRect(),p=boatMonitor.map.latLngToContainerPoint(boatMonitor.mapVectors.marker.getLatLng());return Math.abs(node.left-rect.left-p.x)<1&&Math.abs(node.top-rect.top-p.y)<1;})()"),true,'Arrows stay anchored after pan and zoom');
    await evaluate("document.getElementById('mapFollow').checked=true;document.getElementById('mapCenter').click()");await wait(250);
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),16,'Center action is provider independent');
    await evaluate("document.querySelector('.boat-map-zoom [aria-label=地图放大]').click()");
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),17,'Accessible AMap zoom-in control updates the map');
    await evaluate("document.querySelector('.boat-map-zoom [aria-label=地图缩小]').click()");
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),16,'Accessible AMap zoom-out control updates the map');
    await evaluate("window.amapWorkspaceReferences={map:boatMonitor.map,nativeMap:boatMonitor.map.map,track:boatMonitor.track,points:boatMonitor.track.pointCount};BoatWorkspace.navigate('navigation');void 0");
    await until("BoatWorkspace.current==='navigation'&&document.getElementById('map').clientWidth>0");
    assert.equal(await evaluate("document.getElementById('navigation').closest('[data-workspace-view]').dataset.workspaceView"),'navigation','AMap opens on its dedicated navigation page');
    await shot('amap-workspace-navigation');
    await evaluate("BoatWorkspace.navigate('attitude');void 0");await until("BoatWorkspace.current==='attitude'&&document.getElementById('imuPanel').getBoundingClientRect().width>0");
    assert.equal(await evaluate("document.getElementById('imuHorizon').dataset.valid"),'true','Dedicated attitude instruments remain live while AMap is hidden');
    await evaluate("BoatWorkspace.navigate('overview');void 0");await until("BoatWorkspace.current==='overview'&&document.getElementById('map').clientWidth>0");
    assert.equal(await evaluate('boatMonitor.map===amapWorkspaceReferences.map&&boatMonitor.map.map===amapWorkspaceReferences.nativeMap&&boatMonitor.track===amapWorkspaceReferences.track'),true,'Page switching reuses the same AMap and track instances');
    assert.ok(await evaluate('boatMonitor.track.pointCount')>=await evaluate('amapWorkspaceReferences.points'),'AMap page switching preserves recorded points');
    await evaluate("document.getElementById('imuPanel').scrollIntoView({block:'center',behavior:'instant'})");
    assert.equal(await evaluate("document.getElementById('imuHorizon').dataset.valid"),'true','IMU horizon remains live with AMap');
    await shot('amap-sdk-simulation-desktop');
    await evaluate("document.getElementById('mapVectorsToggle').click()");await until("!document.querySelector('.map-velocity-anchor')");
    await evaluate("document.getElementById('mapVectorsToggle').click()");await until("!!document.querySelector('.map-velocity-anchor')");
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:true});await wait(300);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'AMap panel fits mobile viewport');
    await shot('amap-sdk-simulation-mobile');
    await evaluate('stopTelemetry()');await wait(1300);
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false,'Stale vectors disappear with AMap');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Expired RTK data does not hide the AMap base layer');
    assert.equal(await evaluate("document.getElementById('mapFixStatus').hidden"),false,'Expired data shows a corner hint');
    const trackPoints=await evaluate('boatMonitor.track.pointCount');
    await evaluate("document.getElementById('disconnectButton').click()");
    assert.equal(await evaluate("amapTestCalls.markers.filter(marker=>marker.map).length"),0,'Disconnect clears boat and velocity overlays');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Disconnect retains the AMap base layer');
    assert.equal(await evaluate('boatMonitor.track.pointCount'),trackPoints,'Disconnect retains the recorded track');
    console.log('PASS: AMap browser contract, SDK URL/security order, WGS84 data/GCJ02 display, track/boat/vector alignment, map use without a fix and non-blocking hints, navigation, IMU, stale/hide and mobile (simulated SDK).');
  });
  await withServer(configured,'map-delayed',async context=>{
    const {evaluate,until}=context;
    await until("window.amapTestCalls?.maps.length===1 && boatMonitor.map.switching");
    assert.equal(await evaluate('boatMonitor.map.ready'),false,'Constructing AMap does not mark the base layer ready');
    assert.notEqual(await evaluate('boatMonitor.map.status.tone'),'success','AMap does not report success before complete');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),false,'Loading overlay remains until map rendering completes');
    assert.equal(await evaluate("document.getElementById('mapProviderToggle').disabled"),true,'The switch button stays busy until complete');
    await until("boatMonitor.map.ready && !boatMonitor.map.switching");
    assert.equal(await evaluate('amapTestCalls.events.includes("complete")'),true,'The SDK complete event releases the ready state');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'The completed map removes the loading overlay');
    console.log('PASS: AMap reports readiness only after the asynchronous complete event, with accurate loading and button states.');
  });
  for(const mode of ['sdk-failed','config-failed','map-incomplete','map-error'])await withServer(configured,mode,async context=>{
    const {evaluate,until,sdkRequests,shot}=context;
    await until("!boatMonitor.map.ready && !boatMonitor.map.switching && /失败|不可用|超时/.test(document.getElementById('mapStatus').textContent)",25000);
    assert.equal(sdkRequests.length,mode==='config-failed'?0:1,'No SDK request follows failed config');
    if(mode==='map-incomplete')assert.match(await evaluate("document.getElementById('mapStatus').textContent"),/超时/,'Missing complete produces an explicit rendering timeout');
    if(mode==='map-error')assert.equal(await evaluate('amapTestCalls.events.includes("error")'),true,'A renderer error event rejects initialization');
    await startTelemetry(context);await wait(250);
    assert.equal(await evaluate("document.getElementById('boatActual').textContent"),'1.552','Map failure does not stop boat telemetry');
    assert.equal(await evaluate("document.getElementById('imuHorizon').dataset.valid"),'true','Map failure does not stop IMU');
    assert.notEqual(await evaluate("document.getElementById('latitude').textContent"),'--','Coordinates remain readable when map fails');
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),false,'Map failure remains visible while coordinates arrive');
    if(mode==='sdk-failed')await shot('amap-sdk-failure');
    assert.match(await evaluate("document.getElementById('mapProviderToggle').textContent"),/OSM/,'A failed initial map offers direct OSM recovery');
    await evaluate("document.getElementById('mapProviderToggle').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='osm'");
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Manual OSM recovery removes the map failure overlay after '+mode);
    assert.equal(await evaluate('boatMonitor.link.connected'),true,'Manual OSM recovery preserves the telemetry connection after '+mode);
    await until("!!document.querySelector('.boat-pin') && !!document.querySelector('.map-velocity-anchor')");
    assert.equal(await evaluate("document.getElementById('boatActual').textContent"),'1.552','Telemetry keeps updating after manual OSM recovery');
    console.log('PASS: '+mode+' is isolated from other monitoring widgets and the switch button restores OSM without disconnecting telemetry.');
  });
  await providerSwitchBrowser();
  if(!process.argv.includes('--map-only'))await settingsBrowser();
  console.log('Screenshots: '+output+' (AMap images use an explicitly labelled simulated SDK).');
}
(process.argv.includes('--settings-only')?settingsBrowser():process.argv.includes('--switch-only')?providerSwitchBrowser():main()).catch(error=>{console.error(error);process.exitCode=1;});
