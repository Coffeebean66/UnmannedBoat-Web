/* 本机真实 SRT 输入 → MediaMTX 录像 → 平台鉴权下载 → FFmpeg 解码；不接触生产服务。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),dgram=require('node:dgram');
const assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createServer}=require('../server'),{createRecordingTransport}=require('../server/video-recording-api');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(udp=false){const socket=udp?dgram.createSocket('udp4'):net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);udp?socket.bind(0,'127.0.0.1',resolve):socket.listen(0,'127.0.0.1',resolve);});const result=socket.address().port;await new Promise(resolve=>socket.close(resolve));return result;}
async function main(){
  const udpRtp=process.argv.includes('--udp-rtp');
  const output=path.resolve(__dirname,'../.test-output');fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'recording-native-')),storage=path.join(run,'video').replace(/\\/g,'/');
  fs.mkdirSync(storage);const children=[],logs=[];let server,media;
  const apiPort=await port(),playbackPort=await port(),whepPort=await port(),srtPort=await port(true),rtcPort=await port(true),udpPort=await port(true);
  const env={BOAT_ACCOUNTS_ENABLED:'1',BOAT_ADMIN_USERNAME:'recording-admin',BOAT_ADMIN_PASSWORD:'local-recording-admin',
    BOAT_GUEST_USERNAME:'recording-guest',BOAT_GUEST_PASSWORD:'local-recording-guest',BOAT_VIDEO_MEDIA_ENABLED:'1',
    BOAT_VIDEO_MEDIA_AUTH_TOKEN:'a'.repeat(64),BOAT_VIDEO_MEDIA_READER_PASSWORD:'b'.repeat(64),BOAT_VIDEO_MEDIA_PUBLIC_HOST:'127.0.0.1',
    BOAT_VIDEO_SRT_PORT:String(srtPort),BOAT_VIDEO_WEBRTC_PORT:String(rtcPort),BOAT_VIDEO_RECORDING_ENABLED:'1'};
  const root='/var/lib/unmanned-boat-video',camera={username:'local-camera',password:'local-camera-password'};
  const client=async(method,route,input)=>method==='GET'?{devices:[{deviceId:'boat-alpha'},{deviceId:'boat-beta'}],canAuthenticateVideo:true}:
    {authorized:route==='/video-auth/boat-alpha'&&input.username===camera.username&&input.password===camera.password};
  const transport=createRecordingTransport({port:apiPort});
  // 生产配置只允许 Linux 状态根目录；测试将这个目录映射到工作区，并缩短原生分段时间。
  const mappedTransport=async operation=>{
    let body=operation.body;
    if(body){const value=JSON.parse(body);if(value.recordPath)value.recordPath=value.recordPath.replace(root,storage);if(value.recordSegmentDuration)value.recordSegmentDuration='2s';body=Buffer.from(JSON.stringify(value));}
    const response=await transport({...operation,body});
    if(operation.path.startsWith('/v3/config/paths/get/')&&response.status===200){const value=JSON.parse(response.body);value.recordPath=value.recordPath?.replace(storage,root);if(value.recordSegmentDuration==='2s')value.recordSegmentDuration='60s';response.body=Buffer.from(JSON.stringify(value));}
    return response;
  };
  function start(binary,args,label){const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);for(const channel of ['stdout','stderr'])child[channel].on('data',data=>logs.push(label+': '+data));child.on('error',error=>logs.push(label+': '+error.message));return child;}
  async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill();setTimeout(resolve,3000).unref();});}
  async function until(task,label,timeout=20000){const start=Date.now();let last;while(Date.now()-start<timeout){try{last=await task();if(last)return last;}catch(error){last=error.message;}await wait(200);}throw Error(label+': '+JSON.stringify(last)+'\n'+logs.slice(-15).join(''));}
  async function open(){const cloud=new EventEmitter();Object.assign(cloud,{enabled:false,start(){},stop(){},list:()=>({brokerConnected:false,devices:[]})});
    server=createServer({env,cloud,accountOptions:{storeFile:path.join(run,'accounts.json')},mapOptions:{file:path.join(run,'map.json')},
      videoMediaOptions:{client},mqttAdminOptions:{client},videoRecordingOptions:{client,transport:mappedTransport,playbackPort,file:path.join(run,'recording.json'),reconcileMs:60000}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
  const origin=()=> 'http://127.0.0.1:'+server.address().port;
  async function request(route,{cookie,method='GET',body,headers={}}={}){const response=await fetch(origin()+route,{method,headers:{Origin:origin(),...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes);}catch(_){}return {status:response.status,headers:response.headers,bytes,data};}
  async function login(guest=false){const response=await request('/api/auth/login',{method:'POST',body:{username:guest?env.BOAT_GUEST_USERNAME:env.BOAT_ADMIN_USERNAME,password:guest?env.BOAT_GUEST_PASSWORD:env.BOAT_ADMIN_PASSWORD}});assert.equal(response.status,200,JSON.stringify(response.data));return response.headers.get('set-cookie').split(';')[0];}
  const base='/api/video/recording',boat=base+'/boats/boat-alpha';
  try{
    await open();
    const installer=fs.readFileSync(path.join(__dirname,'../maintenance/install-video-media.sh'),'utf8'),generator=installer.match(/<<'MEDIA_CONFIG'\r?\n([\s\S]*?)\r?\nMEDIA_CONFIG/)[1];
    const previous=path.join(run,'previous.env'),configuration=path.join(run,'mediamtx.yml');
    fs.writeFileSync(previous,'BOAT_VIDEO_MEDIA_AUTH_TOKEN='+env.BOAT_VIDEO_MEDIA_AUTH_TOKEN+'\nBOAT_VIDEO_MEDIA_READER_PASSWORD='+env.BOAT_VIDEO_MEDIA_READER_PASSWORD+'\n');
    const generated=spawnSync(process.execPath,['-',previous,path.join(run,'runtime.env'),configuration,'127.0.0.1',String(server.address().port)],{input:generator,encoding:'utf8',windowsHide:true,
      env:{...process.env,BOAT_VIDEO_UDP_DEVICE:udpRtp?'boat-alpha':'',BOAT_VIDEO_UDP_PORT:udpRtp?String(udpPort):'',BOAT_VIDEO_UDP_FORMAT:udpRtp?'rtp':''}});assert.equal(generated.status,0,generated.stderr);
    const yaml=fs.readFileSync(configuration,'utf8').replace('logLevel: warn','logLevel: info').replace('apiAddress: 127.0.0.1:9997','apiAddress: 127.0.0.1:'+apiPort)
      .replace('playbackAddress: 127.0.0.1:9996','playbackAddress: 127.0.0.1:'+playbackPort).replace('webrtcAddress: 127.0.0.1:8889','webrtcAddress: 127.0.0.1:'+whepPort)
      .replace('webrtcLocalUDPAddress: :8189','webrtcLocalUDPAddress: 127.0.0.1:'+rtcPort).replace('srtAddress: :8890','srtAddress: 127.0.0.1:'+srtPort).replaceAll(root,storage);
    fs.writeFileSync(configuration,yaml);
    const mediaPath=process.env.MEDIAMTX_PATH||(process.platform==='win32'?path.join(output,'mediamtx-v1.21.3/mediamtx.exe'):'mediamtx');
    const validation=spawnSync(mediaPath,['--validate-conf='+configuration],{encoding:'utf8',windowsHide:true});assert.equal(validation.status,0,validation.stderr);
    media=start(mediaPath,[configuration],'MediaMTX');
    await until(async()=>{const result=await fetch('http://127.0.0.1:'+apiPort+'/v3/config/global/get',{headers:{Authorization:'Basic '+Buffer.from('boat-web-media-reader:'+env.BOAT_VIDEO_MEDIA_READER_PASSWORD).toString('base64')}});return result.ok;},'Authenticated native API ready');
    const admin=await login(),guest=await login(true);
    assert.equal((await request(boat)).status,401);
    assert.equal((await request(boat+'/start',{cookie:guest,method:'POST',body:{}})).status,403);
    const armed=await request(boat+'/start',{cookie:admin,method:'POST',body:{}});assert.equal(armed.status,200,JSON.stringify(armed.data));assert.equal(armed.data.armed,true);assert.equal(armed.data.receiving,false);assert.equal(armed.data.error,null);
    assert.equal((await request(base+'/config',{cookie:admin,method:'PATCH',body:{directory:root+'/mission-2'}})).status,409);
    const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?'D:/ClaudeTools/ffmpeg/ffmpeg-8.1-essentials_build/bin/ffmpeg.exe':'ffmpeg');
    const outputArgs=udpRtp?['-f','rtp','-payload_type','96','rtp://127.0.0.1:'+udpPort+'?pkt_size=1200']:
      ['-f','mpegts','srt://127.0.0.1:'+srtPort+'?streamid=publish:boat-alpha:'+camera.username+':'+camera.password+'&pkt_size=1316&latency=120000'];
    const sender=start(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-re','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-an','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-profile:v','baseline','-g','15','-keyint_min','15','-bf','0',...outputArgs],udpRtp?'RTP sender':'SRT sender');
    const snapshot=await until(async()=>{const response=await request(boat,{cookie:guest});return response.data?.recording&&response.data.segments.length?response.data:null;},'Server records without an open webpage');
    assert.equal((await request(base+'/boats/boat-beta',{cookie:guest})).data.armed,false);
    const clip=snapshot.segments.at(-1),download=await request(clip.downloadUrl,{cookie:guest});assert.equal(download.status,200,JSON.stringify(download.data));assert.match(download.headers.get('content-type'),/^video\/mp4/);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.ok(download.bytes.length>1000);
    const downloaded=path.join(run,'downloaded.mp4');fs.writeFileSync(downloaded,download.bytes);
    const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-i',downloaded,'-frames:v','1','-f','null','-'],{encoding:'utf8',windowsHide:true});assert.equal(decoded.status,0,decoded.stderr);
    assert.equal((await request(clip.playbackUrl.replace('boat-alpha','boat-beta'),{cookie:guest})).status,404);
    const ranged=await request(clip.playbackUrl,{cookie:guest,headers:{Range:'bytes=0-127'}});assert.ok([200,206].includes(ranged.status));if(ranged.status===206)assert.equal(ranged.bytes.length,128);
    assert.equal((await request(boat+'/stop',{cookie:admin,method:'POST',body:{}})).data.armed,false);
    const changed=await request(base+'/config',{cookie:admin,method:'PATCH',body:{directory:root+'/mission-2'}});assert.equal(changed.status,200,JSON.stringify(changed.data));
    await request(boat+'/start',{cookie:admin,method:'POST',body:{}});
    const next=await until(async()=>{const response=await request(boat,{cookie:guest});return response.data?.segments.some(item=>item.id!==clip.id)&&fs.existsSync(path.join(storage,'mission-2','boat-alpha'))?response.data:null;},'New folder receives segments');
    assert.ok(next.segments.every(item=>item.id!==clip.id),'Catalog follows current folder');
    assert.ok(fs.existsSync(path.join(storage,'recordings','boat-alpha')),'Old files remain on disk');
    assert.equal((await request(clip.downloadUrl,{cookie:guest})).status,404,'Old folder is not exposed as current');
    assert.equal((await request(boat+'/stop',{cookie:admin,method:'POST',body:{}})).status,200);
    await stop(sender);await stop(media);
    media=start(mediaPath,[configuration],'MediaMTX restart');
    await until(async()=>{await server.boatRecordingApi.reconcile();const response=await request(boat,{cookie:guest});return response.data?.segments.length&&!response.data.error;},'Native restart restores recording paths');
    assert.equal((await request(base+'/config',{cookie:admin,method:'PATCH',body:{directory:root+'/recordings'}})).status,200);
    assert.equal((await request(clip.downloadUrl,{cookie:guest})).status,200,'Switching back restores the original catalog');
    const stored=JSON.parse(fs.readFileSync(path.join(run,'recording.json'),'utf8'));assert.equal(stored.directory,root+'/recordings');assert.equal(stored.boats['boat-alpha'].armed,false);
    console.log('PASS: real MediaMTX config, authenticated API/playback, no-viewer '+(udpRtp?'UDP/RTP':'SRT')+' recording, boat isolation, MP4 decode, range, directory change, preserved files and native restart');
  }finally{for(const child of children.reverse())await stop(child);if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.writeFileSync(path.join(run,'native.log'),logs.join(''));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
