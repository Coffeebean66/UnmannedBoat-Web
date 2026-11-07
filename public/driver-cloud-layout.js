/* 上传 / 启用平台驾驶布局；只同步显示偏好，不发送任何船只控制指令。 */
(function(scope){
  'use strict';
  const schema=typeof module==='object'&&module.exports?require('./utils/driverLayout'):scope.BoatModules.driverLayout;
  const ENDPOINT='/api/driver-layout';
  const cancelled=()=>Object.assign(Error('布局请求已取消'),{cancelled:true});
  class BoatDriverCloudLayout{
    constructor(options={}){
      this.scope=options.scope||scope;this.document=options.document||scope.document;
      this.driver=options.driver;this.auth=options.auth||scope.BoatAuth;this.fetch=options.fetch||scope.fetch.bind(scope);
      this.setTimer=options.setTimeout||scope.setTimeout.bind(scope);this.clearTimer=options.clearTimeout||scope.clearTimeout.bind(scope);
      this.pollMs=options.pollMs||10000;this.timeoutMs=options.timeoutMs||10000;
      this.nodes=Object.fromEntries(['driverCloudLayout','driverCloudLayoutStatus','driverCloudLayoutRead','driverCloudLayoutActions','driverCloudLayoutUpload','driverCloudLayoutEnable','driverCloudLayoutDisable'].map(id=>[id,this.document.getElementById(id)]));
      this.state=null;this.loaded=false;this.busy=false;this.destroyed=false;this.operation=0;this.poll=null;this.personalPreferences=null;this.message='';this.handlers=[];
      this.identity=this.accountIdentity();
      this.listen(this.nodes.driverCloudLayoutRead,'click',()=>this.read());
      this.listen(this.nodes.driverCloudLayoutUpload,'click',()=>this.upload());
      this.listen(this.nodes.driverCloudLayoutEnable,'click',()=>this.setEnabled(true));
      this.listen(this.nodes.driverCloudLayoutDisable,'click',()=>this.setEnabled(false));
      this.listen(this.auth,'change',()=>{
        const identity=this.accountIdentity();
        if(identity!==this.identity){this.identity=identity;this.cancel();this.restore();this.state=null;this.loaded=false;this.message='';if(this.canRead())this.read();}
        this.render();
      });
      this.listen(this.document,'visibilitychange',()=>{if(this.document.hidden)this.clearPoll();else if(this.canRead())this.read();});
      this.listen(this.scope,'boat-view-change',event=>{if(event.detail?.view==='driving'&&this.canRead())this.read();});
      this.render();if(this.canRead())this.read();
    }
    listen(node,event,handler){node?.addEventListener(event,handler);if(node)this.handlers.push([node,event,handler]);}
    accountIdentity(){return JSON.stringify([this.auth?.enabled,this.auth?.ready,this.auth?.generation,this.auth?.user?.username,this.auth?.user?.role]);}
    canRead(){return !this.destroyed&&this.auth?.enabled===true&&this.auth.ready===true&&['admin','driver','guest'].includes(this.auth.user?.role);}
    admin(){return this.canRead()&&this.auth.user.role==='admin';}
    preferredPrimary(){return this.state?.enabled?this.state.layout.preferences.primary:null;}
    capturePreferences(){const n=this.driver.nodes;return {overlayOpacity:Number(n.driverOverlayOpacity.value),instrumentsVisible:n['view-driving'].dataset.instrumentsHidden!=='true',primary:n['view-driving'].dataset.primary==='map'?'map':'video'};}
    applyPreferences(preferences,primary=true){
      this.driver.setOverlayOpacity(preferences.overlayOpacity,{persist:false,cloud:true});
      this.driver.setInstrumentsVisible(preferences.instrumentsVisible,{persist:false,cloud:true});
      if(primary&&this.driver.visible())this.driver.setMediaFocus(preferences.primary);
    }
    restore(primary=true){
      if(this.driver.layout.cloudLocked)this.driver.layout.useCloudProfiles(null);
      if(this.personalPreferences){this.applyPreferences(this.personalPreferences,primary);this.personalPreferences=null;}
      this.driver.layout.ui.driverLayoutSaved.textContent='布局保存在当前浏览器 · 云端统一布局停用后沿用本机设置';
    }
    accept(value){
      const layout=value?.layout===null?null:schema.normalizeCloudLayout(value?.layout);
      if(value?.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.enabled!=='boolean'||typeof value.persistent!=='boolean'||(value.layout!==null&&!layout)||(value.enabled&&!layout)||(value.updatedAt!==null&&(typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt))))||(value.error!==null&&typeof value.error!=='string'))throw Error('云端布局响应无效，请刷新重试');
      const changed=!this.loaded||this.state?.revision!==value.revision||this.state?.enabled!==value.enabled;
      this.state={...value,layout};this.loaded=true;
      if(changed){
        if(value.enabled){
          if(!this.personalPreferences)this.personalPreferences=this.capturePreferences();
          this.driver.layout.useCloudProfiles(layout.profiles);this.applyPreferences(layout.preferences);
          this.driver.layout.ui.driverLayoutSaved.textContent='正在使用云端统一布局 · 本机布局已保留，管理员停用后恢复';
        }else this.restore();
      }
      this.message=value.error||'';this.render();
    }
    clearPoll(){if(this.poll!==null)this.clearTimer(this.poll);this.poll=null;}
    schedule(){this.clearPoll();if(this.canRead()&&!this.document.hidden)this.poll=this.setTimer(()=>{this.poll=null;this.read();},this.pollMs);}
    cancel(){++this.operation;this.cancelRequest?.();this.cancelRequest=null;this.busy=false;this.clearPoll();}
    request(method,body){
      return new Promise((resolve,reject)=>{
        const controller=new AbortController();let finished=false;
        const finish=(error,value)=>{if(finished)return;finished=true;this.clearTimer(timer);if(this.cancelRequest===cancel)this.cancelRequest=null;error?reject(error):resolve(value);};
        const cancel=()=>{finish(cancelled());controller.abort();};
        const timer=this.setTimer(()=>{finish(Error('云端布局请求超时，请刷新后确认状态'));controller.abort();},this.timeoutMs);
        this.cancelRequest=cancel;
        Promise.resolve().then(async()=>{
          const response=await this.fetch(ENDPOINT,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
          const value=await response.json();
          if(!response.ok)throw Object.assign(Error(typeof value.error==='string'?value.error:'云端布局请求失败（'+response.status+'）'),{status:response.status});
          return value;
        }).then(value=>finish(null,value),error=>finish(error));
      });
    }
    async run(method,body){
      if(!this.canRead()||this.busy||(method!=='GET'&&!this.admin()))return false;
      const operation=++this.operation,identity=this.identity,current=()=>!this.destroyed&&operation===this.operation&&identity===this.accountIdentity();
      this.busy=true;this.message='';this.clearPoll();this.render();let conflict=false;
      try{
        if(method!=='GET'){await this.auth.verifyPlatformManage?.();if(!current()||!this.admin())throw cancelled();}
        const value=await this.request(method,body);if(!current())return false;
        this.accept(value);return true;
      }catch(error){
        if(current()&&!error.cancelled){this.message=error.status===404?'当前服务器尚未支持云端驾驶布局，请更新服务端':error.message||'无法同步云端驾驶布局';conflict=error.status===409;if(method!=='GET')this.driver.toast(this.message);if(error.status===401)this.auth.expire?.();}
        return false;
      }finally{if(current()){this.busy=false;this.render();if(conflict)this.read();else this.schedule();}}
    }
    read(){return this.run('GET');}
    upload(){
      if(!this.admin()||!this.loaded||this.state.enabled||this.busy)return Promise.resolve(false);
      const layout=this.driver.layout.snapshot(this.capturePreferences());
      if(!layout){this.message='当前布局无法上传，请检查显示设置';this.render();return Promise.resolve(false);}
      return this.run('PUT',{revision:this.state.revision,layout});
    }
    setEnabled(enabled){
      if(!this.admin()||!this.loaded||this.busy||typeof enabled!=='boolean'||(enabled&&!this.state.layout))return Promise.resolve(false);
      return this.run('PATCH',{revision:this.state.revision,enabled});
    }
    render(){
      const n=this.nodes,admin=this.admin(),enabled=this.state?.enabled===true;
      n.driverCloudLayout.hidden=this.auth?.enabled===false;n.driverCloudLayoutActions.hidden=!admin;
      n.driverCloudLayoutRead.disabled=!this.canRead()||this.busy;
      n.driverCloudLayoutUpload.disabled=!admin||!this.loaded||this.busy||enabled;
      n.driverCloudLayoutEnable.disabled=!admin||!this.loaded||this.busy||enabled||!this.state?.layout;
      n.driverCloudLayoutDisable.disabled=!admin||!this.loaded||this.busy||!enabled;
      this.driver.nodes.driverOverlayOpacity.disabled=enabled;this.driver.nodes.driverInstrumentToggle.disabled=enabled;
      this.driver.layout.ui.driverLayoutToggle?.setAttribute('title',enabled?'查看云端统一布局；管理员可停用后编辑':'调整各模块的位置、大小和透明度');
      n.driverCloudLayout.dataset.enabled=String(enabled);n.driverCloudLayout.setAttribute('aria-busy',String(this.busy));
      n.driverCloudLayoutStatus.dataset.tone=this.message?'error':enabled?'success':'neutral';
      n.driverCloudLayoutStatus.textContent=this.busy?'正在同步云端布局…':this.message||(enabled?'统一布局已启用，所有用户跟随云端，本机编辑已锁定。':!this.canRead()?'登录后读取云端统一布局。':!this.loaded?'尚未读取云端布局。':this.state?.layout?'云端布局已保存，尚未启用；当前使用本机布局。':'尚未上传云端布局；当前使用本机布局。');
    }
    destroy(){if(this.destroyed)return;this.destroyed=true;this.cancel();this.restore(false);for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);this.handlers=[];}
  }
  scope.BoatDriverCloudLayout=BoatDriverCloudLayout;
  if(typeof module==='object'&&module.exports)module.exports={BoatDriverCloudLayout};
})(typeof window==='object'?window:globalThis);
