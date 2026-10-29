/* WebRTC 低延迟视频与原有 HTTP 视频共用生命周期；切船和隐藏页面立即释放连接。 */
(() => {
  'use strict';
  const formats={webrtc:'WebRTC · 低延迟',hls:'HLS',flv:'HTTP-FLV',native:'原生视频',auto:'自动识别'};
  const DEVICE=/^[A-Za-z0-9_-]{1,64}$/,PLAYBACK_BASE='/api/video/media/boats/';
  class BoatVideoView {
    constructor({document=window.document,location=window.location,Hls=window.Hls,mpegts=window.mpegts,
      fetch=window.fetch?.bind(window),RTCPeerConnection=window.RTCPeerConnection,MediaStream=window.MediaStream,
      AbortController=window.AbortController,setTimeout=window.setTimeout?.bind(window),clearTimeout=window.clearTimeout?.bind(window)}={}) {
      this.document=document;this.location=location;this.Hls=Hls;this.mpegts=mpegts;
      this.fetch=fetch;this.RTCPeerConnection=RTCPeerConnection;this.MediaStream=MediaStream;this.AbortController=AbortController;
      this.setTimer=setTimeout;this.clearTimer=clearTimeout;
      this.nodes=Object.fromEntries(['boatVideo','videoPlay','videoStop','videoRetry','videoFullscreen','videoStatus','videoDeviceName','videoTitle','videoFormat','videoSource','videoUpdated','videoEmpty','videoMessage'].map(id=>[id,document.getElementById(id)]));
      this.video=this.nodes.boatVideo;this.visible=false;this.enabled=true;this.destroyed=false;
      this.deviceId='';this.descriptor=null;this.allowedOrigins=[];this.authenticated=false;this.streaming=false;
      this.player=null;this.attached=false;this.format='';this.active=false;this.playing=false;this.signature='';this.generation=0;this.status='等待选择无人船';
      this.rtc=null;this.mediaConfig=fetch?null:{enabled:false};this.mediaConfigError='';this.mediaRequest=null;this.mediaGeneration=0;
      this.handlers=[];this.listen(this.nodes.videoPlay,'click',()=>{
        this.enabled=true;
        if(this.active){
          const generation=this.generation;
          const failed=()=>{if(!this.destroyed&&this.active&&generation===this.generation)this.setStatus('播放未能开始，请重新连接视频','warning');};
          try{this.video.play()?.catch(failed);}catch(_){failed();}
          return;
        }
        if(this.mediaConfigError)this.resetMediaConfig();
        this.release();this.reconcile();
      });
      this.listen(this.nodes.videoStop,'click',()=>{this.enabled=false;this.reconcile();});
      this.listen(this.nodes.videoRetry,'click',()=>{this.enabled=true;if(this.mediaConfigError)this.resetMediaConfig();this.release();this.reconcile();});
      this.listen(this.nodes.videoFullscreen,'click',()=>{
        const stage=this.video.closest('.video-stage');
        const result=stage?.requestFullscreen?stage.requestFullscreen():this.video.webkitEnterFullscreen?.();
        result?.catch(()=>this.setStatus('无法进入全屏，请使用播放器自带的全屏按钮','warning'));
      });
      this.listen(this.video,'playing',()=>{if(this.active){this.playing=true;this.setStatus(this.format==='webrtc'?'正在播放 · WebRTC 低延迟':'正在播放','success');}});
      this.listen(this.video,'waiting',()=>{if(this.active){this.playing=false;this.setStatus('画面缓冲中…');}});
      this.listen(this.video,'pause',()=>{if(this.active){this.playing=false;this.setStatus('画面已暂停');}});
      this.listen(this.video,'ended',()=>{if(this.active){this.playing=false;this.setStatus('视频已结束，可点击重新连接');}});
      this.listen(this.video,'error',()=>{
        if(this.active&&this.video.error)this.fail('视频加载失败，请检查视频服务、地址有效期和跨域访问设置');
      });
      this.reconcile();
    }
    listen(node,event,handler){node.addEventListener(event,handler);this.handlers.push([node,event,handler]);}
    text(id,value){const node=this.nodes[id];if(node.textContent!==String(value))node.textContent=String(value);}
    state(){return {deviceId:this.deviceId,format:this.format,active:this.active,playing:this.playing,visible:this.visible,status:this.status};}
    update({deviceId='',descriptor=null,authenticated=false,streaming=false,allowedOrigins=[]}={}) {
      if(this.destroyed)return;
      if(deviceId!==this.deviceId){this.enabled=true;this.resetMediaConfig();}
      else if(!authenticated||!streaming)this.resetMediaConfig();
      this.deviceId=deviceId;this.descriptor=descriptor;this.authenticated=authenticated;this.streaming=streaming;
      this.allowedOrigins=Array.isArray(allowedOrigins)?allowedOrigins:[];
      this.reconcile();
    }
    setVisible(visible){if(this.destroyed)return;this.visible=!!visible;if(!this.visible)this.cancelMediaConfig();this.reconcile();}
    source() {
      if(this.mediaConfig?.enabled===true&&DEVICE.test(this.deviceId))return {url:new URL(PLAYBACK_BASE+encodeURIComponent(this.deviceId)+'/whep',this.location.origin),format:'webrtc'};
      const descriptor=this.descriptor;
      if(!descriptor||typeof descriptor.url!=='string'||descriptor.url.length>2048||/[\u0000-\u001f\u007f\\]/.test(descriptor.url))return null;
      try{
        const url=new URL(descriptor.url);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)return null;
        const format=['auto','hls','flv','native'].includes(descriptor.format)?descriptor.format:'auto';
        return {url,format:format==='auto'?/\.m3u8$/i.test(url.pathname)?'hls':/\.flv$/i.test(url.pathname)?'flv':'native':format};
      }catch(_){return null;}
    }
    cancelMediaConfig(){
      const request=this.mediaRequest;if(!request)return;
      ++this.mediaGeneration;this.mediaRequest=null;this.clearTimer?.(request.timer);request.controller?.abort();
    }
    resetMediaConfig(){this.cancelMediaConfig();this.mediaConfig=this.fetch?null:{enabled:false};this.mediaConfigError='';}
    loadMediaConfig(){
      if(this.mediaRequest||this.mediaConfig||this.mediaConfigError||!this.fetch||!this.visible||!this.enabled)return;
      const token=++this.mediaGeneration,deviceId=this.deviceId,controller=this.AbortController?new this.AbortController():null;
      const request={controller,timer:null};this.mediaRequest=request;
      const current=()=>!this.destroyed&&this.mediaRequest===request&&token===this.mediaGeneration&&deviceId===this.deviceId&&this.visible&&this.authenticated&&this.streaming&&this.enabled;
      const finish=(error,data)=>{
        if(!current())return;
        this.clearTimer?.(request.timer);this.mediaRequest=null;
        if(error){controller?.abort();this.mediaConfigError=error.message||'无法读取视频服务配置，请点击重新连接';}
        else this.mediaConfig=data;
        this.reconcile();
      };
      request.timer=this.setTimer?.(()=>finish(Error('视频服务配置读取超时，请点击重新连接')),10000);
      Promise.resolve().then(()=>current()?this.fetch('/api/video/media/config',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},...(controller?{signal:controller.signal}:{})}):null)
        .then(async response=>{
          if(!response||!current())return null;
          // 旧服务器尚无低延迟入口时继续使用原有 HTTP 播放器；启用后的信令失败不会自动降级。
          if(response.status===404||response.status===405)return {enabled:false};
          if(!response.ok)throw Error(response.status===401?'登录已失效，请重新登录后查看视频':'无法读取视频服务配置，请点击重新连接');
          const data=await response.json();
          if(!data||typeof data.enabled!=='boolean')throw Error('视频服务配置无效，请联系管理员');
          if(data.enabled===false)return {enabled:false};
          if(data.format!=='webrtc'||data.playbackBase!==PLAYBACK_BASE)throw Error('低延迟视频服务配置无效，请联系管理员');
          return {enabled:true,format:'webrtc',playbackBase:PLAYBACK_BASE};
        }).then(data=>finish(null,data),error=>finish(error));
    }
    setStatus(message,tone='neutral') {
      this.status=message;this.text('videoStatus',message);this.nodes.videoStatus.dataset.tone=tone;
      this.nodes.videoEmpty.hidden=this.active;
      this.text('videoMessage',message);
      this.nodes.videoPlay.disabled=!this.canPlay||this.playing;
      this.nodes.videoStop.disabled=!this.active&&(!this.canPlay||this.enabled===false);
      this.nodes.videoRetry.disabled=!this.canPlay;
      this.nodes.videoFullscreen.disabled=!this.active;
    }
    reconcile() {
      if(this.destroyed)return;
      this.text('videoDeviceName',this.deviceId||'未选择无人船');
      this.text('videoTitle',this.descriptor?.title||'船载实时画面');
      const context=!!(this.authenticated&&this.streaming&&this.deviceId);
      if(context&&this.visible&&this.enabled)this.loadMediaConfig();
      const source=this.source();this.canPlay=!!(context&&(source||this.mediaConfigError||!this.mediaConfig));
      this.text('videoFormat',source?formats[source.format]:'--');
      this.text('videoSource',source?(source.format==='webrtc'?'SRT / UDP → '+source.url.host:source.url.host):'--');
      this.text('videoUpdated',source?.format==='webrtc'?'实时接收 · 无需发布视频地址':Number.isFinite(this.descriptor?.receivedAt)?new Date(this.descriptor.receivedAt).toLocaleString('zh-CN',{hour12:false})+(this.descriptor.retained?' · 保留地址':''):'--');
      let message='';
      if(!this.authenticated)message='请登录后查看无人船视频';
      else if(!this.deviceId||!this.streaming)message='请先选择一艘无人船查看视频';
      else if(!this.enabled){this.cancelMediaConfig();this.release();this.setStatus('视频已停止，点击播放重新接收');return;}
      else if(this.mediaConfigError)message=this.mediaConfigError;
      else if(!this.mediaConfig)message=this.visible?'正在检查低延迟视频服务…':'视频页面未显示，已暂停接收画面';
      else if(!source)message='等待这艘无人船发布视频地址';
      else if(this.location.protocol==='https:'&&source.url.protocol==='http:')message='请使用 HTTPS 视频地址，或通过本站视频服务接入';
      else if(source.url.origin!==this.location.origin&&!this.allowedOrigins.includes(source.url.origin))message='视频来源尚未授权，请联系管理员配置';
      if(message){this.canPlay=!!(context&&this.mediaConfigError);this.release();this.setStatus(message,'warning');return;}
      if(!this.visible){this.release();this.setStatus('视频页面未显示，已暂停接收画面');return;}
      const signature=JSON.stringify([this.deviceId,source.url.href,source.format]);
      // 船端重复发布同一个地址只更新说明，不重新下载流或重建播放器。
      if(signature===this.signature)return;
      this.release();this.signature=signature;this.format=source.format;
      this.start(source);
    }
    start(source) {
      const generation=this.generation;this.active=true;this.attached=true;this.playing=false;this.video.muted=true;
      this.setStatus('正在连接视频…');
      const current=()=>!this.destroyed&&this.active&&generation===this.generation;
      const play=()=>{
        if(!current())return;
        try{this.video.play()?.catch(error=>{
          if(!current()||error.name==='AbortError')return;
          this.playing=false;this.setStatus('浏览器暂停了自动播放，请点击画面中的播放按钮','warning');
        });}catch(_){if(current())this.fail('浏览器无法播放此视频，请尝试 HLS 视频地址');}
      };
      try{
        if(source.format==='webrtc'){
          this.startWebRtc(source,play);return;
        }else if(source.format==='hls'&&!this.video.canPlayType('application/vnd.apple.mpegurl')){
          if(!this.Hls?.isSupported())return this.fail('当前浏览器不支持此 HLS 视频，请更换浏览器');
          const player=this.player=new this.Hls({enableWorker:true,backBufferLength:15,maxBufferLength:15,liveSyncDurationCount:3});
          player.on(this.Hls.Events.MANIFEST_PARSED,play);
          player.on(this.Hls.Events.ERROR,(event,data)=>{if(current()&&data.fatal)this.fail('HLS 视频连接中断，请检查视频地址或重新连接');});
          player.attachMedia(this.video);player.loadSource(source.url.href);
        }else if(source.format==='flv'){
          if(!this.mpegts?.isSupported())return this.fail('当前浏览器不支持 HTTP-FLV，请使用 HLS 视频地址');
          const player=this.player=this.mpegts.createPlayer({type:'flv',isLive:true,url:source.url.href},
            {enableWorker:false,enableStashBuffer:false,lazyLoad:false,liveBufferLatencyChasing:true});
          player.on(this.mpegts.Events.ERROR,()=>{if(current())this.fail('HTTP-FLV 视频连接中断，请检查视频地址或重新连接');});
          player.attachMediaElement(this.video);player.load();play();
        }else{
          this.video.src=source.url.href;this.video.load();play();
        }
      }catch(_){if(current())this.fail('无法打开视频，请检查格式和视频服务');}
    }
    sessionUrl(value,source){
      if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\u007f\\]/.test(value))return null;
      try{
        const url=new URL(value,source.url);
        const base=source.url.pathname+'/';
        if(url.origin!==this.location.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(base))return null;
        const id=url.pathname.slice(base.length);
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return null;
        return url.pathname;
      }catch(_){return null;}
    }
    deleteSession(session){
      if(!session||!this.fetch)return;
      const controller=this.AbortController?new this.AbortController():null;
      const timer=this.setTimer?.(()=>controller?.abort(),5000);
      Promise.resolve().then(()=>this.fetch(session,{method:'DELETE',credentials:'same-origin',cache:'no-store',redirect:'error',keepalive:true,...(controller?{signal:controller.signal}:{})}))
        .catch(()=>{}).finally(()=>this.clearTimer?.(timer));
    }
    async startWebRtc(source,play){
      if(!this.RTCPeerConnection||!this.fetch)return this.fail('当前浏览器不支持 WebRTC，请使用新版浏览器');
      const generation=this.generation,controller=this.AbortController?new this.AbortController():null;
      let pc;
      try{pc=new this.RTCPeerConnection({iceServers:[]});}catch(_){return this.fail('无法创建 WebRTC 视频连接，请检查浏览器权限');}
      const rtc={pc,controller,session:null,handshakeTimer:null,disconnectTimer:null,cancelGather:null};this.rtc=rtc;
      const current=()=>!this.destroyed&&this.active&&this.rtc===rtc&&generation===this.generation;
      const fail=message=>{if(current())this.fail(message);};
      this.setStatus('正在建立 WebRTC 低延迟连接…');
      rtc.handshakeTimer=this.setTimer?.(()=>fail('WebRTC 连接超时，请检查船端推流和视频网络端口，然后重新连接'),20000);
      pc.ontrack=event=>{
        if(!current()){event.track?.stop?.();return;}
        let stream=event.streams?.[0];
        if(!stream){
          if(!this.MediaStream)return fail('浏览器无法接收视频轨道，请更换浏览器');
          stream=this.video.srcObject||new this.MediaStream();stream.addTrack(event.track);
        }
        this.video.srcObject=stream;play();
      };
      pc.onconnectionstatechange=()=>{
        if(!current())return;
        this.clearTimer?.(rtc.disconnectTimer);rtc.disconnectTimer=null;
        if(pc.connectionState==='connected'){
          this.clearTimer?.(rtc.handshakeTimer);rtc.handshakeTimer=null;
          if(!this.playing)this.setStatus('WebRTC 已连接，等待船载画面…');
        }else if(pc.connectionState==='disconnected'){
          this.setStatus('WebRTC 网络暂时中断…','warning');
          rtc.disconnectTimer=this.setTimer?.(()=>fail('WebRTC 视频连接中断，请点击重新连接'),4000);
        }else if(pc.connectionState==='failed'||pc.connectionState==='closed')fail('WebRTC 视频连接失败，请检查视频服务和 UDP 端口后重新连接');
      };
      try{
        pc.addTransceiver('video',{direction:'recvonly'});pc.addTransceiver('audio',{direction:'recvonly'});
        const offer=await pc.createOffer();if(!current())return;
        await pc.setLocalDescription(offer);if(!current())return;
        await new Promise((resolve,reject)=>{
          const finish=error=>{pc.removeEventListener('icegatheringstatechange',changed);rtc.cancelGather=null;error?reject(error):resolve();};
          const changed=()=>{if(pc.iceGatheringState==='complete')finish();};
          rtc.cancelGather=()=>finish(Error('WebRTC 已取消'));
          pc.addEventListener('icegatheringstatechange',changed);changed();
        });
        if(!current())return;
        const sdp=pc.localDescription?.sdp;
        if(typeof sdp!=='string'||!sdp.startsWith('v=0')||sdp.length>131072)throw Error('invalid offer');
        const response=await this.fetch(source.url.pathname,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
          headers:{Accept:'application/sdp','Content-Type':'application/sdp'},body:sdp,...(controller?{signal:controller.signal}:{})});
        const session=this.sessionUrl(response.headers?.get('Location'),source);
        // fetch 忽略 abort 或服务器响应较晚时，仍回收旧船已创建的会话。
        if(!current()){if(session)this.deleteSession(session);return;}
        if(response.status!==201||!session){
          if(session)this.deleteSession(session);
          if(response.status===401||response.status===403)return fail('视频访问未授权，请重新登录后重试');
          if(response.status===404)return fail('这艘无人船尚未发布低延迟视频，请检查船端 SRT 推流');
          return fail('无法建立低延迟视频会话，请检查视频服务后重新连接');
        }
        rtc.session=session;
        if(!/^application\/sdp(?:\s*;|$)/i.test(response.headers?.get('Content-Type')||''))throw Error('invalid answer content type');
        const answer=await response.text();if(!current())return;
        if(typeof answer!=='string'||!answer.startsWith('v=0')||answer.length>131072)throw Error('invalid answer');
        await pc.setRemoteDescription({type:'answer',sdp:answer});
        if(current()&&!this.playing)this.setStatus('WebRTC 已协商，正在接收船载画面…');
      }catch(_){fail('WebRTC 视频连接未能建立，请检查船端推流和视频服务后重新连接');}
    }
    fail(message) {
      // 失败后保持当前地址签名，等待显式重连或新地址，不因遥测刷新无限重试。
      const signature=this.signature;this.release();this.signature=signature;this.setStatus(message,'danger');
    }
    release() {
      ++this.generation;this.active=false;this.playing=false;this.signature='';this.format='';
      if(this.rtc){
        const rtc=this.rtc;this.rtc=null;
        this.clearTimer?.(rtc.handshakeTimer);this.clearTimer?.(rtc.disconnectTimer);rtc.cancelGather?.();rtc.controller?.abort();
        rtc.pc.ontrack=null;rtc.pc.onconnectionstatechange=null;
        try{rtc.pc.close();}catch(_){/* 已关闭的连接无需再次处理。 */}
        if(rtc.session)this.deleteSession(rtc.session);
        const stream=this.video.srcObject;this.video.srcObject=null;
        for(const track of stream?.getTracks?.()||[])track.stop?.();
      }
      if(this.player){
        const player=this.player;this.player=null;
        try{player.destroy();}catch(_){/* 已销毁的媒体连接不影响切船。 */}
      }
      if(this.attached){this.attached=false;this.video.pause();this.video.removeAttribute('src');this.video.load();}
    }
    destroy(){if(this.destroyed)return;this.destroyed=true;this.cancelMediaConfig();this.release();for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);this.handlers=[];}
  }
  window.BoatVideoView=BoatVideoView;
})();
