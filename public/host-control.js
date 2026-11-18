/* 上位机接管按船切换，只有单片机ACK后更新开关；目标值来自船端实收快照。 */
(() => {
  'use strict';
  const DEVICE=/^[A-Za-z0-9_-]{1,64}$/;
  class BoatHostControlPanel {
    constructor({document=window.document,fetch=window.fetch.bind(window),auth=window.BoatAuth,toast=()=>{}}={}){
      this.document=document;this.fetch=fetch;this.auth=auth;this.toast=toast;
      this.context={deviceId:'',connected:false,authenticated:false,parameterBusy:false};
      this.value=null;this.busy=false;this.polling=false;this.generation=0;this.error='';this.readAt=0;
      this.buttons=[...document.querySelectorAll('[data-host-control-toggle]')];
      for(const button of this.buttons)button.addEventListener('click',()=>this.toggle());
      this.timer=setInterval(()=>this.poll(),250);
      auth?.addEventListener('change',()=>{++this.generation;this.controller?.abort();this.value=null;this.busy=false;this.error='';this.render();this.poll();});
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.poll();});
      window.addEventListener('pagehide',()=>{clearInterval(this.timer);this.controller?.abort();},{once:true});
      this.render();
    }
    canOperate(){return this.auth?.enabled===true&&this.auth?.ready===true&&['admin','driver'].includes(this.auth?.user?.role);}
    update(next){
      if(next.deviceId!==this.context.deviceId||next.authenticated!==this.context.authenticated){
        ++this.generation;this.controller?.abort();this.value=null;this.busy=false;this.error='';this.readAt=0;
      }
      this.context={...this.context,...next};this.render();
    }
    async request(deviceId,enabled){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
      if(enabled!==undefined)this.controller=controller;
      try{
        const response=await this.fetch('/api/cloud/host-control'+(enabled===undefined?'?deviceId='+encodeURIComponent(deviceId):''),{
          method:enabled===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
          ...(enabled===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,enabled})})});
        const value=await response.json();if(!response.ok)throw Error(value.error||'无法读取上位机控制状态');return value;
      }finally{clearTimeout(timer);if(this.controller===controller)this.controller=null;}
    }
    async poll(){
      const {deviceId,authenticated}=this.context;
      if(this.polling||this.busy||this.document.hidden||!authenticated||!DEVICE.test(deviceId))return;
      const generation=this.generation;this.polling=true;
      try{
        const value=await this.request(deviceId);
        if(generation!==this.generation||value.deviceId!==deviceId)return;
        this.value=value;this.readAt=performance.now();this.error='';
      }catch(error){if(generation===this.generation){this.value=null;this.error=error.name==='AbortError'?'上位机状态读取超时':error.message;}}
      finally{this.polling=false;this.render();}
    }
    async toggle(){
      if(this.busy||!this.canOperate()||!this.context.connected||this.context.parameterBusy||!this.value?.ready||performance.now()-this.readAt>1500)return;
      const deviceId=this.context.deviceId,generation=++this.generation,enabled=!this.value?.hostControl?.enabled;
      this.busy=true;this.error='';this.render();
      try{
        const value=await this.request(deviceId,enabled);
        if(generation!==this.generation||value.deviceId!==this.context.deviceId)return;
        this.value=value;this.readAt=performance.now();
        this.toast(enabled?'单片机已确认：上位机控制已开启':'单片机已确认：上位机控制已关闭并停船');
        window.dispatchEvent(new CustomEvent('boat-host-control-change',{detail:{deviceId,enabled:value.hostControl?.enabled===true}}));
      }catch(error){if(generation===this.generation){this.value=null;this.error=error.name==='AbortError'?'切换结果未知，正在重新读取船端状态':error.message;this.toast(this.error);}}
      finally{if(generation===this.generation){this.busy=false;this.render();this.poll();}}
    }
    render(){
      const {deviceId,connected,authenticated,parameterBusy}=this.context,value=this.value,host=value?.hostControl;
      const fresh=connected&&host?.valid&&host.ageMs+performance.now()-this.readAt<host.timeoutMs,enabled=host?.enabled===true;
      const put=(id,text)=>{const node=this.document.getElementById(id);if(node&&node.textContent!==text)node.textContent=text;};
      put('hostTargetSpeed',fresh?(host.targetSpeedMmS/1000).toFixed(3):'--');
      put('hostTargetHeading',fresh?(host.targetHeadingCdeg/100).toFixed(2):'--');
      put('hostTargetAge',connected&&host&&host.ageMs<65535?'约 '+host.ageMs+' ms':'--');
      put('driverHostTargets',fresh?(host.targetSpeedMmS/1000).toFixed(3)+' m/s · '+(host.targetHeadingCdeg/100).toFixed(2)+'°':'-- m/s · --°');
      put('hostControlStatus',this.busy?'等待船端确认':!connected?'等待实时连接':enabled?(fresh?'上位机已接管':'上位机已启用 · 等待有效目标'):'未启用');
      put('hostControlNotice',this.error||(!deviceId?'请先选择无人船':!authenticated?'请先登录平台':!connected?'连接后显示上位机目标速度与真北航向':value?.message||'正在读取船端状态'));
      const badge=this.document.getElementById('hostControlStatus');if(badge)badge.dataset.state=enabled?(fresh?'active':'waiting'):'idle';
      for(const button of this.buttons){
        button.hidden=!this.canOperate();button.disabled=this.busy||!connected||parameterBusy||!value?.ready||performance.now()-this.readAt>1500;
        button.textContent=this.busy?'等待确认…':enabled?'关闭上位机并停船':'开启上位机控制';
        button.setAttribute('aria-pressed',String(enabled));
      }
    }
  }
  window.BoatHostControlPanel=BoatHostControlPanel;
})();
