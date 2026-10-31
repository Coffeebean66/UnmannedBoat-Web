/* 使用真实 Chrome / Leaflet 检查卫星切换；瓦片使用标明 test tile 的本地替身，不使用真实 Key。 */
'use strict';
const assert=require('node:assert/strict');
const {withServer,startTelemetry,login}=require('./amap-browser.cjs');
const token='c'.repeat(32),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  if(!process.argv.includes('--recovery-only'))await withServer({BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only',
    BOAT_GUEST_USERNAME:'visitor',BOAT_GUEST_PASSWORD:'browser-guest-test-only',BOAT_AMAP_KEY:'a'.repeat(32),
    BOAT_AMAP_SECURITY_CODE:'b'.repeat(32),BOAT_TIANDITU_KEY:token},'satellite',async context=>{
    const {evaluate,until,send,viewportShot,tileRequests,failures}=context;
    await login(context,'operator','browser-admin-test-only');
    await until("boatMonitor.map.ready && boatMonitor.map.provider==='amap'");
    await startTelemetry(context);
    await evaluate("document.getElementById('trackStart').click();document.getElementById('mapFollow').checked=false;boatMonitor.map.setZoom(17);window.savedSatelliteTrack=JSON.stringify(boatMonitor.track.segments);document.querySelector('#navigation .boat-map-layers [aria-label=卫星地图]').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='arcgis' && document.querySelector('#map .leaflet-tile-loaded')");
    assert.ok(tileRequests.some(url=>url.includes('/World_Imagery/MapServer/tile/')));
    assert.equal(await evaluate("document.getElementById('mapLayerName').textContent"),'ArcGIS World Imagery');
    assert.equal(await evaluate('boatMonitor.map.getZoom()'),17);
    assert.equal(await evaluate('JSON.stringify(boatMonitor.track.segments)===savedSatelliteTrack'),true);
    assert.equal(await evaluate('boatMonitor.link.connected'),true);
    await until("!!document.querySelector('#map .boat-pin') && !!document.querySelector('#map .map-velocity-anchor')");
    await evaluate("document.querySelector('#navigation .boat-map-layers select').value='tianditu';document.querySelector('#navigation .boat-map-layers select').dispatchEvent(new Event('change',{bubbles:true}))");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='tianditu' && document.querySelectorAll('#map .leaflet-tile-pane .leaflet-layer').length===2 && document.querySelector('#map .leaflet-tile-loaded')");
    for(const kind of ['img','cia'])assert.ok(tileRequests.some(url=>url.includes('/'+kind+'_w/wmts?')&&new URL(url).searchParams.get('tk')===token),kind+' requests use the configured browser key');
    assert.equal(await evaluate('JSON.stringify(boatMonitor.track.segments)===savedSatelliteTrack'),true);
    assert.equal(await evaluate("document.getElementById('mapCoordinateSystem').textContent"),'WGS84');
    await evaluate("document.querySelector('#navigation .boat-map-layers [aria-label=平面地图]').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='amap'");
    await evaluate("document.querySelector('#navigation .boat-map-layers [aria-label=卫星地图]').click()");
    await until("boatMonitor.map.ready && !boatMonitor.map.switching && boatMonitor.map.provider==='tianditu'");
    await evaluate("window.beforeSatelliteReload=true");await send('Page.reload');
    await until("!window.beforeSatelliteReload && window.boatMonitor?.map?.ready && boatMonitor.map.provider==='tianditu'");
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'No location is needed to display the remembered satellite map');
    await evaluate("BoatWorkspace.navigate('fleet',{focus:false})");await until('boatMonitor.fleetMapView.map?.ready');
    assert.equal(await evaluate("document.querySelectorAll('#fleetMap .boat-map-layers').length"),1,'Fleet map has the same layer menu');
    await evaluate("BoatWorkspace.navigate('missions',{focus:false})");await until('BoatMissions.map?.ready');
    await evaluate("BoatMissions.editing=true;BoatMissions.render();document.getElementById('missionMap').scrollIntoView({block:'center',behavior:'instant'});window.pointsBeforeSatelliteMenu=BoatMissions.route.points.length");
    await evaluate("document.querySelector('#missionMap .boat-map-layers [aria-label=平面地图]').click()");
    await until("BoatMissions.map.ready && !BoatMissions.map.switching && BoatMissions.map.mode==='planar'");
    await evaluate("document.querySelector('#missionMap .boat-map-layers [aria-label=卫星地图]').click()");
    await until("BoatMissions.map.ready && !BoatMissions.map.switching && BoatMissions.map.mode==='satellite'");
    assert.equal(await evaluate('BoatMissions.route.points.length===pointsBeforeSatelliteMenu'),true,'Menu clicks must not create mission waypoints');
    await evaluate("BoatMissions.map.setView({latitude:31.2,longitude:121.8},17,{animate:false});BoatMissions.map.map.fire('click',{latlng:L.latLng(31.201,121.802)});void 0");
    assert.deepEqual(await evaluate('BoatMissions.route.points.at(-1)'),{latitude:31.201,longitude:121.802},'Satellite waypoint uses WGS84 directly');
    await evaluate("BoatWorkspace.navigate('driving',{focus:false})");
    const fits="(()=>{const box=document.querySelector('#navigation .boat-map-layers'),map=document.getElementById('map'),r=box.getBoundingClientRect(),m=map.getBoundingClientRect();return r.width>0&&r.left>=m.left&&r.right<=m.right+1&&r.top>=m.top&&r.bottom<=m.bottom+1&&[...box.querySelectorAll('button,select')].every(n=>{const p=n.getBoundingClientRect();return n.contains(document.elementFromPoint(p.left+p.width/2,p.top+p.height/2));});})()";
    for(const width of [1440,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});await wait(200);
      if(!await evaluate(fits)){
        await viewportShot('satellite-mini-failure-'+width);
        console.log(await evaluate("[...document.querySelectorAll('#navigation .boat-map-layers button,#navigation .boat-map-layers select')].map(n=>{const r=n.getBoundingClientRect(),h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {element:n.outerHTML,rect:r.toJSON(),hit:h?.outerHTML.slice(0,400)}})"));
      }
      assert.equal(await evaluate(fits),true,'Satellite controls fit the driving mini map at '+width+'px');
      await evaluate("document.getElementById('driverMapExpand').click()");await wait(200);
      assert.equal(await evaluate(fits),true,'Satellite controls fit the main driving map at '+width+'px');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'No horizontal overflow at '+width+'px');
      await viewportShot('satellite-driving-map-'+width);
      await evaluate("document.getElementById('driverMapExpand').click()");
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate("BoatWorkspace.navigate('navigation',{focus:false});document.getElementById('themeToggle').click();document.getElementById('map').scrollIntoView({block:'center',behavior:'instant'})");await wait(200);
    await viewportShot('satellite-navigation-light');
    assert.deepEqual(await evaluate('window.satellitePolicies'),[],'Satellite tile domains are allowed by the actual page CSP');
    failures.tiles=true;
    await evaluate("document.querySelector('#navigation .boat-map-layers select').value='arcgis';document.querySelector('#navigation .boat-map-layers select').dispatchEvent(new Event('change',{bubbles:true}))");
    await until("boatMonitor.map.provider==='arcgis' && boatMonitor.map.status.tone==='warning'");
    assert.match(await evaluate('boatMonitor.map.status.message'),/ArcGIS.*网络/);
    failures.tiles=false;
    console.log('PASS: ArcGIS / Tianditu imagery and labels, coordinate preservation, preference reload, fleet/mission menus, click isolation, no-fix map, tile failure and 1440/375/320px driving layouts (local test tiles).');
  });
  await withServer({},'satellite',async({evaluate,send,until})=>{
    await until('boatMonitor.map.ready');
    await evaluate("localStorage.setItem('boat.map.provider','tianditu');window.beforeMissingKeyReload=true");
    await send('Page.reload');
    await until("!window.beforeMissingKeyReload && window.boatMonitor?.map && !boatMonitor.map.switching && !boatMonitor.map.ready && /天地图/.test(boatMonitor.map.status.message)");
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),false);
    await evaluate("document.getElementById('map').scrollIntoView({block:'center',behavior:'instant'})");
    assert.equal(await evaluate("(()=>{const n=document.querySelector('#navigation .boat-map-layers select'),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()"),true,'Missing-key error overlay must leave the source menu accessible');
    await evaluate("const source=document.querySelector('#navigation .boat-map-layers select');source.value='arcgis';source.dispatchEvent(new Event('change',{bubbles:true}))");
    await until("boatMonitor.map.ready && boatMonitor.map.provider==='arcgis'");
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true);
    console.log('PASS: a saved Tianditu preference with no key reports the error and allows direct ArcGIS recovery through the visible source menu.');
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
