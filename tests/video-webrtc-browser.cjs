/* 本机真实 SRT → MediaMTX → WHEP → Chrome 解码；不访问生产 Broker，不需要摄像头。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),dgram=require('node:dgram');
const assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),{CloudBridge}=require('../server/cloud');
const {createMediaTransport}=require('../server/video-media-api');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ADMIN={username:'rtc-admin',password:'local-rtc-administrator'},GUEST={username:'rtc-guest',password:'local-rtc-observer'};
const cameras={'boat-alpha':{username:'video-alpha',password:'camera-test-alpha',width:320,height:180},'boat-beta':{username:'video-beta',password:'camera-test-beta',width:256,height:144}};

async function freePort(udp=false){
  const socket=udp?dgram.createSocket('udp4'):net.createServer();
  await new Promise((resolve,reject)=>{socket.once('error',reject);udp?socket.bind(0,'127.0.0.1',resolve):socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'video-webrtc-state-')),errors=[],children=[],logs=[],requests=[],authenticated=[];
  const upstreamPort=await freePort(),srtPort=await freePort(true),rtcPort=await freePort(true);
  const env={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://local-rtc-fixture.invalid:1883',
    BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:ADMIN.username,BOAT_ADMIN_PASSWORD:ADMIN.password,
    BOAT_GUEST_USERNAME:GUEST.username,BOAT_GUEST_PASSWORD:GUEST.password,
    BOAT_VIDEO_MEDIA_ENABLED:'1',BOAT_VIDEO_MEDIA_AUTH_TOKEN:'a'.repeat(64),BOAT_VIDEO_MEDIA_READER_PASSWORD:'b'.repeat(64),
    BOAT_VIDEO_MEDIA_PUBLIC_HOST:'127.0.0.1',BOAT_VIDEO_SRT_PORT:String(srtPort),BOAT_VIDEO_WEBRTC_PORT:String(rtcPort)};
  class MQTT extends EventEmitter{subscribe(topics,options,callback){callback(null);}publish(){throw Error('Video never sends vessel control commands');}end(){}}
  const mqtt=new MQTT(),bridge=new CloudBridge({env,connect:()=>mqtt,tickMs:250});
  const client=async(method,route,body)=>{
    if(method==='GET'&&route==='/devices')return {canAuthenticateVideo:true,devices:Object.keys(cameras).map(deviceId=>({deviceId}))};
    const id=route.replace('/video-auth/',''),camera=cameras[id];
    const authorized=method==='POST'&&!!camera&&body.username===camera.username&&body.password===camera.password;
    authenticated.push({id,authorized});return {authorized};
  };
  const transport=createMediaTransport({port:upstreamPort});
  const server=createServer({env,cloud:bridge,accountOptions:{storeFile:path.join(run,'accounts.json')},mapOptions:{file:path.join(run,'maps.json')},
    mqttAdminOptions:{client},videoMediaOptions:{client,upstreamPort,transport:async operation=>{
      const response=await transport(operation);requests.push({method:operation.method,path:operation.path,status:response.status});return response;
    }}});
  let socket,browser;
  function start(binary,args,label){
    const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);
    child.stdout.on('data',data=>logs.push(label+': '+data));child.stderr.on('data',data=>logs.push(label+': '+data));
    child.on('error',error=>errors.push(label+': '+error.message));return child;
  }
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));mqtt.emit('connect');
    for(const id of Object.keys(cameras))bridge.acceptMessage('boats/'+id+'/status',Buffer.from('offline'),{retain:true});
    const origin='http://127.0.0.1:'+server.address().port;
    // 使用真正部署脚本的配置生成器，再改为测试独占端口；同时验证生产 YAML 可被真实媒体程序读取。
    const installer=fs.readFileSync(path.join(__dirname,'../maintenance/install-video-media.sh'),'utf8');
    const generator=installer.match(/<<'MEDIA_CONFIG'\r?\n([\s\S]*?)\r?\nMEDIA_CONFIG/)[1];
    const previous=path.join(run,'previous.env'),configFile=path.join(run,'mediamtx.yml');
    fs.writeFileSync(previous,'BOAT_VIDEO_MEDIA_AUTH_TOKEN='+env.BOAT_VIDEO_MEDIA_AUTH_TOKEN+'\nBOAT_VIDEO_MEDIA_READER_PASSWORD='+env.BOAT_VIDEO_MEDIA_READER_PASSWORD+'\n');
    const generated=spawnSync(process.execPath,['-',previous,path.join(run,'runtime.env'),configFile,'127.0.0.1',String(server.address().port)],{input:generator,encoding:'utf8',windowsHide:true});
    assert.equal(generated.status,0,generated.stderr);
    fs.writeFileSync(configFile,fs.readFileSync(configFile,'utf8').replace('logLevel: warn','logLevel: info')
      .replace('webrtcAddress: 127.0.0.1:8889','webrtcAddress: 127.0.0.1:'+upstreamPort)
      .replace('webrtcLocalUDPAddress: :8189','webrtcLocalUDPAddress: 127.0.0.1:'+rtcPort)
      .replace('srtAddress: :8890','srtAddress: 127.0.0.1:'+srtPort));
    const media=start(process.env.MEDIAMTX_PATH||(process.platform==='win32'?path.join(output,'mediamtx-v1.21.3/mediamtx.exe'):'mediamtx'),[configFile],'MediaMTX');
    for(let n=0;n<100&&!logs.join('').includes('(UDP/SRT)')&&!errors.length&&media.exitCode===null;n++)await wait(100);
    if(media.exitCode!==null||errors.length||!logs.join('').includes('(UDP/SRT)'))throw Error('MediaMTX startup failed: '+errors.join('; ')+'\n'+logs.join(''));
    // 错误视频密码无法发布，真实 callback 必须触发 helper 校验。
    const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/ffmpeg.exe':'ffmpeg');
    const sender=(id,password=cameras[id].password)=>{
      const camera=cameras[id];return start(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-re','-f','lavfi','-i',`testsrc2=size=${camera.width}x${camera.height}:rate=15`,
        '-an','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-profile:v','baseline','-level','3.0',
        '-g','15','-keyint_min','15','-sc_threshold','0','-bf','0','-f','mpegts',
        `srt://127.0.0.1:${srtPort}?streamid=publish:${id}:${camera.username}:${password}&pkt_size=1316&latency=120000`],id);
    };
    const wrong=sender('boat-alpha','incorrect-test-password');
    for(let n=0;n<120&&!authenticated.some(item=>!item.authorized)&&wrong.exitCode===null;n++)await wait(100);
    wrong.kill();assert.ok(authenticated.some(item=>item.id==='boat-alpha'&&!item.authorized),'Wrong SRT publishing password was rejected');
    sender('boat-alpha');sender('boat-beta');
    for(let n=0;n<150&&!Object.keys(cameras).every(id=>authenticated.some(item=>item.id===id&&item.authorized));n++)await wait(100);
    assert.ok(Object.keys(cameras).every(id=>authenticated.some(item=>item.id===id&&item.authorized)),'Both SRT uploads were authenticated');

    const profile=path.join(run,'chrome');fs.mkdirSync(profile);
    browser=start(process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'google-chrome'),
      ['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader',
        '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],'Chrome');
    const portFile=path.join(profile,'DevToolsActivePort');for(let n=0;n<120&&!fs.existsSync(portFile)&&!errors.length;n++)await wait(100);
    if(!fs.existsSync(portFile))throw Error('Chrome startup failed: '+errors.join('; '));
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}
    };
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const until=async(expression,label=expression)=>{
      for(let n=0;n<300;n++){if(await evaluate(expression))return;await wait(70);}
      throw Error('Condition timed out: '+label+'\n'+await evaluate('JSON.stringify({hash:location.hash,auth:BoatAuth.state(),video:boatMonitor.videoView.state(),width:document.getElementById("boatVideo").videoWidth,message:document.getElementById("videoMessage").textContent})')+'\n'+logs.join(''));
    };
    const login=async(role='admin')=>{
      const user=role==='guest'?GUEST:ADMIN;
      await evaluate('document.getElementById("accountUsername").value='+JSON.stringify(user.username)+';document.getElementById("accountPassword").value='+JSON.stringify(user.password)+';document.getElementById("accountLoginForm").requestSubmit()');
      await until('BoatAuth.user?.role==='+JSON.stringify(role)+'&&!BoatAuth.busy');
      await until('boatMonitor.fleet.streamConnected&&document.querySelectorAll(".fleet-card").length===2');
    };
    const card=id=>'document.querySelector('+JSON.stringify('.fleet-card[data-device-id="'+id+'"] .fleet-video-button')+')';
    const decoded=async id=>{
      const camera=cameras[id];await until('boatMonitor.videoView.state().deviceId==='+JSON.stringify(id)+'&&boatMonitor.videoView.state().format==="webrtc"&&boatMonitor.videoView.state().playing&&document.getElementById("boatVideo").videoWidth==='+camera.width+'&&document.getElementById("boatVideo").videoHeight==='+camera.height,'Actual decoded '+id+' SRT/WebRTC frames');
      const frames=await evaluate('document.getElementById("boatVideo").getVideoPlaybackQuality().totalVideoFrames');await wait(350);
      assert.ok(await evaluate('document.getElementById("boatVideo").getVideoPlaybackQuality().totalVideoFrames')>frames,'WebRTC video frames continue arriving');
    };
    const unloaded=async()=>until('!boatMonitor.videoView.state().active&&!document.getElementById("boatVideo").srcObject&&document.getElementById("boatVideo").readyState===0','RTC media unloaded');
    const deleted=async count=>{for(let n=0;n<100&&requests.filter(item=>item.method==='DELETE').length<=count;n++)await wait(50);assert.ok(requests.filter(item=>item.method==='DELETE').length>count,'WHEP session deleted');};
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
    await send('Network.setBlockedURLs',{urls:['*://tile.openstreetmap.org/*','*://*.tile.openstreetmap.org/*','*://webapi.amap.com/*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:origin});await until('!!window.boatMonitor?.videoView&&BoatAuth.ready');
    assert.equal(requests.length,0,'No viewer before login');await login();assert.equal(requests.length,0,'No viewer before video-page entry');
    assert.equal(await evaluate('document.getElementById("fleetOnline").textContent'),'0');
    assert.ok(bridge.list().devices.every(device=>device.video===null&&device.online===false),'No MQTT video descriptor or live telemetry required');
    await evaluate(card('boat-alpha')+'.click()');await decoded('boat-alpha');
    assert.equal(await evaluate('boatMonitor.link.connected'),false,'Video playback does not fake STM32 telemetry');
    const creates=requests.filter(item=>item.method==='POST').length;
    for(let n=0;n<4;n++)mqtt.emit('connect');await wait(500);
    assert.equal(requests.filter(item=>item.method==='POST').length,creates,'MQTT refreshes do not restart the video');
    let removes=requests.filter(item=>item.method==='DELETE').length;
    await evaluate('document.getElementById("videoStop").click()');await unloaded();await deleted(removes);
    await evaluate('document.getElementById("videoRetry").click()');await decoded('boat-alpha');
    removes=requests.filter(item=>item.method==='DELETE').length;
    await evaluate('boatMonitor.selectBoat("boat-beta",false)');await decoded('boat-beta');await deleted(removes);
    assert.ok(requests.some(item=>item.method==='POST'&&item.path==='/boat-beta/whep'));
    removes=requests.filter(item=>item.method==='DELETE').length;
    await evaluate('BoatWorkspace.navigate("fleet")');await unloaded();await deleted(removes);
    await evaluate('BoatWorkspace.navigate("video")');await decoded('boat-beta');
    const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,'video-webrtc-1440.png'),Buffer.from(image.data,'base64'));
    removes=requests.filter(item=>item.method==='DELETE').length;
    await evaluate('document.getElementById("accountLogout").click()');await until('!BoatAuth.user&&!BoatAuth.busy');await unloaded();await deleted(removes);
    await evaluate('document.getElementById("accountLoginOpen").click()');await login('guest');await evaluate(card('boat-alpha')+'.click()');await decoded('boat-alpha');
    assert.equal(await evaluate('BoatAuth.canManage'),false);
    await evaluate('document.getElementById("accountLogout").click()');await until('!BoatAuth.user&&!BoatAuth.busy');await unloaded();
    assert.deepEqual(errors,[]);
    console.log('Chrome SRT/WebRTC passed: actual UDP uploads + H.264 decoded frames, wrong-password rejection, per-vessel credentials, two video-only offline boats, authenticated admin/guest viewing, no descriptor, switch/stop/retry/navigation/logout session cleanup, MQTT refresh stability.');
  }finally{
    socket?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
    for(const child of children)child.kill();
    await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)])));
    fs.writeFileSync(path.join(output,'video-webrtc-log.txt'),logs.join(''));fs.writeFileSync(path.join(output,'video-webrtc-requests.json'),JSON.stringify(requests,null,2));
    if(path.dirname(run)===output&&path.basename(run).startsWith('video-webrtc-state-'))fs.rmSync(run,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
