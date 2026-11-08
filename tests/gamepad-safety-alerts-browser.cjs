/* 两个真实浏览器通过登录与SSE接收提醒，仅模拟连接的手柄及震动硬件。 */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { browserSession, login } = require('./amap-browser.cjs');
const { createDriverFixture } = require('./driver-browser-fixture.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = `window.alertRumbles=[];window.alertResets=0;window.alertReceipts=[];window.alertPads=[{index:0,id:'Safety Xbox',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0})),vibrationActuator:{effects:['dual-rumble'],playEffect(kind,options){alertRumbles.push({pad:0,kind,...options});return Promise.resolve('complete');},reset(){alertResets++;return Promise.resolve();}}},{index:1,id:'Safety pulse',connected:true,mapping:'',axes:[],buttons:[],hapticActuators:[{pulse(strength,duration){if(duration>1)alertRumbles.push({pad:1,strength,duration});return Promise.resolve(true);}}]}];Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>alertPads});{const h=boatMonitor.driver.gamepad.haptics,receive=h.receiveAlert;h.receiveAlert=function(value){const receipt={value,at:Date.now(),offset:this.alertServerOffset,allowed:this.canReceive()};alertReceipts.push(receipt);receipt.result=receive.call(this,value);return receipt.result;};}`;
async function main() {
  const output = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'safety-alerts-browser-'));
  const file = path.join(directory, 'haptics.json');
  const server = createDriverFixture({ env: { BOAT_ACCOUNTS_FILE: path.join(directory, 'accounts.json'), BOAT_GAMEPAD_HAPTICS_FILE: file, BOAT_DRIVER_LAYOUT_FILE: path.join(directory, 'layout.json'), BOAT_MAP_CONFIG_FILE: path.join(directory, 'map.json'), BOAT_TELEMETRY_HISTORY_FILE: path.join(directory, 'history.json'), BOAT_OTA_KEY: '' } });
  server.mqttFixture.running = false;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await browserSession(server, 'safety-admin', async admin => {
      await login(admin, 'operator', 'browser-admin-test-only'); await admin.evaluate('BoatWorkspace.navigate("fleet");void 0'); await admin.evaluate(script);
      await admin.until('boatMonitor.driver.gamepad.haptics.loaded&&boatMonitor.driver.gamepad.haptics.alertServerOffset!==null');
      assert.equal(await admin.evaluate('boatMonitor.driver.gamepad.source'), 'keyboard');
      await admin.evaluate('document.getElementById("platformSettingsToggle").click()');
      await admin.until('document.getElementById("platformSettingsDialog").open&&!document.getElementById("gamepadHapticsSave").disabled');
      await admin.evaluate('document.getElementById("gamepadHapticsEnabled").checked=false;document.getElementById("gamepadHapticsIntensity").value="40";document.getElementById("gamepadHapticsIntensity").dispatchEvent(new Event("input"));document.getElementById("gamepadHapticsForm").requestSubmit();void 0');
      await admin.until('boatMonitor.driver.gamepad.haptics.state?.intensityPercent===40&&!boatMonitor.driver.gamepad.haptics.busy');
      assert.equal(JSON.parse(fs.readFileSync(file)).intensityPercent, 40);
      await admin.evaluate(`void fetch('/api/auth/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'safety-pilot',password:'safety-pilot-test',role:'driver'})}).then(r=>{if(!r.ok)throw Error('create pilot');window.safetyPilotReady=true;});`);
      await admin.until('window.safetyPilotReady');
      await browserSession(server, 'safety-receiver', async receiver => {
        await login(receiver, 'safety-pilot', 'safety-pilot-test'); await receiver.evaluate('BoatWorkspace.navigate("fleet");void 0'); await receiver.evaluate(script);
        await receiver.until('boatMonitor.driver.gamepad.haptics.alertServerOffset!==null');
        await receiver.evaluate('BoatWorkspace.navigate("fleet");document.getElementById("accountLoginDialog").showModal();void 0');
        assert.equal(await receiver.evaluate('boatMonitor.driver.gamepad.source'), 'keyboard');
        assert.equal(await receiver.evaluate('boatMonitor.driver.visible()'), false);
        assert.equal(await receiver.evaluate('document.getElementById("gamepadHapticsSettings").hidden'), true);
        assert.equal(await receiver.evaluate(`fetch('/api/gamepad-haptics/alert',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`), 403);
        // 操作真正的管理员按钮，两个浏览器都不进入驾驶或申请接管。
        let lastAlertAt = -Infinity;
        const clickAlert = async () => {
          await wait(Math.max(0, lastAlertAt + 1600 - Date.now()));
          await admin.send('Page.bringToFront');
          await admin.evaluate('document.getElementById("gamepadHapticsAlert").scrollIntoView({block:"center"});void 0');
          const point = await admin.evaluate('(()=>{const b=document.getElementById("gamepadHapticsAlert"),r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,disabled:b.disabled};})()');
          assert.equal(point.disabled, false);
          for (const type of ['mousePressed', 'mouseReleased']) await admin.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
          lastAlertAt = Date.now();
        };
        const waitRumbles = async (context, count) => {
          try { await context.until('alertRumbles.length===' + count); } catch (error) {
            const state = await context.evaluate('({calls:alertRumbles,received:alertReceipts,role:BoatAuth.user?.role,offset:boatMonitor.driver.gamepad.haptics.alertServerOffset,stream:boatMonitor.driver.gamepad.haptics.alertStream?.readyState,status:boatMonitor.driver.gamepad.haptics.alertMessage,hidden:document.hidden})');
            throw Error(error.message + '\nSafety state: ' + JSON.stringify(state) + '\nOnline pages: ' + server.boatGamepadHapticsApi.getClientCount(), { cause: error });
          }
        };
        await clickAlert(); await waitRumbles(admin, 2); await waitRumbles(receiver, 2);
        for (const context of [admin, receiver]) {
          assert.deepEqual(await context.evaluate('alertRumbles.map(v=>v.duration)'), [1000, 1000]);
          assert.equal(await context.evaluate('alertRumbles[0].strongMagnitude'), .4); assert.equal(await context.evaluate('alertRumbles[1].strength'), .4);
          assert.equal(await context.evaluate('boatMonitor.driver.active'), false);
        }
        await admin.until('document.getElementById("gamepadHapticsAlertStatus").textContent.includes("2 个在线页面")');
        assert.equal(server.driverFixture.calls.length, 0, 'safety alerts send no driving commands');
        // 注销结束旧提醒，新账号连接时不重播；访客也能接收，继续无平台管理权限。
        await receiver.evaluate('document.getElementById("accountLoginDialog").close();void BoatAuth.logout()'); await receiver.until('!BoatAuth.user');
        await login(receiver, 'observer', 'browser-guest-test-only');
        await receiver.until('boatMonitor.driver.gamepad.haptics.alertServerOffset!==null');
        assert.equal(await receiver.evaluate('alertRumbles.length'), 2, 'reconnect does not replay an alert');
        assert.equal(await receiver.evaluate('boatMonitor.driver.gamepad.haptics.loaded'), false, 'guest receives no privileged settings');
        await clickAlert(); await waitRumbles(receiver, 4);
        assert.equal(await receiver.evaluate('document.getElementById("gamepadHapticsAlert").disabled'), true);
      });
      for (const [width, height] of [[1440, 900], [375, 812], [320, 667]]) {
        await admin.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
        for (const theme of ['dark', 'light']) {
          await admin.evaluate('document.documentElement.dataset.theme==="' + theme + '"||document.getElementById("themeToggle").click();document.getElementById("gamepadHapticsSettings").scrollIntoView({block:"center"});void 0');
          assert.equal(await admin.evaluate('(()=>{const e=document.getElementById("gamepadHapticsSettings"),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth&&r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;})()'), true);
          await admin.viewportShot('gamepad-safety-settings-' + width + '-' + theme);
        }
      }
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: two Chrome browsers, three account roles, persistent intensity, administrator broadcast to every dual-rumble/pulse pad without driving/telemetry, automatic switch bypass, modal/other-page delivery, no replay or motion, and responsive dark/light settings.');
}
module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
