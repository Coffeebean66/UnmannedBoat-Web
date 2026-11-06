/* 真实 Chrome 缩放专项：鼠标/触屏、精确尺寸、持久化及共享仪表恢复；仅使用本机模拟遥测。 */
'use strict';
const assert=require('node:assert/strict');
const {withServer,startTelemetry,login}=require('./amap-browser.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const storage='boat-driver-platform-layout-v1';
async function main(){
  await withServer({BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only'},'layout',async context=>{
    const {evaluate,until,send,viewportShot}=context;
    await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.layoutResizeErrors=[];addEventListener("error",e=>{if(/ResizeObserver/.test(e.message))layoutResizeErrors.push(e.message)})'});
    const selector=id=>'[data-driver-layout-module="'+id+'"]';
    const rect=async css=>evaluate('(()=>{const r=document.querySelector('+JSON.stringify(css)+').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()');
    const box=id=>rect(selector(id));
    const select=async id=>evaluate('document.getElementById("driverLayoutModule").value='+JSON.stringify(id)+';document.getElementById("driverLayoutModule").dispatchEvent(new Event("change"))');
    const size=async(id,width,height)=>{
      await select(id);
      await evaluate('document.getElementById("driverPartWidth").value='+JSON.stringify(String(width))+';document.getElementById("driverPartHeight").value='+JSON.stringify(String(height))+';document.getElementById("driverPartWidth").dispatchEvent(new Event("change"))');await wait(60);
    };
    const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<2,message+': '+actual+' vs '+expected);
    const pointer=async(id,dx,dy,{kind='resize',touch=false,beforeEnd}={})=>{
      const css=selector(id)+' > .driver-layout-'+(kind==='resize'?'resize':'grip');
      const point=await evaluate('(()=>{const n=document.querySelector('+JSON.stringify(css)+'),r=n.getBoundingClientRect(),x=r.left+Math.min(r.width/2,15),y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:hit===n||n.contains(hit)};})()');
      assert.equal(point.hit,true,'Pointer reaches the '+id+' '+kind+' handle: '+JSON.stringify(point));
      if(touch)await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});
      else await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
      for(let i=1;i<=6;i++){
        const x=point.x+dx*i/6,y=point.y+dy*i/6;
        if(touch)await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y,id:1}]});
        else await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'left',buttons:1});await wait(20);
      }
      if(beforeEnd)await beforeEnd();
      if(touch)await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      else await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',buttons:0,clickCount:1});await wait(80);
    };
    await login(context,'operator','browser-admin-test-only');await startTelemetry(context);
    await evaluate('BoatWorkspace.navigate("attitude",{focus:false})');await wait(100);
    const shared=await evaluate('[...document.querySelectorAll(".imu-horizon-panel,.sensor-compass-panel,.imu-euler-values")].map(n=>({id:n.dataset.driverLayoutModule,style:n.style.cssText,sized:n.dataset.driverSized}))');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.setInstrumentsVisible(true);document.getElementById("driverLayoutToggle").click();window.layoutResizeErrors=[];window.addEventListener("error",e=>{if(/ResizeObserver/.test(e.message))layoutResizeErrors.push(e.message)});window.originalLayoutInstances={map:boatMonitor.map,viewer:boatMonitor.viewer,video:boatMonitor.videoView};void 0');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await wait(120);
    assert.equal(await evaluate('boatMonitor.driver.layout.editing&&!boatMonitor.driver.active'),true);
    // 留出设置面板所在的中央区域，使用真实鼠标拖动仪表右下角。
    const horizon=await box('horizon');await pointer('horizon',110-horizon.left,130-horizon.top,{kind:'move'});
    const before=await box('horizon'),compass=await box('compass');
    await pointer('horizon',130,90);
    const after=await box('horizon');near(after.width,before.width+130,'Horizon width follows the mouse');near(after.height,before.height+90,'Horizon height follows the mouse');
    near(after.left,before.left,'Resizing keeps the top-left anchor');near(after.top,before.top,'Resizing keeps the top-left anchor');
    assert.deepEqual(await box('compass'),compass,'Resizing one gauge leaves its neighbor in place');
    const gauge=await rect('#imuHorizon');near(gauge.width,Math.min(after.width,after.height),'Instrument scales within its resized frame');
    await evaluate('document.querySelector("[data-driver-layout-module=horizon]>.driver-layout-resize").focus()');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    near((await box('horizon')).width,after.width+20,'Shift + resize arrow adjusts width by 20 px');
    await size('compass',210,180);const compassGauge=await rect('#compassCard .compass-stage');near(compassGauge.width,180,'Compass scales its dial');near(compassGauge.height,180,'Compass remains round');
    await size('angles',300,60);near((await box('angles')).width,300,'Euler values resize independently');
    await size('navigation',540,120);near((await box('navigation')).width,540,'Readout exact width');
    await size('hud',700,350);near((await box('hud')).height,350,'HUD exact height');
    await size('console',500,200);near((await box('console')).width,500,'Control strip exact width');
    await evaluate('document.getElementById("driverLayoutDone").click();boatMonitor.driver.navigation.selectMode("auto")');
    await until('document.querySelector(".driver-console").getBoundingClientRect().height>=250');
    await evaluate('boatMonitor.driver.navigation.selectMode("manual");document.getElementById("driverLayoutToggle").click()');await wait(80);
    near((await box('console')).height,200,'Returning to manual restores the saved height after automatic minimum expansion');
    await size('mission',300,170);near((await box('mission')).height,170,'Task status exact height');
    await size('map',440,290);near((await box('map')).width,440,'Map exact width');
    await evaluate('document.getElementById("driverPartWidth").focus();document.getElementById("driverPartWidth").select()');
    await send('Input.insertText',{text:'455'});await wait(250);
    assert.equal(await evaluate('document.getElementById("driverPartWidth").value'),'455','Periodic layout updates preserve partially edited input');
    for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,code:'Tab',key:'Tab',windowsVirtualKeyCode:9});
    near((await box('map')).width,455,'Native keyboard editing commits exact dimensions');await size('map',440,290);
    await until('Math.abs(boatMonitor.map.getSize().x-boatMonitor.map.container.clientWidth)<2');
    const mapContent=await rect('#map');near(mapContent.height,290-34,'Map content follows its outer frame');
    await select('video');assert.equal(await evaluate('document.getElementById("driverPartWidth").disabled'),true,'Fullscreen primary media remains full-viewport');
    const video=await box('video');near(video.width,1440,'Primary video remains fullscreen');near(video.height,900,'Primary video remains fullscreen');
    await evaluate('document.getElementById("driverDetailsToggle").click()');
    await size('details',480,420);near((await box('details')).height,420,'Details frame resizes');
    for(const [id,width,height]of [['motors',390,220],['model',420,450]]){
      await select(id);await evaluate('document.getElementById("driverLayoutFloat").click()');await size(id,width,height);
      near((await box(id)).width,width,id+' floating width');near((await box(id)).height,height,id+' floating height');
    }
    await until('document.getElementById("boatCanvas").clientHeight>200');
    assert.equal(await evaluate('originalLayoutInstances.map===boatMonitor.map&&originalLayoutInstances.viewer===boatMonitor.viewer&&originalLayoutInstances.video===boatMonitor.videoView'),true,'Resizing reuses map/model/video instances');
    await size('emergency',1,1);const emergency=await box('emergency');assert.ok(emergency.width>=96&&emergency.height>=44);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".driver-emergency-dock")).opacity'),'1');
    await size('horizon',99999,99999);const huge=await box('horizon');assert.ok(huge.width<=1440&&huge.height<=900&&huge.left>=-1&&huge.top>=-1&&huge.right<=1441&&huge.bottom<=901,'Oversized input stays inside the viewport');
    await size('horizon',230,190);
    await select('horizon');await evaluate('document.getElementById("driverPartWidth").value="";document.getElementById("driverPartWidth").dispatchEvent(new Event("change"))');near((await box('horizon')).width,230,'Empty input does not corrupt dimensions');
    await evaluate('document.getElementById("driverMapExpand").click()');await wait(100);
    assert.equal(await evaluate('document.querySelector("[data-driver-layout-module=map]").dataset.driverSized'),undefined,'Primary map sheds inset dimensions');near((await box('map')).width,1440,'Map fills viewport when promoted');
    await size('video',400,240);near((await box('video')).width,400,'Video inset also supports exact dimensions');
    await evaluate('document.getElementById("driverVideoExpand").click()');await wait(100);near((await box('map')).width,440,'Switching back restores the previous inset dimensions');
    // 实际刷新恢复尺寸、旧位置与透明度；构造过程中不重写或删除原存档。
    const saved=await evaluate('localStorage.getItem('+JSON.stringify(storage)+')');
    assert.deepEqual(await evaluate('layoutResizeErrors'),[],'Desktop resizing has no ResizeObserver errors');
    await evaluate('document.getElementById("driverLayoutDone").click()');await send('Page.reload');await until('window.boatMonitor?.driver?.layout&&BoatAuth.ready');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.setInstrumentsVisible(true)');await wait(130);
    near((await box('horizon')).width,230,'Width survives an actual reload');near((await box('map')).height,290,'Map height survives an actual reload');
    assert.equal(await evaluate('localStorage.getItem('+JSON.stringify(storage)+')'),saved,'Loading preserves the saved preferences');
    assert.equal(await evaluate('boatMonitor.driver.active'),false,'Reloading never re-arms control');
    await evaluate('BoatWorkspace.navigate("attitude",{focus:false})');await wait(150);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".imu-horizon-panel,.sensor-compass-panel,.imu-euler-values")].map(n=>({id:n.dataset.driverLayoutModule,style:n.style.cssText,sized:n.dataset.driverSized}))'),shared,'Shared instruments restore their original appearance outside driving');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false});document.getElementById("driverLayoutToggle").click()');
    for(const [width,height]of [[375,812],[320,667]]){
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await wait(130);
      near((await box('map')).height,126,'Mobile starts with its own native inset size');
      await size('map',width-24,200);near((await box('map')).width,width-24,'Mobile exact dimensions');
      await select('navigation');await size('navigation',width-16,104);
      const old=await box('map');
      await select('map');await evaluate('if(!document.getElementById("driverLayoutControls").hidden)document.getElementById("driverLayoutCompact").click()');
      assert.equal(await evaluate('(()=>{const b=document.getElementById("driverImmersiveToggle"),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===b||b.contains(hit);})()'),true,'Selecting the inset keeps the return button above the background');
      await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
      await pointer('map',-30,40,{touch:true});const resized=await box('map');near(resized.width,old.width-30,'Touch changes width');near(resized.height,old.height+40,'Touch changes height');
      await send('Emulation.setTouchEmulationEnabled',{enabled:false});
      await evaluate('document.getElementById("driverLayoutCompact").click()');
      // 恢复默认大小不重置透明度或位置；单项恢复和全部恢复同时清尺寸。
      await select('map');await evaluate('document.getElementById("driverPartOpacity").value="65";document.getElementById("driverPartOpacity").dispatchEvent(new Event("input"));document.getElementById("driverPartSizeReset").click()');
      near((await box('map')).height,126,'Size-only reset restores the responsive inset');assert.equal(await evaluate('document.getElementById("driverPartOpacityValue").textContent'),'65%');
      await size('map',width-32,180);
      for(const theme of ['dark','light']){
        await evaluate('document.documentElement.dataset.theme==="'+theme+'"||document.getElementById("themeToggle").click()');await viewportShot('driver-resize-'+width+'-'+theme);
        assert.equal(await evaluate('(()=>{const editor=document.getElementById("driverLayoutEditor"),r=editor.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=0&&r.right<=innerWidth&&editor.scrollWidth<=editor.clientWidth;})()'),true,'Editor fields fit the '+width+' '+theme+' viewport');
      }
      await select('map');await evaluate('document.getElementById("driverLayoutResetPart").click()');near((await box('map')).height,126,'Part reset removes size');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await wait(130);near((await box('map')).width,440,'Returning to desktop restores its independent dimensions');
    await select('horizon');await viewportShot('driver-resize-desktop');
    // 在一次未松手的缩放中切主画面，不能把旧 pointermove 写入另一组偏好。
    await pointer('horizon',10,10,{beforeEnd:async()=>evaluate('void boatMonitor.driver.setMediaFocus("map")')});
    assert.equal(await evaluate('boatMonitor.driver.layout.drag'),null,'Switching profiles ends an active resize');
    assert.equal(await evaluate('boatMonitor.driver.layout.profiles["desktop:map"].horizon'),undefined,'Old resize events never leak into another profile');
    await evaluate('document.getElementById("driverLayoutResetAll").click();document.getElementById("driverLayoutDone").click()');
    assert.equal(await evaluate('document.querySelectorAll("#view-driving [data-driver-sized]").length'),0,'Full reset clears all custom sizes');
    assert.equal(await evaluate('document.querySelector(".driver-instrument-grid").hidden'),true);
    assert.deepEqual(await evaluate('layoutResizeErrors'),[],'Resize observers settle without feedback loops');
    // 旧版只存位置/透明度的布局可继续加载；异常宽高不能污染样式。
    await evaluate('localStorage.setItem('+JSON.stringify(storage)+',JSON.stringify({version:1,profiles:{"desktop:video":{map:{x:.8,y:.1,opacity:65},horizon:{width:"300",height:-2},emergency:{width:1,height:1,opacity:5}}}}))');
    await send('Page.reload');await until('window.boatMonitor?.driver?.layout&&BoatAuth.ready');
    await evaluate('BoatWorkspace.navigate("driving",{focus:false})');await wait(100);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".driver-region-map")).opacity'),'0.65','Old opacity remains valid');
    near((await box('map')).height,234,'Old profiles without dimensions retain responsive defaults');
    assert.equal(await evaluate('boatMonitor.driver.layout.profiles["desktop:video"].horizon.width'),undefined,'Invalid stored sizes are discarded');
    assert.ok((await box('emergency')).height>=44,'Tiny stored emergency size is clamped');
    await evaluate('document.getElementById("driverLayoutToggle").click();window.layoutRefreshCount=0;window.layoutOriginalRefresh=boatMonitor.driver.layout.refresh;boatMonitor.driver.layout.refresh=function(){layoutRefreshCount++;return layoutOriginalRefresh.call(this)}');
    await wait(150);const count=await evaluate('layoutRefreshCount');await wait(250);assert.ok((await evaluate('layoutRefreshCount'))-count<8,'Layout has no persistent animation/resize loop');
    await evaluate('window.layoutOriginalStore=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error("test quota")};void 0');
    try{await size('emergency',150,64);assert.match(await evaluate('document.getElementById("driverLayoutSaved").textContent'),/无法保存/,'Blocked storage does not claim persistence');}
    finally{await evaluate('Storage.prototype.setItem=layoutOriginalStore;void 0');}
    console.log('PASS: all 13 modules; real mouse/touch resizing and keyboard size steps; precise dimensions and round SVGs; neighbor stability; map/canvas adaptation; bounds and emergency minimum; desktop/mobile/media isolation; actual reload, legacy and malformed storage; reset, profile-switch capture and shared-page restoration.');
  });
}
main().catch(error=>{console.error(error);process.exitCode=1;});
