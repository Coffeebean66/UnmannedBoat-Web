/* 真云端端到端检查：独立测试 MQTT 账户 → Broker → Node/SSE → Chrome。
 * 密码仅从环境/忽略文件加载，不放进命令行、日志或截图；不发布电机控制命令。 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const mqtt=require('mqtt'),P=require('../public/utils/uart4Protocol');
const Socket=globalThis.WebSocket||require('ws');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deviceId='boat-server-check',prefix='boats/'+deviceId;
const output=path.resolve(__dirname,'../.test-output/cloud');
let accessPassword='',mqttPassword='';
function safe(message){return [accessPassword,mqttPassword].filter(Boolean).reduce((text,secret)=>text.split(secret).join('[redacted]'),String(message));}
function credentials(){
  const file=process.env.BOAT_TEST_ACCESS_FILE;if(!file)throw Error('BOAT_TEST_ACCESS_FILE is required');
  const entry=fs.readFileSync(file,'utf8').match(/^\s*Cloud viewer password:\s*(.+?)\s*$/mi);
  accessPassword=entry?.[1]||'';mqttPassword=process.env.BOAT_TEST_MQTT_PASSWORD||'';
  if(!accessPassword||!mqttPassword)throw Error('Cloud viewer password and BOAT_TEST_MQTT_PASSWORD are required');
}
function fixture(sequence){
  const frames=[];
  function frame(type,size,version,flags){
    const b=new Uint8Array(size),v=new DataView(b.buffer);b.set([0xa5,0x5a,version,type,size,flags]);v.setUint32(6,sequence,true);v.setUint32(10,sequence*100,true);
    return {b,v,finish(){v.setUint16(size-2,P.crc16CcittFalse(b,2,size-4),true);frames.push(Buffer.from(b));}};
  }
  let f=frame(1,64,1,0xf3);
  for(const base of [14,38]){f.b[base]=7;f.b[base+1]=32;f.v.setUint16(base+2,2450,true);f.v.setUint16(base+4,1230,true);f.v.setUint32(base+12,1500,true);f.v.setUint32(base+8,10500,true);f.v.setInt16(base+18,120,true);f.v.setUint16(base+20,10,true);}f.finish();
  f=frame(2,40,2,3);f.v.setInt16(14,1500,true);f.v.setInt16(16,400,true);f.v.setUint16(20,20,true);f.v.setInt32(26,311234567+sequence*10,true);f.v.setInt32(30,1217654321,true);f.v.setUint16(34,35900,true);f.b[36]=15;f.finish();
  f=frame(3,36,2,47);f.v.setInt16(14,1800,true);f.v.setUint16(16,1552,true);f.v.setInt16(18,120,true);f.v.setUint16(20,20,true);f.v.setInt16(22,2000,true);f.v.setUint16(26,100,true);f.v.setUint16(28,35900,true);f.v.setInt16(30,200,true);f.b[32]=2;f.b[33]=3;f.finish();
  f=frame(4,36,1,3);f.v.setInt16(14,120,true);f.v.setInt16(20,600,true);f.v.setInt16(22,-400,true);f.v.setInt16(24,3200,true);f.v.setUint16(26,20,true);f.b[32]=127;f.finish();
  const bytes=Buffer.concat(frames);assert.equal(bytes.length,176);return bytes;
}
async function main(){
  credentials();fs.mkdirSync(output,{recursive:true});
  const url=new URL(process.env.BOAT_TEST_URL||'https://boat.coffeebean66.tech');
  if(url.protocol!=='https:')throw Error('Remote cloud browser verification requires HTTPS');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'boat-cloud-chrome-'));
  const chrome=process.env.CHROME_PATH||[
    'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].find(candidate=>fs.existsSync(candidate))||'google-chrome';
  const errors=[],mqttErrors=[];let client,browser,socket,timer,sequence=0,pending=new Map();
  const stopTelemetry=()=>{clearInterval(timer);timer=null;};
  const publish=()=>{if(client?.connected)client.publish(prefix+'/telemetry',fixture(++sequence),{qos:0,retain:false});};
  const startTelemetry=()=>{stopTelemetry();publish();timer=setInterval(publish,100);};
  try{
    client=await mqtt.connectAsync(process.env.BOAT_TEST_MQTT_URL||'mqtt://'+url.hostname+':1883',{username:deviceId,password:mqttPassword,
      clientId:'boat-browser-check-'+crypto.randomBytes(6).toString('hex'),clean:true,reconnectPeriod:0,connectTimeout:15000,
      will:{topic:prefix+'/status',payload:Buffer.from('offline'),qos:1,retain:false}});
    client.on('error',error=>mqttErrors.push(safe(error.message)));
    await client.publishAsync(prefix+'/status','online',{qos:1,retain:false});startTelemetry();
    const args=['--headless','--no-first-run','--no-default-browser-check','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile];
    if(process.env.BOAT_CHROME_NO_SANDBOX==='1'||(process.platform==='linux'&&process.getuid?.()===0))args.push('--no-sandbox');
    browser=spawn(chrome,args,{windowsHide:true,stdio:'ignore'});browser.on('error',error=>errors.push(safe(error.message)));
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;i<150&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
    const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new Socket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(Error('Chrome debugger connection failed'));});
    let serial=0;
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Runtime.exceptionThrown')errors.push(safe(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text));
      if(pending.has(message.id)){const request=pending.get(message.id);pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(safe(message.error.message))):request.resolve(message.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial,timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer:timeout});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if(result.exceptionDetails)throw Error(safe(result.exceptionDetails.exception?.description||result.exceptionDetails.text));return result.result.value;
    };
    const until=async(expression,label,timeout=20000)=>{
      const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await evaluate(expression))return;await wait(100);}
      throw Error('Timed out: '+label+(errors.length?' ('+errors.join('; ')+')':''));
    };
    const screenshot=async name=>{
      assert.equal(await evaluate("document.getElementById('cloudLoginDialog').open"),false,'Login dialog must be closed before screenshots');
      assert.equal(await evaluate("document.getElementById('cloudPassword').value"),'','No password remains in the form');
      const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));
    };
    const chooseCloud=async()=>{
      await evaluate("document.getElementById('telemetrySource').value='cloud';document.getElementById('telemetrySource').dispatchEvent(new Event('change'))");
      await until("boatMonitor.link.cloud.authenticated && [...document.getElementById('cloudDevice').options].some(option=>option.value==='boat-server-check')",'authenticated test device in cloud list');
      await evaluate("document.getElementById('cloudDevice').value='boat-server-check';document.getElementById('cloudDevice').dispatchEvent(new Event('change'));document.getElementById('connectButton').click()");
      await until("boatMonitor.link.source==='cloud' && boatMonitor.link.connected && document.getElementById('boatActual').textContent==='1.552'",'live remote cloud telemetry');
    };
    await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:url.href});
    await until('!!window.boatMonitor && !!boatMonitor.viewer.renderer && boatMonitor.link.cloud.enabled','deployed page, WebGL model and cloud configuration',40000);
    await evaluate("document.getElementById('telemetrySource').value='cloud';document.getElementById('telemetrySource').dispatchEvent(new Event('change'));document.getElementById('cloudLoginOpen').click()");
    await until("document.getElementById('cloudLoginDialog').open",'cloud login dialog');
    // CDP 内填写密码，不记录 expression，也不截图登录表单。
    await evaluate("document.getElementById('cloudPassword').value="+JSON.stringify(accessPassword)+";document.getElementById('cloudLoginForm').requestSubmit()");
    await until("boatMonitor.link.cloud.authenticated && !document.getElementById('cloudLoginDialog').open",'real HTTPS cookie login');
    await chooseCloud();await wait(500);
    assert.equal(await evaluate("document.getElementById('roll').textContent"),'6.00');
    assert.equal(await evaluate("document.getElementById('longitude').textContent"),'121.7654321');
    assert.ok(await evaluate("Number(document.getElementById('latitude').textContent)>31"));
    assert.equal(await evaluate("document.getElementById('mapEmpty').hidden"),true,'Live cloud position replaces map empty state');
    assert.equal(await evaluate('boatMonitor.viewer.fresh && !!boatMonitor.viewer.pose'),true,'Cloud IMU drives real 3D attitude');
    assert.equal(await evaluate("document.getElementById('chartTarget').textContent"),'1.800 m/s');
    assert.equal(await evaluate("document.getElementById('chartActual').textContent"),'1.552 m/s');
    assert.equal(await evaluate("document.getElementById('motor1Voltage').textContent"),'24.50');
    await until("!!document.querySelector('.map-velocity-anchor')",'target and actual map velocity arrows');
    assert.equal(await evaluate("[...document.querySelectorAll('.map-velocity-vectors [data-vector]')].filter(vector=>!vector.hasAttribute('hidden')&&Number(vector.dataset.length)>0).length"),2,'Both map velocity arrows are present');
    await evaluate("document.getElementById('trackStart').click()");await wait(1350);assert.ok(await evaluate('boatMonitor.track.pointCount>=2'),'Cloud track records live positions');
    await evaluate("document.getElementById('settingsToggle').click()");
    assert.deepEqual(await evaluate("['readParameters','writeParameters','saveFlash'].map(id=>document.getElementById(id).disabled)"),[true,true,true]);
    assert.equal(await evaluate("[...document.querySelectorAll('#presets [data-action=use]')].every(button=>button.disabled)"),true);
    assert.equal(await evaluate("document.getElementById('cloudReadOnlyNotice').hidden"),false);
    await screenshot('remote-cloud-settings');await evaluate("document.getElementById('settingsClose').click()");
    for(const width of [1440,430,375,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:width===1440?1100:900,deviceScaleFactor:1,mobile:width<700});await evaluate('window.scrollTo(0,0)');await wait(300);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'Cloud page overflow at '+width);
      assert.equal(await evaluate("document.getElementById('boatActual').textContent"),'1.552');await screenshot('remote-cloud-live-'+width);
      await evaluate("document.getElementById('settingsToggle').click()");
      assert.equal(await evaluate("document.getElementById('settingsDialog').scrollWidth<=document.getElementById('settingsDialog').clientWidth"),true,'Cloud settings overflow at '+width);
      await screenshot('remote-cloud-settings-'+width);await evaluate("document.getElementById('settingsClose').click()");
    }
    await evaluate("document.getElementById('telemetrySource').value='bluetooth';document.getElementById('telemetrySource').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate('boatMonitor.link.cloud.wanted'),false,'Switching to BLE closes cloud SSE');
    assert.equal(await evaluate('boatMonitor.link.connected'),false,'Source switch never claims BLE connected');
    for(const id of ['boatActual','roll'])assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),'--','Source switch clears '+id);
    assert.equal(await evaluate('boatMonitor.viewer.fresh'),false);assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false);
    await chooseCloud();await wait(300);assert.equal(await evaluate("document.getElementById('roll').textContent"),'6.00');
    stopTelemetry();await wait(1350);
    for(const id of ['boatActual','roll','motor1Rpm','chartActual','chartTarget'])assert.equal(await evaluate('document.getElementById('+JSON.stringify(id)+').textContent'),'--','One-second expiry clears '+id);
    assert.equal(await evaluate('boatMonitor.link.connected'),false);assert.equal(await evaluate('boatMonitor.viewer.fresh'),false);
    assert.equal(await evaluate("!!document.querySelector('.map-velocity-anchor')"),false);await screenshot('remote-cloud-stale');
    startTelemetry();await until('boatMonitor.link.connected && boatMonitor.viewer.fresh','telemetry recovery after publish pause');
    stopTelemetry();client.stream.destroy();await until('!boatMonitor.link.connected','MQTT abrupt disconnect expires the source');
    await until("!boatMonitor.link.cloud.devices.find(device=>device.id==='boat-server-check')?.online",'MQTT offline will / server device status');
    assert.equal(await evaluate("document.getElementById('boatActual').textContent"),'--');assert.equal(await evaluate("document.getElementById('roll').textContent"),'--');
    assert.deepEqual(errors,[],'No browser runtime exceptions');assert.deepEqual(mqttErrors,[],'No MQTT publish errors');
    console.log('PASS: real HTTPS session login, MQTT Broker → Node → SSE → Chrome, all four telemetry frames, RTK/map, IMU/WebGL, speed chart/vectors/track, cloud read-only guards, BLE/cloud source isolation, reconnect, 1-second expiry and MQTT offline.');
    console.log('PASS: remote cloud layout and settings have no horizontal overflow at 320 / 375 / 430 / 1440 px.');
    console.log('Screenshots: '+output);
  }finally{
    stopTelemetry();
    // 所有发布均 retain:false，因此不会留下在线状态或遥测 retained 消息。
    if(client){try{if(client.connected)await client.publishAsync(prefix+'/status','offline',{qos:1,retain:false});}catch(_){}await new Promise(resolve=>client.end(true,{},resolve));}
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Browser check finished'));}pending.clear();
    socket?.close();if(browser){browser.kill();await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),wait(3000)]);}
    // 只删除本次 mkdtemp 生成的 Chrome profile，避免会话 cookie 留在测试目录。
    try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(_){console.warn('Chrome temporary profile cleanup was incomplete');}
  }
}
main().catch(error=>{console.error(safe(error.stack||error.message));process.exitCode=1;});
