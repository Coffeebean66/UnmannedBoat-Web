/* 真实 Chrome、CloudBridge、账户和 SSE 验证；所有 MQTT/媒体均来自本机测试源。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),{CloudBridge}=require('../server/cloud');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ADMIN={username:'video-admin',password:'video-fixture-administrator'},GUEST={username:'video-guest',password:'video-fixture-observer'};

function generateMedia(directory){
  const ffmpeg=process.env.FFMPEG_PATH||'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/ffmpeg.exe';
  const execute=args=>{
    const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{windowsHide:true,encoding:'utf8',timeout:60000});
    if(result.error||result.status!==0)throw Error('FFmpeg fixture generation failed: '+(result.error?.message||result.stderr));
  };
  const mp4=path.join(directory,'sample.mp4');
  execute(['-f','lavfi','-i','testsrc2=size=320x180:rate=12','-t','40','-an','-c:v','libx264','-preset','ultrafast','-profile:v','baseline','-level','3.0','-pix_fmt','yuv420p','-g','24','-keyint_min','24','-sc_threshold','0','-movflags','+faststart',mp4]);
  execute(['-i',mp4,'-c:v','copy','-an','-hls_time','2','-hls_list_size','0','-hls_flags','independent_segments','-hls_segment_filename',path.join(directory,'segment-%03d.ts'),path.join(directory,'sample.m3u8')]);
  execute(['-i',mp4,'-c:v','copy','-an','-f','flv',path.join(directory,'sample.flv')]);
}

function mediaServer(directory,requests){
  const types={'.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl','.ts':'video/mp2t','.flv':'video/x-flv'};
  return http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');requests.push({url:url.href,method:req.method,host:req.headers.host});
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Range');
    res.setHeader('Access-Control-Expose-Headers','Accept-Ranges, Content-Range, Content-Length');res.setHeader('Cache-Control','no-store');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const filename=path.basename(url.pathname),file=path.join(directory,filename);
    if(url.pathname!=='/'+filename||!types[path.extname(filename)]||!fs.existsSync(file)){res.writeHead(404);res.end('Missing test media');return;}
    const size=fs.statSync(file).size,range=req.headers.range;
    res.setHeader('Content-Type',types[path.extname(filename)]);res.setHeader('Accept-Ranges','bytes');
    let start=0,end=size-1;
    if(range){
      const match=/^bytes=(\d+)-(\d*)$/.exec(range);
      if(!match||Number(match[1])>=size){res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return;}
      start=Number(match[1]);end=match[2]?Math.min(size-1,Number(match[2])):size-1;
      res.statusCode=206;res.setHeader('Content-Range','bytes '+start+'-'+end+'/'+size);
    }
    res.setHeader('Content-Length',end-start+1);
    if(req.method==='HEAD'){res.end();return;}
    const source=fs.createReadStream(file,{start,end});source.on('error',()=>res.destroy());res.on('close',()=>source.destroy());source.pipe(res);
  });
}

async function main(){
  fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'video-browser-state-')),requests=[],errors=[];
  generateMedia(run);
  const media=mediaServer(run,requests);await new Promise(resolve=>media.listen(0,'127.0.0.1',resolve));
  const mediaOrigin='http://127.0.0.1:'+media.address().port;
  class MQTT extends EventEmitter{
    subscribe(topics,options,callback){this.topics=topics;callback(null);}
    publish(){throw Error('Video monitoring must not publish a boat command');}
    end(){}
  }
  const mqtt=new MQTT(),env={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://local-video-fixture.invalid:1883',BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:ADMIN.username,BOAT_ADMIN_PASSWORD:ADMIN.password,BOAT_GUEST_USERNAME:GUEST.username,BOAT_GUEST_PASSWORD:GUEST.password,BOAT_AMAP_KEY:'',BOAT_AMAP_SECURITY_CODE:'',BOAT_VIDEO_ALLOWED_ORIGINS:mediaOrigin};
  const bridge=new CloudBridge({env,connect:()=>mqtt,tickMs:250});
  const server=createServer({env,cloud:bridge,accountOptions:{storeFile:path.join(run,'accounts.json')},mapOptions:{file:path.join(run,'map-settings.json')},mqttAdminOptions:{client:async()=>({devices:[],revision:'f'.repeat(64),canCreate:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));mqtt.emit('connect');
  const publish=(id,format='native',filename='sample.mp4',extra={})=>{
    const descriptor={version:1,url:mediaOrigin+'/'+filename+'?boat='+encodeURIComponent(id),format,title:id+' 船载摄像头',...extra};
    assert.equal(bridge.acceptMessage('boats/'+id+'/video',Buffer.from(JSON.stringify(descriptor)),{retain:true}),true);return descriptor;
  };
  publish('boat-alpha');publish('boat-beta');
  const profile=fs.mkdtempSync(path.join(output,'chrome-video-'));
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0;const pending=new Map();
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}
    };
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const until=async(expression,label=expression)=>{
      for(let i=0;i<220;i++){if(await evaluate(expression))return;await wait(60);}
      throw Error('Condition timed out: '+label+'\n'+await evaluate('JSON.stringify({hash:location.hash,auth:window.BoatAuth?.state(),cloud:window.boatMonitor?.link.state(),video:window.boatMonitor?.videoView?.state(),message:document.getElementById("videoMessage")?.textContent,media:{src:document.getElementById("boatVideo")?.currentSrc,ready:document.getElementById("boatVideo")?.readyState,error:document.getElementById("boatVideo")?.error?.message}})')+'\n'+errors.join('\n'));
    };
    const login=async(role='admin')=>{
      const user=role==='guest'?GUEST:ADMIN;
      await evaluate('document.getElementById("accountUsername").value='+JSON.stringify(user.username)+';document.getElementById("accountPassword").value='+JSON.stringify(user.password)+';document.getElementById("accountLoginForm").requestSubmit()');
      await until('BoatAuth.user?.role==='+JSON.stringify(role)+'&&!BoatAuth.busy');
      await until('boatMonitor.fleet.streamConnected&&document.querySelectorAll(".fleet-card").length===2');
    };
    const card=(id,selector='')=>'document.querySelector('+JSON.stringify('.fleet-card[data-device-id="'+id+'"]'+(selector?' '+selector:''))+')';
    const play=async(format='native')=>{
      await until('boatMonitor.videoView.state().format==='+JSON.stringify(format)+'&&boatMonitor.videoView.state().active&&document.getElementById("boatVideo").currentTime>0&&document.getElementById("boatVideo").videoWidth>0','actual '+format+' media playback');
      assert.equal(await evaluate('document.getElementById("boatVideo").muted'),true);
    };
    // Chrome 在 NETWORK_EMPTY/NO_SOURCE 时也可能保留 currentSrc 的上一个值；以资源与播放状态判断卸载。
    const unloaded=async()=>until('!boatMonitor.videoView.state().active&&!document.getElementById("boatVideo").getAttribute("src")&&document.getElementById("boatVideo").readyState===0&&document.getElementById("boatVideo").paused','media source was unloaded');
    const shot=async name=>{const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
    await send('Network.setBlockedURLs',{urls:['*://tile.openstreetmap.org/*','*://*.tile.openstreetmap.org/*','*://webapi.amap.com/*']});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await until('!!window.boatMonitor?.videoView&&BoatAuth.ready');
    assert.equal(requests.length,0,'A video URL is never loaded before login and explicit video-page entry');
    await login();
    assert.equal(await evaluate('document.getElementById("fleetOnline").textContent'),'0','Retained video descriptors never manufacture live STM32 telemetry');
    assert.equal(bridge.get('boat-alpha').lastReceivedAt,null);
    await until(card('boat-alpha','.fleet-video-button')+'&&!'+card('boat-alpha','.fleet-video-button')+'.disabled');
    await evaluate(card('boat-alpha','.fleet-video-button')+'.click()');
    await until('location.hash==="#video"&&boatMonitor.videoView.state().deviceId==="boat-alpha"');await play();
    assert.equal(await evaluate('document.getElementById("videoDeviceName").textContent'),'boat-alpha');
    assert.equal(await evaluate('boatMonitor.link.connected'),false,'Viewing video does not mark the STM32 connection live');
    assert.ok(requests.some(item=>item.url.includes('boat=boat-alpha')));
    assert.equal(requests.some(item=>item.url.includes('boat=boat-beta')),false,'An unselected vessel never starts a player');

    await evaluate('window.testVideoStarts=0;window.testVideoEmptied=0;document.getElementById("boatVideo").addEventListener("loadstart",()=>window.testVideoStarts++);document.getElementById("boatVideo").addEventListener("emptied",()=>window.testVideoEmptied++)');
    const beforeTime=await evaluate('document.getElementById("boatVideo").currentTime'),beforeRequests=requests.length;
    for(let n=0;n<3;n++)publish('boat-alpha');
    await wait(450);
    assert.equal(await evaluate('window.testVideoStarts'),0,'Repeated retained descriptors do not rebuild the player');
    assert.equal(await evaluate('window.testVideoEmptied'),0);assert.ok(await evaluate('document.getElementById("boatVideo").currentTime')>beforeTime);
    assert.equal(requests.length,beforeRequests);
    await evaluate('document.getElementById("videoStop").click()');await unloaded();
    assert.equal(await evaluate('document.getElementById("videoRetry").disabled'),false);await evaluate('document.getElementById("videoRetry").click()');await play();

    await evaluate('BoatWorkspace.navigate("fleet")');await unloaded();
    await evaluate('BoatWorkspace.navigate("video")');await play();
    await evaluate('boatMonitor.selectBoat("boat-beta",false)');
    await until('location.hash==="#video"&&boatMonitor.videoView.state().deviceId==="boat-beta"');await play();
    assert.match(await evaluate('document.getElementById("boatVideo").currentSrc'),/boat=boat-beta/);
    publish('boat-alpha','hls','sample.m3u8');await wait(300);
    assert.match(await evaluate('document.getElementById("boatVideo").currentSrc'),/boat=boat-beta/,'Other-vessel updates never replace the selected player');
    await evaluate('BoatWorkspace.navigate("fleet")');await unloaded();
    await evaluate(card('boat-alpha','.fleet-video-button')+'.click()');await until('boatMonitor.videoView.state().deviceId==="boat-alpha"');await play('hls');
    assert.ok(requests.some(item=>item.url.includes('sample.m3u8')));assert.ok(requests.some(item=>item.url.includes('.ts')));
    publish('boat-alpha','flv','sample.flv');await play('flv');assert.ok(requests.some(item=>item.url.includes('sample.flv')));

    // 视频独立于已关闭的船端遥测；管理员/访客具有相同的观看权限。
    await evaluate('document.getElementById("accountLogout").click()');await until('!BoatAuth.user&&!BoatAuth.busy');await unloaded();
    assert.equal(server.boatCloudApi.getClientCount(),0);
    await evaluate('document.getElementById("accountLoginOpen").click()');await login('guest');
    await evaluate(card('boat-alpha','.fleet-video-button')+'.click()');await play('flv');
    assert.equal(await evaluate('BoatAuth.canManage'),false);
    assert.equal(await evaluate('document.getElementById("platformSettingsToggle").hidden'),true);
    for(const width of [1440,375,320])for(const theme of ['dark','light']){
      await send('Emulation.setDeviceMetricsOverride',{width,height:width<600?900:1000,deviceScaleFactor:1,mobile:width<600});
      await evaluate('BoatUI.setTheme('+JSON.stringify(theme)+');window.scrollTo({top:0,behavior:"instant"})');await wait(180);
      assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,width+'px '+theme+' video page fits');
      assert.equal(await evaluate('document.getElementById("view-video").scrollWidth>document.getElementById("view-video").clientWidth+1'),false,width+'px video content fits');
      await shot('video-'+width+'-'+theme);
    }

    const blockedBefore=requests.length;
    publish('boat-alpha','native','sample.mp4',{url:'http://localhost:'+media.address().port+'/sample.mp4?blocked-source=1'});
    await until('!boatMonitor.videoView.state().active&&/允许|来源|授权|配置/.test(document.getElementById("videoMessage").textContent)','unapproved source is rejected before network loading');await unloaded();
    await wait(300);assert.equal(requests.length,blockedBefore,'An unapproved source triggers no media request');
    const good=publish('boat-alpha');await play();
    assert.equal(bridge.acceptMessage('boats/boat-alpha/video',Buffer.from(JSON.stringify({...good,url:'javascript:alert(1)'}))),false);
    assert.equal(await evaluate('boatMonitor.videoView.state().active'),true,'Malformed MQTT descriptors do not replace confirmed playable addresses');
    publish('boat-alpha','hls','missing.m3u8');
    await until('/错误|失败|不可用|error/i.test(boatMonitor.videoView.state().status+" "+document.getElementById("videoStatus").textContent+" "+document.getElementById("videoMessage").textContent)','missing stream shows an actionable failure');
    publish('boat-alpha');await play();
    assert.equal(bridge.acceptMessage('boats/boat-alpha/video',Buffer.from(JSON.stringify({version:1,enabled:false})),{retain:true}),true);await unloaded();
    assert.equal(await evaluate('document.getElementById("videoEmpty").hidden'),false);
    await evaluate('document.getElementById("accountLogout").click()');await until('!BoatAuth.user&&!BoatAuth.busy');
    assert.equal(server.boatCloudApi.getClientCount(),0);assert.deepEqual(errors,[]);
    console.log('Chrome video passed: real local CloudBridge/auth/SSE, A/B isolation, video-only offline boats, native/HLS/FLV decoded playback, admin/guest access, repeated-descriptor stability, stop/retry, switch/navigation/logout unloading, source allowlist/error/clear handling, 1440/375/320px dark/light screenshots.');
  }finally{
    fs.writeFileSync(path.join(output,'video-browser-requests.json'),JSON.stringify(requests,null,2));
    socket?.close();browser.kill();server.closeAllConnections?.();media.closeAllConnections?.();
    await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>media.close(resolve))]);
    if(path.dirname(run)===output&&path.basename(run).startsWith('video-browser-state-'))fs.rmSync(run,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
