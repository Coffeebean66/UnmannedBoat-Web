/* 本机真实 UDP / RTSP → MediaMTX → Chrome，WVP 设备接口使用桩，不连接生产船只。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),dgram=require('node:dgram');
const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {createFixtureServer}=require('./mqtt-browser-fixture.cjs');
const {createMediaTransport}=require('../server/video-media-api');
const {createRecordingTransport}=require('../server/video-recording-api');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(udp=false){const s=udp?dgram.createSocket('udp4'):net.createServer();await new Promise(resolve=>udp?s.bind(0,'127.0.0.1',resolve):s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
async function main(){
  const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'wvp-browser-')),children=[],logs=[],errors=[];
  const [apiPort,whepPort,rtspPort,rtpPort,rtcPort]=await Promise.all([freePort(),freePort(),freePort(),freePort(true),freePort(true)]);
  const password='b'.repeat(64),mediaCalls=[],wvpCalls=[];
  const client=async()=>({canAuthenticateVideo:true,devices:[{deviceId:'boat-mqtt-test'}]});
  const wvp={enabled:true,async devices(){return {devices:[{deviceId:'camera-01',name:'船载摄像机',online:true}]};},
    async channels(){return {channels:[{channelId:'channel-01',name:'船首主摄像头',online:true}]};},
    async start(deviceId,channelId){wvpCalls.push({deviceId,channelId});return {url:'rtsp://127.0.0.1:'+rtspPort+'/rtp/camera',deviceId,channelId};},
    async media(){return {configured:true,streams:1};},close(){}};
  const mediaTransport=createMediaTransport({port:whepPort}),native=createRecordingTransport({port:apiPort});
  const server=createFixtureServer({env:{BOAT_VIDEO_MEDIA_ENABLED:'1',BOAT_VIDEO_MEDIA_AUTH_TOKEN:'a'.repeat(64),BOAT_VIDEO_MEDIA_READER_PASSWORD:password,
    BOAT_VIDEO_MEDIA_PUBLIC_HOST:'127.0.0.1',BOAT_VIDEO_WEBRTC_PORT:String(rtcPort),BOAT_VIDEO_WVP_ENABLED:'1',BOAT_VIDEO_WVP_USERNAME:'test-admin',BOAT_VIDEO_WVP_PASSWORD_MD5:'c'.repeat(32),BOAT_VIDEO_ZLM_RTSP_PORT:String(rtspPort)},
    accountOptions:{storeFile:path.join(run,'accounts.json')},mapOptions:{file:path.join(run,'map.json')},
    driverLayoutOptions:{file:path.join(run,'layout.json')},gamepadHapticsOptions:{file:path.join(run,'haptics.json')},missionOptions:{file:path.join(run,'missions.json')},
    mqttAdminOptions:{client},videoSourceOptions:{file:path.join(run,'sources.json'),client,wvp,transport:native,reconcileMs:1000},
    videoMediaOptions:{client,upstreamPort:whepPort,transport:async input=>{const r=await mediaTransport(input);mediaCalls.push({method:input.method,path:input.path,status:r.status});return r;}}});
  const start=(binary,args,label)=>{const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',d=>logs.push(label+': '+d));child.stderr.on('data',d=>logs.push(label+': '+d));child.on('error',e=>errors.push(label+': '+e.message));return child;};
  let socket;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
    const configuration={logLevel:'info',authMethod:'internal',authInternalUsers:[{user:'any',pass:'',ips:['127.0.0.1'],permissions:[{action:'publish',path:''},{action:'read',path:''},{action:'api',path:''}]},
      {user:'boat-web-media-reader',pass:password,ips:['127.0.0.1'],permissions:[{action:'read',path:''},{action:'api',path:''}]}],
      api:true,apiAddress:'127.0.0.1:'+apiPort,rtsp:true,rtspAddress:'127.0.0.1:'+rtspPort,rtspTransports:['tcp'],rtmp:false,hls:false,srt:false,moq:false,
      webrtc:true,webrtcAddress:'127.0.0.1:'+whepPort,webrtcLocalUDPAddress:'127.0.0.1:'+rtcPort,webrtcIPsFromInterfaces:false,webrtcAdditionalHosts:['127.0.0.1'],
      paths:{'boat-mqtt-test':{source:'udp+mpegts://127.0.0.1:'+rtpPort},'rtp/camera':{source:'publisher'}}};
    const configFile=path.join(run,'mediamtx.yml');fs.writeFileSync(configFile,JSON.stringify(configuration));
    const media=start(process.env.MEDIAMTX_PATH||(process.platform==='win32'?path.join(output,'mediamtx-v1.21.3/mediamtx.exe'):'mediamtx'),[configFile],'MediaMTX');
    for(let i=0;i<100&&!logs.join('').includes('(HTTP)')&&media.exitCode===null;i++)await wait(100);
    if(media.exitCode!==null)throw Error('MediaMTX启动失败\n'+logs.join(''));
    const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/ffmpeg.exe':'ffmpeg');
    const encoder=size=>['-hide_banner','-loglevel','warning','-nostdin','-re','-f','lavfi','-i','testsrc2=size='+size+':rate=15','-an','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-profile:v','baseline','-g','15','-bf','0'];
    start(ffmpeg,[...encoder('320x180'),'-f','mpegts','udp://127.0.0.1:'+rtpPort+'?pkt_size=1316'],'UDP sender');
    start(ffmpeg,[...encoder('640x360'),'-f','rtsp','-rtsp_transport','tcp','rtsp://127.0.0.1:'+rtspPort+'/rtp/camera'],'RTSP sender');
    for(let i=0;i<100;i++){try{const r=await native({method:'GET',path:'/v3/paths/get/boat-mqtt-test'});if(r.status===200&&JSON.parse(r.body).ready)break;}catch(_){}await wait(100);}
    const profile=path.join(run,'chrome');fs.mkdirSync(profile);
    start(process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'google-chrome'),
      ['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],'Chrome');
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile);i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error('Chrome启动失败');
    const pages=await(await fetch('http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').split('\n')[0]+'/json/list')).json();
    socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const until=async(expression,label=expression)=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await wait(100);}throw Error('未满足条件 '+label+'\n'+await evaluate('JSON.stringify({video:boatMonitor.videoView.state(),message:document.getElementById("videoMessage").textContent,width:document.getElementById("boatVideo").videoWidth})')+'\n'+logs.join(''));};
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['*://*.tile.openstreetmap.org/*','*://tile.openstreetmap.org/*','*://webapi.amap.com/*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:origin});
    await until('!!window.boatMonitor?.videoSources&&BoatAuth.ready');
    await evaluate('document.getElementById("accountUsername").value="operator";document.getElementById("accountPassword").value="browser-admin-test-only";document.getElementById("accountLoginForm").requestSubmit()');
    await until('BoatAuth.user?.role==="admin"&&boatMonitor.fleet.streamConnected');
    await evaluate('boatMonitor.selectBoat("boat-mqtt-test",false);BoatWorkspace.navigate("video")');
    await until('document.getElementById("boatVideo").videoWidth===320&&boatMonitor.videoView.playing','原UDP图传真实解码');
    await evaluate('document.getElementById("platformSettingsToggle").click()');await until('boatMonitor.videoSources.state?.enabled&&!boatMonitor.videoSources.busy');
    assert.equal(await evaluate('document.getElementById("videoSourceBoat").value'),'boat-mqtt-test');
    await evaluate('document.getElementById("videoSourceProvider").value="wvp";document.getElementById("videoSourceProvider").dispatchEvent(new Event("change"));document.getElementById("videoSourceWvpDevice").value="camera-01";document.getElementById("videoSourceWvpDevice").dispatchEvent(new Event("change"))');
    await until('document.getElementById("videoSourceWvpChannel").options.length===2');
    await evaluate('document.getElementById("videoSourceWvpChannel").value="channel-01";document.getElementById("videoSourceWvpChannel").dispatchEvent(new Event("change"));document.getElementById("videoSourceForm").requestSubmit()');
    await until('boatMonitor.videoSources.state?.revision===1&&!boatMonitor.videoSources.busy');
    assert.equal(wvpCalls.length>0,true);await evaluate('document.getElementById("platformSettingsClose").click()');
    await until('document.getElementById("boatVideo").videoWidth===640&&boatMonitor.videoView.playing','WVP来源经RTSP拉流后真实WebRTC解码');
    assert.match(await evaluate('document.getElementById("videoSource").textContent'),/WVP/);
    // 另一管理员的服务器切换，当前播放页面不点重新连接也要自动更新。
    const restored=await evaluate('(async()=>{const r=await fetch("/api/video/sources/boats/boat-mqtt-test",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:1,provider:"direct"})});return r.status;})()');assert.equal(restored,200);
    await until('document.getElementById("boatVideo").videoWidth===320&&boatMonitor.videoView.playing','轮询发现服务器切回UDP，自动重连');
    const conf=JSON.parse((await native({method:'GET',path:'/v3/config/paths/get/boat-mqtt-test'})).body);assert.equal(conf.source,'udp+mpegts://127.0.0.1:'+rtpPort);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'video-source-1440.png'),Buffer.from(screenshot.data,'base64'));
    await evaluate('document.getElementById("videoStop").click()');await until('!boatMonitor.videoView.active');
    assert.ok(mediaCalls.some(call=>call.method==='DELETE'));assert.deepEqual(errors,[]);
    console.log('WVP browser passed: UDP320 → admin selection → RTSP640 → WebRTC decoded; server switch discovered by polling; original UDP restored; page stopped and sessions cleaned. WVP API is simulated.');
  }finally{
    socket?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const child of children)child.kill();
    await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)])));
    fs.writeFileSync(path.join(output,'video-source-browser-log.txt'),logs.join(''));
    if(path.dirname(run)===output&&path.basename(run).startsWith('wvp-browser-'))fs.rmSync(run,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
