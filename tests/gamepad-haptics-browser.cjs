/* 真实 Chrome、账户和 MQTT/SSE 遥测；只模拟手柄及其震动执行器。 */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { browserSession, login, startTelemetry } = require('./amap-browser.cjs');
const { createDriverFixture } = require('./driver-browser-fixture.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const output = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, 'haptics-browser-state-'));
  const file = path.join(directory, 'gamepad-haptics.json');
  const server = createDriverFixture({ env: { BOAT_ACCOUNTS_FILE: path.join(directory, 'accounts.json'), BOAT_MAP_CONFIG_FILE: path.join(directory, 'map.json'), BOAT_DRIVER_LAYOUT_FILE: path.join(directory, 'layout.json'), BOAT_GAMEPAD_HAPTICS_FILE: file, BOAT_TELEMETRY_HISTORY_FILE: path.join(directory, 'history.json'), BOAT_OTA_KEY: '' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await browserSession(server, 'gamepad-haptics', async ({ evaluate, until, send, viewportShot }) => {
    const click = async id => {
      await evaluate('document.getElementById(' + JSON.stringify(id) + ').scrollIntoView({block:"nearest"})');
      const point = await evaluate('(()=>{const b=document.getElementById(' + JSON.stringify(id) + '),r=b.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.closest("button")===b&&!b.disabled};})()');
      assert.equal(point.hit, true, id + ' accepts a real pointer');
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    await login({ evaluate, until }, 'operator', 'browser-admin-test-only'); await startTelemetry({ evaluate, until });
    await evaluate(`window.rumbleCalls=[];window.rumbleResets=0;window.rumblePad={index:0,id:'Xbox haptics test',mapping:'standard',connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0})),vibrationActuator:{effects:['dual-rumble'],playEffect(kind,options){rumbleCalls.push({kind,...options});return Promise.resolve('complete');},reset(){rumbleResets++;return Promise.resolve();}}};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[rumblePad]});BoatWorkspace.navigate('driving',{focus:false});document.getElementById('driverInputSource').value='gamepad';document.getElementById('driverInputSource').dispatchEvent(new Event('change'));void 0;`);
    await until('boatMonitor.driver.gamepad.haptics.loaded&&!!boatMonitor.driver.gamepad.sample');
    await wait(500); assert.equal(await evaluate('rumbleCalls.length'), 0, 'Already running motors at first connect do not vibrate');
    await evaluate('document.getElementById("driverControlOptions").open=true'); await click('driverGamepadHapticsTest');
    await until('rumbleCalls.length===1'); assert.equal(server.driverFixture.calls.some(call => call.action === 'acquire'), false, 'Testing haptics never acquires or sends motion');
    await evaluate('document.getElementById("driverControlOptions").open=false;document.activeElement?.blur();void 0');
    server.mqttFixture.overrides = { rpm: 0 }; await wait(800); server.mqttFixture.overrides = { rpm: 300 };
    await until('rumbleCalls.length===2'); assert.equal(await evaluate('rumbleCalls.at(-1).duration'), 160);
    await wait(500); server.mqttFixture.overrides = { rpm: 300, roll: 26 };
    await until('rumbleCalls.length===3'); assert.equal(await evaluate('rumbleCalls.at(-1).duration'), 300);
    await wait(600); assert.equal(await evaluate('rumbleCalls.length'), 3, 'Steady running and a steady changed attitude do not repeat');
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('document.getElementById("platformSettingsDialog").open&&!document.getElementById("gamepadHapticsSave").disabled');
    await evaluate('document.getElementById("gamepadHapticsEnabled").checked=false;document.getElementById("gamepadHapticsThreshold").value="30";document.getElementById("gamepadHapticsThreshold").dispatchEvent(new Event("input"));void 0');
    await click('gamepadHapticsSave'); await until('boatMonitor.driver.gamepad.haptics.state.revision===1&&!boatMonitor.driver.gamepad.haptics.busy');
    assert.equal(server.boatGamepadHapticsApi.snapshot().enabled, false); assert.equal(JSON.parse(fs.readFileSync(file)).attitudeThresholdDegrees, 30);
    for (const [width, height] of [[1440, 900], [375, 812], [320, 667]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      for (const theme of ['dark', 'light']) {
        await evaluate('document.documentElement.dataset.theme==="' + theme + '"||document.getElementById("themeToggle").click();document.getElementById("gamepadHapticsSettings").scrollIntoView({block:"center"});void 0');
        await wait(80);
        assert.equal(await evaluate('(()=>{const e=document.getElementById("gamepadHapticsSettings"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth&&document.documentElement.scrollWidth<=innerWidth;})()'), true, width + ' ' + theme + ' settings fit');
        await viewportShot('gamepad-haptics-settings-' + width + '-' + theme);
      }
    }
    await evaluate('document.getElementById("platformSettingsDialog").close();document.activeElement?.blur();void 0');
    const count = await evaluate('rumbleCalls.length'); server.mqttFixture.overrides = { rpm: 0, roll: -40 }; await wait(700); server.mqttFixture.overrides = { rpm: 500, roll: 40 }; await wait(800);
    assert.equal(await evaluate('rumbleCalls.length'), count, 'Disabled configuration suppresses both events');
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('!document.getElementById("gamepadHapticsSave").disabled');
    await evaluate('document.getElementById("gamepadHapticsEnabled").checked=true;document.getElementById("gamepadHapticsThreshold").value="30";document.getElementById("gamepadHapticsThreshold").dispatchEvent(new Event("input"));void 0');
    await click('gamepadHapticsSave'); await until('boatMonitor.driver.gamepad.haptics.state.revision===2&&!boatMonitor.driver.gamepad.haptics.busy');
    await evaluate('document.getElementById("platformSettingsDialog").close();document.activeElement?.blur();void 0'); await wait(500);
    server.mqttFixture.overrides = { rpm: 500, roll: 60 }; await wait(550);
    assert.equal(await evaluate('rumbleCalls.length'), count, '20-degree change is below the saved 30-degree threshold');
    server.mqttFixture.overrides = { rpm: 500, roll: 10 }; await until('rumbleCalls.length===' + (count + 1));
    // PWM普通场景：全传感器失效时接管，连接手柄但使用键盘也收到缺失震动。
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.getElementById("driverInputSource").value="keyboard";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));document.getElementById("driverMode").value="0";document.getElementById("driverMode").dispatchEvent(new Event("change"));document.activeElement?.blur();void 0');
    server.mqttFixture.overrides = { mode: 0 }; await wait(650);
    const beforeMissing = await evaluate('rumbleCalls.filter(call=>call.duration===350).length');
    server.mqttFixture.overrides = { mode: 0, skipMotors: true, skipVelocity: true, skipImu: true };
    await until('!document.getElementById("driverDataAlerts").hidden');
    await until('rumbleCalls.filter(call=>call.duration===350).length>' + beforeMissing);
    assert.match(await evaluate('document.getElementById("driverDataAlertsText").textContent'), /PWM开环仍可操控/);
    await until('!document.getElementById("driverEnable").disabled'); await click('driverEnable'); await until('boatMonitor.driver.active');
    assert.equal(server.driverFixture.calls.filter(call => call.action === 'acquire').at(-1).testMode, false);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    await until('boatMonitor.driver.inputs().throttle===200'); await wait(250);
    assert.ok(server.driverFixture.calls.some(call => call.action === 'input' && call.mode === 0 && !call.testMode && call.throttle === 200), 'Actual HTTP PWM controls continue without any sensor feedback');
    const afterMissing = await evaluate('rumbleCalls.filter(call=>call.duration===350).length'); await wait(2200);
    assert.equal(await evaluate('document.getElementById("driverDataAlerts").hidden'), true, 'Warning closes after 2 seconds');
    assert.equal(await evaluate('boatMonitor.driver.active'), true, 'Data warnings do not cancel PWM control');
    assert.equal(await evaluate('rumbleCalls.filter(call=>call.duration===350).length'), afterMissing, 'Unchanged missing data does not repeat vibration');
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    await click('driverEmergency'); await until('!boatMonitor.driver.active');
    assert.ok(server.driverFixture.calls.some(call => call.action === 'stop'));
    for (const [width, height] of [[1440, 900], [375, 812], [320, 667]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 760 });
      for (const theme of ['dark', 'light']) {
        await evaluate('document.documentElement.dataset.theme==="' + theme + '"||document.getElementById("themeToggle").click();boatMonitor.driver.dataAlerts.show(["左电机反馈","RTK速度","IMU姿态"],performance.now());void 0');
        assert.equal(await evaluate('(()=>{const e=document.getElementById("driverDataAlerts"),r=e.getBoundingClientRect();return r.top>=0&&r.left>=0&&r.right<=innerWidth&&Math.abs(innerWidth-r.right-16)<2&&getComputedStyle(e).pointerEvents==="none";})()'), true, 'Data warning stays at top right without intercepting controls');
        await viewportShot('driver-data-alert-' + width + '-' + theme);
      }
    }
    server.mqttFixture.overrides = {}; await wait(300);
    await evaluate('document.getElementById("driverInputSource").value="gamepad";document.getElementById("driverInputSource").dispatchEvent(new Event("change"));document.getElementById("driverControlOptions").open=true;delete rumblePad.vibrationActuator;boatMonitor.driver.gamepad.scan();void 0');
    await until('document.getElementById("driverGamepadHapticsStatus").textContent.includes("未提供震动")');
    assert.equal(await evaluate('document.getElementById("driverGamepadHapticsTest").disabled'), true);
    await evaluate('document.getElementById("driverControlOptions").open=false');
    await evaluate(`void fetch('/api/auth/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'pilot',password:'pilot-haptics-test',role:'driver'})}).then(r=>{if(!r.ok)throw Error('create pilot');window.hapticPilotCreated=true;});`); await until('window.hapticPilotCreated');
    await evaluate('void BoatAuth.logout()'); await until('!BoatAuth.user'); await login({ evaluate, until }, 'pilot', 'pilot-haptics-test');
    await until('boatMonitor.driver.gamepad.haptics.loaded'); assert.equal(await evaluate('document.getElementById("gamepadHapticsSettings").hidden'), true);
    assert.equal(await evaluate('boatMonitor.driver.gamepad.haptics.state.attitudeThresholdDegrees'), 30, 'Driver uses the administrator configuration');
  }); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: Chrome/MQTT haptic events, persistent admin settings, PWM acquisition and real HTTP motion with all sensor feedback missing, keyboard plus connected-controller loss vibration, 2-second nonrepeating warnings, emergency stop, driver permissions, unsupported controllers, and 320/375/1440 dark/light UI.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
