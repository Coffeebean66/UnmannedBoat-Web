/* MQTT 只提供当前船的视频地址；播放器独立管理媒体连接，切船和隐藏页面立即释放。 */
(() => {
  'use strict';
  const formats={hls:'HLS',flv:'HTTP-FLV',native:'原生视频',auto:'自动识别'};
  class BoatVideoView {
    constructor({document=window.document,location=window.location,Hls=window.Hls,mpegts=window.mpegts}={}) {
      this.document=document;this.location=location;this.Hls=Hls;this.mpegts=mpegts;
      this.nodes=Object.fromEntries(['boatVideo','videoPlay','videoStop','videoRetry','videoFullscreen','videoStatus','videoDeviceName','videoTitle','videoFormat','videoSource','videoUpdated','videoEmpty','videoMessage'].map(id=>[id,document.getElementById(id)]));
      this.video=this.nodes.boatVideo;this.visible=false;this.enabled=true;this.destroyed=false;
      this.deviceId='';this.descriptor=null;this.allowedOrigins=[];this.authenticated=false;this.streaming=false;
      this.player=null;this.attached=false;this.format='';this.active=false;this.playing=false;this.signature='';this.generation=0;this.status='等待选择无人船';
      this.handlers=[];this.listen(this.nodes.videoPlay,'click',()=>{
        this.enabled=true;
        if(this.active){
          const generation=this.generation;
          const failed=()=>{if(!this.destroyed&&this.active&&generation===this.generation)this.setStatus('播放未能开始，请重新连接视频','warning');};
          try{this.video.play()?.catch(failed);}catch(_){failed();}
          return;
        }
        this.release();this.reconcile();
      });
      this.listen(this.nodes.videoStop,'click',()=>{this.enabled=false;this.reconcile();});
      this.listen(this.nodes.videoRetry,'click',()=>{this.enabled=true;this.release();this.reconcile();});
      this.listen(this.nodes.videoFullscreen,'click',()=>{
        const stage=this.video.closest('.video-stage');
        const result=stage?.requestFullscreen?stage.requestFullscreen():this.video.webkitEnterFullscreen?.();
        result?.catch(()=>this.setStatus('无法进入全屏，请使用播放器自带的全屏按钮','warning'));
      });
      this.listen(this.video,'playing',()=>{if(this.active){this.playing=true;this.setStatus('正在播放','success');}});
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
      if(deviceId!==this.deviceId)this.enabled=true;
      this.deviceId=deviceId;this.descriptor=descriptor;this.authenticated=authenticated;this.streaming=streaming;
      this.allowedOrigins=Array.isArray(allowedOrigins)?allowedOrigins:[];
      this.reconcile();
    }
    setVisible(visible){if(this.destroyed)return;this.visible=!!visible;this.reconcile();}
    source() {
      const descriptor=this.descriptor;
      if(!descriptor||typeof descriptor.url!=='string'||descriptor.url.length>2048||/[\u0000-\u001f\u007f\\]/.test(descriptor.url))return null;
      try{
        const url=new URL(descriptor.url);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)return null;
        const format=['auto','hls','flv','native'].includes(descriptor.format)?descriptor.format:'auto';
        return {url,format:format==='auto'?/\.m3u8$/i.test(url.pathname)?'hls':/\.flv$/i.test(url.pathname)?'flv':'native':format};
      }catch(_){return null;}
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
      const source=this.source();this.canPlay=!!(this.authenticated&&this.streaming&&this.deviceId&&source);
      this.text('videoFormat',source?formats[source.format]:'--');
      this.text('videoSource',source?source.url.host:'--');
      this.text('videoUpdated',Number.isFinite(this.descriptor?.receivedAt)?new Date(this.descriptor.receivedAt).toLocaleString('zh-CN',{hour12:false})+(this.descriptor.retained?' · 保留地址':''):'--');
      let message='';
      if(!this.authenticated)message='请登录后查看无人船视频';
      else if(!this.deviceId||!this.streaming)message='请先选择一艘无人船查看视频';
      else if(!source)message='等待这艘无人船发布视频地址';
      else if(this.location.protocol==='https:'&&source.url.protocol==='http:')message='请使用 HTTPS 视频地址，或通过本站视频服务接入';
      else if(source.url.origin!==this.location.origin&&!this.allowedOrigins.includes(source.url.origin))message='视频来源尚未授权，请联系管理员配置';
      if(message){this.canPlay=false;this.release();this.setStatus(message,'warning');return;}
      if(!this.visible){this.release();this.setStatus('视频页面未显示，已暂停接收画面');return;}
      if(!this.enabled){this.release();this.setStatus('视频已停止，点击播放重新接收');return;}
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
        if(source.format==='hls'&&!this.video.canPlayType('application/vnd.apple.mpegurl')){
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
    fail(message) {
      // 失败后保持当前地址签名，等待显式重连或新地址，不因遥测刷新无限重试。
      const signature=this.signature;this.release();this.signature=signature;this.setStatus(message,'danger');
    }
    release() {
      ++this.generation;this.active=false;this.playing=false;this.signature='';this.format='';
      if(this.player){
        const player=this.player;this.player=null;
        try{player.destroy();}catch(_){/* 已销毁的媒体连接不影响切船。 */}
      }
      if(this.attached){this.attached=false;this.video.pause();this.video.removeAttribute('src');this.video.load();}
    }
    destroy(){if(this.destroyed)return;this.destroyed=true;this.release();for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);this.handlers=[];}
  }
  window.BoatVideoView=BoatVideoView;
})();
