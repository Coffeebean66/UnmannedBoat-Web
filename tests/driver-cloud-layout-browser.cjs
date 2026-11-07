/* 两个独立 Chrome 登录管理员 / 驾驶员，验证发布、自动同步、旧偏好恢复和刷新。 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {withServer,browserSession,startTelemetry,login}=require('./amap-browser.cjs');
const STORAGE='boat-driver-platform-layout-v1';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function clickVisible(browser,id){
  await browser.evaluate('document.getElementById('+JSON.stringify(id)+').scrollIntoView({block:"nearest"})');await pause(80);
  const hit=await browser.evaluate('(()=>{const b=document.getElementById('+JSON.stringify(id)+'),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,visible:!b.disabled&&document.elementFromPoint(x,y)?.closest("button")===b};})()');
  assert.equal(hit.visible,true,id+' is visible and receives real pointer hits');
  for(const type of ['mousePressed','mouseReleased'])await browser.send('Input.dispatchMouseEvent',{type,x:hit.x,y:hit.y,button:'left',clickCount:1});
}
async function main(){
  const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
  const state=fs.mkdtempSync(path.join(output,'driver-cloud-layout-state-'));
  await withServer({BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'operator',BOAT_ADMIN_PASSWORD:'browser-admin-test-only'},'cloud-layout',async admin=>{
    await login(admin,'operator','browser-admin-test-only');
    assert.equal(await admin.evaluate('(async()=>{const r=await fetch("/api/auth/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"layout-pilot",password:"layout-pilot-test-only",role:"driver"})});return r.status;})()'),201);
    await startTelemetry(admin);
    await admin.evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.setInstrumentsVisible(true);boatMonitor.driver.setOverlayOpacity(75);void 0');
    await admin.until('boatMonitor.driver.cloudLayout.loaded&&!boatMonitor.driver.cloudLayout.busy');
    const published={'desktop:video':{map:{x:.7,y:.1,width:420,height:270,opacity:85},horizon:{x:.12,y:.15,width:180,height:180,opacity:70},emergency:{opacity:100}},'desktop:map':{video:{x:.7,y:.1,width:410,height:260,opacity:80},horizon:{x:.1,y:.16,width:175,height:175,opacity:65}},'mobile:video':{map:{x:.9,y:.16,width:170,height:130,opacity:80},horizon:{x:.02,y:.6,width:90,height:90,opacity:70}}};
    await admin.evaluate('boatMonitor.driver.layout.profiles='+JSON.stringify(published)+';boatMonitor.driver.layout.save();boatMonitor.driver.layout.refresh();document.getElementById("driverLayoutToggle").click()');
    const adminLocal=await admin.evaluate('localStorage.getItem('+JSON.stringify(STORAGE)+')');
    await browserSession(admin.server,'cloud-layout',async pilot=>{
      await login(pilot,'layout-pilot','layout-pilot-test-only');await startTelemetry(pilot);
      const personal={'desktop:video':{map:{x:.6,y:.12,width:300,height:210,opacity:40},horizon:{x:.05,y:.3,width:120,height:120,opacity:50}}};
      await pilot.evaluate('BoatWorkspace.navigate("driving",{focus:false});boatMonitor.driver.layout.profiles='+JSON.stringify(personal)+';boatMonitor.driver.layout.save();boatMonitor.driver.layout.refresh();boatMonitor.driver.setOverlayOpacity(90);boatMonitor.driver.setInstrumentsVisible(false);boatMonitor.driver.cloudLayout.pollMs=250;void 0');
      await pilot.until('boatMonitor.driver.cloudLayout.loaded&&!boatMonitor.driver.cloudLayout.busy');
      await pilot.evaluate('void boatMonitor.driver.cloudLayout.read()');
      const pilotLocal=await pilot.evaluate('localStorage.getItem('+JSON.stringify(STORAGE)+')');
      assert.equal(await pilot.evaluate('document.getElementById("driverCloudLayoutActions").hidden'),true);
      assert.equal(await pilot.evaluate('(async()=>{const r=await fetch("/api/driver-layout",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:0,enabled:true})});return r.status;})()'),403);
      await clickVisible(admin,'driverCloudLayoutUpload');
      await admin.until('boatMonitor.driver.cloudLayout.state?.layout&&!boatMonitor.driver.cloudLayout.busy');
      assert.equal(await admin.evaluate('boatMonitor.driver.cloudLayout.state.enabled'),false,'Uploading does not publish');
      assert.equal(await pilot.evaluate('boatMonitor.driver.layout.cloudLocked'),false);
      await clickVisible(admin,'driverCloudLayoutEnable');
      await admin.until('boatMonitor.driver.layout.cloudLocked&&!boatMonitor.driver.cloudLayout.busy');
      await pilot.until('boatMonitor.driver.layout.cloudLocked');
      assert.deepEqual(await pilot.evaluate('Object.fromEntries(Object.entries(boatMonitor.driver.layout.profiles["desktop:video"]).filter(([,value])=>Object.keys(value).length))'),published['desktop:video']);
      assert.equal(await pilot.evaluate('document.querySelector(".driver-region-map").getBoundingClientRect().width'),420);
      assert.equal(await pilot.evaluate('document.getElementById("driverOverlayOpacity").value'),'75');
      assert.equal(await pilot.evaluate('document.querySelector(".driver-instrument-grid").hidden'),false);
      assert.equal(await pilot.evaluate('localStorage.getItem('+JSON.stringify(STORAGE)+')'),pilotLocal,'Cloud application never overwrites local profiles');
      assert.equal(await pilot.evaluate('localStorage.getItem("boat-driver-console-hud-opacity")'),'90','Cloud opacity never overwrites the personal preference');
      await pilot.evaluate('document.getElementById("driverLayoutToggle").click();document.getElementById("driverLayoutModule").value="map";document.getElementById("driverLayoutModule").dispatchEvent(new Event("change"));document.getElementById("driverPartWidth").value="600";document.getElementById("driverPartWidth").dispatchEvent(new Event("change"));document.getElementById("driverLayoutResetAll").click()');
      assert.equal(await pilot.evaluate('document.getElementById("driverPartWidth").disabled'),true);
      assert.equal(await pilot.evaluate('getComputedStyle(document.querySelector("[data-driver-layout-module=map]>.driver-layout-grip")).display'),'none');
      assert.equal(await pilot.evaluate('document.querySelector(".driver-region-map").getBoundingClientRect().width'),420,'Disabled editor cannot change published dimensions');
      assert.equal(await pilot.evaluate('getComputedStyle(document.querySelector(".driver-emergency-dock")).opacity'),'1');
      assert.equal(await pilot.evaluate('boatMonitor.driver.active'),false,'Syncing never acquires the boat');
      await pilot.evaluate('document.getElementById("driverLayoutDone").click();document.getElementById("driverMapExpand").click()');await pause(120);
      assert.equal(await pilot.evaluate('document.querySelector(".driver-region-video").getBoundingClientRect().width'),410);
      await pause(400);assert.equal(await pilot.evaluate('document.getElementById("view-driving").dataset.primary'),'map','Same revision polling preserves interactive media switches');
      await pilot.send('Page.reload');await pilot.until('window.boatMonitor?.driver?.layout?.cloudLocked&&BoatAuth.ready');
      assert.equal(await pilot.evaluate('document.querySelector(".driver-region-map").getBoundingClientRect().width'),420,'Actual reload uses cloud layout, not local preference');
      assert.equal(await pilot.evaluate('localStorage.getItem('+JSON.stringify(STORAGE)+')'),pilotLocal);
      for(const [width,height]of [[1440,900],[375,812],[320,667]]){
        await pilot.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760});await pause(120);
        await pilot.evaluate('document.getElementById("driverLayoutToggle").click()');
        for(const theme of ['dark','light']){
          await pilot.evaluate('document.documentElement.dataset.theme==="'+theme+'"||document.getElementById("themeToggle").click()');await pilot.viewportShot('driver-cloud-layout-'+width+'-'+theme);
          assert.equal(await pilot.evaluate('(()=>{const e=document.getElementById("driverLayoutEditor"),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth&&r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;})()'),true,'Cloud controls fit '+width+' '+theme);
        }
        if(width<760)assert.equal(await pilot.evaluate('document.querySelector(".driver-region-map").getBoundingClientRect().width'),170,'Mobile uses its own published profile');
        await pilot.evaluate('document.getElementById("driverLayoutDone").click()');
      }
      await pilot.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
      await clickVisible(admin,'driverCloudLayoutDisable');
      await admin.until('!boatMonitor.driver.layout.cloudLocked&&!boatMonitor.driver.cloudLayout.busy');
      // 刷新后恢复正式10秒轮询，临时缩短只影响本机专项测试。
      await pilot.evaluate('boatMonitor.driver.cloudLayout.pollMs=250;void boatMonitor.driver.cloudLayout.read()');await pilot.until('!boatMonitor.driver.layout.cloudLocked');
      assert.equal(await pilot.evaluate('document.querySelector(".driver-region-map").getBoundingClientRect().width'),300);
      assert.equal(await pilot.evaluate('document.getElementById("driverOverlayOpacity").value'),'90');
      assert.equal(await pilot.evaluate('document.querySelector(".driver-instrument-grid").hidden'),true);
      assert.equal(await pilot.evaluate('localStorage.getItem('+JSON.stringify(STORAGE)+')'),pilotLocal);
      assert.equal(await admin.evaluate('localStorage.getItem('+JSON.stringify(STORAGE)+')'),adminLocal);
      assert.equal(await pilot.evaluate('document.getElementById("driverOverlayOpacity").disabled'),false);
      await admin.send('Emulation.setDeviceMetricsOverride',{width:320,height:667,deviceScaleFactor:1,mobile:true});await pause(120);
      await admin.evaluate('document.getElementById("driverCloudLayoutActions").scrollIntoView({block:"nearest"})');
      for(const theme of ['dark','light']){
        await admin.evaluate('document.documentElement.dataset.theme==="'+theme+'"||document.getElementById("themeToggle").click()');
        await admin.viewportShot('driver-cloud-layout-admin-320-'+theme);
        assert.equal(await admin.evaluate('(()=>{const e=document.getElementById("driverLayoutEditor");return e.scrollWidth<=e.clientWidth&&document.documentElement.scrollWidth<=innerWidth;})()'),true,'Administrator cloud actions fit 320px '+theme);
      }
      await clickVisible(admin,'driverCloudLayoutEnable');await admin.until('boatMonitor.driver.layout.cloudLocked');
      await pilot.until('boatMonitor.driver.layout.cloudLocked');
      await pilot.evaluate('void BoatAuth.logout()');await pilot.until('!BoatAuth.user&&!BoatAuth.busy');
      assert.equal(await pilot.evaluate('boatMonitor.driver.layout.cloudLocked'),false,'Logout clears the old cloud identity');
      assert.equal(await pilot.evaluate('document.getElementById("driverCloudLayoutActions").hidden'),true);
      await clickVisible(admin,'driverCloudLayoutDisable');await admin.until('!boatMonitor.driver.layout.cloudLocked&&!boatMonitor.driver.cloudLayout.busy');
    });
  },{accountOptions:{storeFile:path.join(state,'accounts.json')}});
  console.log('PASS: independent admin/pilot Chrome sessions; real-pointer upload/enable/disable, automatic synchronization, permission rejection, locked edits, media swap, per-screen profiles, real reload, personal storage preservation, disable restore, logout and 320/375/1440 dark/light layouts.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
