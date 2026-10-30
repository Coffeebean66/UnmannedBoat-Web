/* 浏览器只在管理员主动接管并收到船端确认后发送运动；不在本机保存接管凭据。 */
(() => {
  'use strict';
  const MODES=['PWM 油门','船速闭环','航向闭环'];
  const KEYS={KeyW:'forward',ArrowUp:'forward',KeyS:'backward',ArrowDown:'backward',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right'};
  const DEVICE=/^[A-Za-z0-9_-]{1,64}$/,LEASE=/^[0-9a-f]{16}$/;
  class BoatDriverControl {
    constructor({document=window.document,fetch=window.fetch.bind(window),auth=window.BoatAuth,toast=()=>{}}={}) {
      this.document=document;this.fetch=fetch;this.auth=auth;this.toast=toast;
      this.nodes=Object.fromEntries(['view-driving','driverBoatName','driverState','driverEnable','driverRelease','driverEmergency','driverNotice','driverActualSpeed','driverTargetSpeed','driverActualHeading','driverActualMode','driverInput','driverMode','driverLimit','driverLimitValue','driverHeading','driverHoldHeading','driverVideoExpand','driverMapExpand','driverOverlayOpacity','driverOverlayOpacityValue','driverFocusTools'].map(id=>[id,document.getElementById(id)]));
      const random=new Uint8Array(8);window.crypto.getRandomValues(random);
      this.clientId=Array.from(random,value=>value.toString(16).padStart(2,'0')).join('');
      this.context={deviceId:'',connected:false,authenticated:false,canManage:false,parameterBusy:false};
      this.keys=new Set();this.remote=null;this.leaseId='';this.sequence=0;this.active=false;this.pending=false;
      this.request=null;this.polling=false;this.generation=0;this.destroyed=false;this.lastPoll=0;this.lastPulse=performance.now();
      this.message='选择在线无人船，由管理员启用操控后使用键盘驾驶。';this.tone='';this.actualHeading=null;
      this.lastMode=Number(this.nodes.driverMode.value);
      this.handlers=[];
      this.listen(this.nodes.driverEnable,'click',()=>this.acquire());
      this.listen(this.nodes.driverRelease,'click',()=>this.stop('已停船并退出电脑操控'));
      this.listen(this.nodes.driverEmergency,'click',()=>this.stop('急停已触发；需要重新启用操控',true));
      this.listen(this.nodes.driverMode,'change',()=>{
        const mode=Number(this.nodes.driverMode.value);
        if(mode===2&&!Number.isFinite(this.actualHeading)){this.nodes.driverMode.value=String(this.lastMode);this.toast('等待有效的真北船头航向后才能进入航向模式');return;}
        if(mode===2)this.nodes.driverHeading.value=this.actualHeading.toFixed(2);
        this.lastMode=mode;this.keys.clear();this.renderKeys();this.headingMode();this.sendInput();this.render();
      });
      this.listen(this.nodes.driverLimit,'input',()=>{this.text('driverLimitValue',this.nodes.driverLimit.value+'%');this.sendInput();});
      let savedOpacity;
      try{const storedOpacity=window.localStorage?.getItem('boat-driver-overlay-opacity');if(storedOpacity!==null)savedOpacity=Number(storedOpacity);}catch(_){}
      if(Number.isFinite(savedOpacity))this.nodes.driverOverlayOpacity.value=String(Math.max(0,Math.min(100,Math.round(savedOpacity/5)*5)));
      this.setOverlayOpacity(this.nodes.driverOverlayOpacity.value);
      this.listen(this.nodes.driverOverlayOpacity,'input',()=>this.setOverlayOpacity(this.nodes.driverOverlayOpacity.value));
      this.listen(this.nodes.driverHeading,'change',()=>{this.headingValue(true);this.sendInput();});
      this.listen(this.nodes.driverHoldHeading,'click',()=>{
        if(!Number.isFinite(this.actualHeading))return this.toast('等待有效的真北船头航向');
        this.nodes.driverHeading.value=this.actualHeading.toFixed(2);this.sendInput();
      });
      this.listen(this.nodes.driverVideoExpand,'click',()=>this.focusMedia('video'));
      this.listen(this.nodes.driverMapExpand,'click',()=>this.focusMedia('map'));
      this.listen(document,'keydown',event=>this.keyDown(event));
      this.listen(document,'keyup',event=>this.keyUp(event));
      // 输入框不接受运动快捷键，进入表单时先撤去键盘运动量。
      this.listen(document,'focusin',event=>{if(this.editing(event.target)&&this.keys.size){this.keys.clear();this.renderKeys();this.sendInput();}});
      this.listen(window,'blur',()=>this.stop('窗口失去焦点，已停船并退出操控'));
      this.listen(window,'pagehide',()=>this.stop('页面已关闭，已请求停船'));
      this.listen(document,'visibilitychange',()=>{if(document.hidden)this.stop('页面进入后台，已停船并退出操控');});
      this.listen(window,'boat-view-change',event=>{
        if(event.detail?.view!=='driving'){
          this.stop('已离开驾驶界面，已停船并退出操控');
          this.setMediaFocus('');
        }
        this.render();if(event.detail?.view==='driving'){this.lastPoll=0;this.poll();}
      });
      this.listen(window,'boat-selection-change',event=>{
        if(event.detail?.selectedId!==this.context.deviceId)this.stop('无人船已切换，已停止原船操控');
      });
      if(auth)this.listen(auth,'change',()=>{if(!this.admin())this.stop('管理员身份已失效，已停船并退出操控');this.render();});
      this.timer=window.setInterval(()=>this.pulse(),100);
      this.headingMode();this.render();
    }
    listen(target,event,handler){target.addEventListener(event,handler);this.handlers.push([target,event,handler]);}
    text(id,value){const text=String(value??'--');if(this.nodes[id].textContent!==text)this.nodes[id].textContent=text;}
    visible(){return window.BoatWorkspace?.current==='driving'&&!this.document.hidden;}
    admin(){return this.auth?.enabled===true&&this.auth?.ready===true&&this.auth?.user?.role==='admin';}
    permitted(){return this.visible()&&this.admin()&&this.context.connected&&this.context.authenticated&&DEVICE.test(this.context.deviceId)&&!this.context.parameterBusy;}
    editing(target){return !!(target?.isContentEditable||target?.closest?.('input,select,textarea,[contenteditable="true"],dialog[open]'));}
    held(direction){return [...this.keys].some(code=>KEYS[code]===direction);}
    state(){return {deviceId:this.context.deviceId,active:this.active,pending:this.pending,leaseId:this.leaseId,sequence:this.sequence,keys:[...this.keys],remote:this.remote};}
    update(next={}) {
      const before=this.context;
      const merged={...before,...next};
      if(before.deviceId!==merged.deviceId){this.stop('无人船已切换，已停止原船操控');this.remote=null;this.lastPoll=0;}
      this.context=merged;
      if((this.active||this.pending)&&!this.permitted())this.stop('操控条件已变化，已停船并退出操控');
      this.render();
    }
    setTelemetry(value={}) {
      this.text('driverActualSpeed',value.actual);this.text('driverTargetSpeed',value.target);
      this.text('driverActualHeading',value.actualHeading);this.text('driverActualMode',value.modeText);
      this.actualHeading=typeof value.actualHeading==='string'&&value.actualHeading.trim()!==''&&value.actualHeading!=='--'?Number(value.actualHeading):Number.isFinite(value.actualHeading)?value.actualHeading:null;
    }
    async api(body,{timeout=1200,keepalive=false,controller=new AbortController()}={}) {
      const timer=window.setTimeout(()=>controller.abort(),timeout);
      try {
        const url='/api/cloud/control'+(body?'':'?deviceId='+encodeURIComponent(this.context.deviceId)+'&clientId='+this.clientId);
        const response=await this.fetch(url,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',cache:'no-store',keepalive,signal:controller.signal,
          headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        const value=await response.json().catch(()=>({}));
        if(!response.ok){if(response.status===401)this.auth?.expire?.();throw Error(value.error||'驾驶控制请求失败（'+response.status+'）');}
        return value;
      } finally {window.clearTimeout(timer);}
    }
    headingValue(correct=false) {
      let value=Number(this.nodes.driverHeading.value);
      if(!Number.isFinite(value))value=0;
      value=Math.max(0,Math.min(359.99,value));
      if(correct)this.nodes.driverHeading.value=String(value);
      return Math.round(value*100);
    }
    inputs() {
      const amount=Math.round(Math.max(5,Math.min(100,Number(this.nodes.driverLimit.value)||20))*10);
      const forward=Number(this.held('forward'))-Number(this.held('backward'));
      const turn=Number(this.held('right'))-Number(this.held('left'));
      const mode=Number(this.nodes.driverMode.value);
      return {mode,throttle:forward*amount,turn:mode===2?0:turn*amount,targetHeading:this.headingValue()};
    }
    payload(action,id=this.context.deviceId,leaseId=this.leaseId) {
      return {deviceId:id,clientId:this.clientId,action,leaseId,sequence:++this.sequence,...this.inputs()};
    }
    async acquire() {
      if(!this.permitted()||this.active||this.pending||!this.remote?.ready)return;
      if(Number(this.nodes.driverMode.value)===2){
        if(!Number.isFinite(this.actualHeading)){this.toast('等待有效的真北船头航向后才能启用航向模式');return;}
        this.nodes.driverHeading.value=this.actualHeading.toFixed(2);
      }
      this.keys.clear();this.renderKeys();this.pending=true;this.message='正在等待单片机确认接管；确认前键盘不会驱动电机';this.tone='';this.render();
      const generation=++this.generation,id=this.context.deviceId,controller=new AbortController();this.request=controller;
      try {
        const result=await this.api({deviceId:id,clientId:this.clientId,action:'acquire',...this.inputs(),throttle:0,turn:0},{timeout:3000,controller});
        const acknowledged=result.active===true&&result.owned===true&&result.state===1&&result.status==='active'&&LEASE.test(result.leaseId||'');
        if(generation!==this.generation||!this.permitted()){
          if(LEASE.test(result.leaseId||''))this.releaseDetached(id,result.leaseId);
          return;
        }
        if(!acknowledged)throw Error(result.message||'未收到单片机接管确认，操控未启用');
        this.remote=result;this.leaseId=result.leaseId;this.sequence=0;this.active=true;
        this.message='单片机已确认电脑接管，遥控器输入已屏蔽；按住键盘运动，松开归零。';
      } catch(error) {
        if(generation===this.generation){this.message=error.name==='AbortError'?'接管确认超时，操控未启用':error.message;this.tone='error';}
      } finally {
        if(generation===this.generation){this.pending=false;this.request=null;this.render();if(this.active)this.sendInput();}
      }
    }
    async poll() {
      if(this.destroyed||this.polling||!this.visible()||!this.admin()||!this.context.authenticated||!DEVICE.test(this.context.deviceId))return;
      const id=this.context.deviceId,generation=this.generation;this.polling=true;this.lastPoll=performance.now();
      try {
        const value=await this.api(null,{timeout:1200});
        if(id!==this.context.deviceId||generation!==this.generation)return;
        this.remote=value;
        if(this.active&&(!value.active||!value.owned||value.status!=='active'||value.leaseId!==this.leaseId))this.stop(value.message||'单片机已退出接管，已停船');
      } catch(error) {
        if(id===this.context.deviceId&&generation===this.generation){
          if(this.active)this.stop('控制状态中断，已请求停船并退出操控');
          this.remote=null;this.message=error.name==='AbortError'?'无法读取船端操控状态':error.message;this.tone='error';
        }
      } finally {this.polling=false;this.render();}
    }
    async sendInput() {
      if(!this.active||this.request||!this.permitted())return;
      const generation=this.generation,controller=new AbortController();this.request=controller;
      const payload=this.payload('input');this.renderKeys();
      try {
        const value=await this.api(payload,{timeout:400,controller});
        if(generation!==this.generation)return;
        if(!value.active||!value.owned||value.state!==1||value.status!=='active'||value.leaseId!==this.leaseId)return this.stop(value.message||'单片机不再处于电脑操控状态');
        this.remote=value;
      } catch(error) {
        if(generation===this.generation)this.stop(error.name==='AbortError'?'控制链路响应超时，已请求停船':error.message,true);
      } finally {if(generation===this.generation)this.request=null;this.render();}
    }
    releaseDetached(id,leaseId,emergency=false) {
      const stop=this.payload(emergency?'stop':'release',id,leaseId);stop.throttle=0;stop.turn=0;
      // keepalive用于关闭/切页时尽力发出停船；船端仍独立检查500ms心跳，不能依靠此请求保证。
      const task=this.api(stop,{timeout:600,keepalive:true}).catch(()=>{});
      if(emergency)task.finally(()=>{const release=this.payload('release',id,leaseId);release.throttle=release.turn=0;this.api(release,{timeout:600,keepalive:true}).catch(()=>{});});
    }
    stop(message='已停船并退出电脑操控',emergency=false) {
      const wasActive=this.active||this.pending,id=this.context.deviceId,leaseId=this.leaseId;
      if(!wasActive&&!leaseId)return;
      ++this.generation;this.request?.abort();this.request=null;this.active=false;this.pending=false;this.leaseId='';
      this.keys.clear();this.message=message;this.tone=emergency?'error':'';this.renderKeys();
      if(LEASE.test(leaseId))this.releaseDetached(id,leaseId,emergency);
      this.lastPoll=0;this.render();
    }
    keyDown(event) {
      if(event.code==='Escape'&&this.nodes['view-driving'].hasAttribute('data-focus')){event.preventDefault();this.setMediaFocus('');return;}
      if(!this.active||!this.permitted())return;
      if(event.code==='Space'){event.preventDefault();this.stop('急停已触发；需要重新启用操控',true);return;}
      if(event.ctrlKey||event.metaKey||event.altKey||this.editing(event.target))return;
      const key=KEYS[event.code];if(!key)return;
      event.preventDefault();if(event.repeat)return;
      this.keys.add(event.code);this.renderKeys();this.sendInput();
    }
    keyUp(event) {
      const key=KEYS[event.code];if(!key)return;
      if(this.keys.has(event.code)){event.preventDefault();this.keys.delete(event.code);this.renderKeys();this.sendInput();}
    }
    pulse() {
      if(this.destroyed)return;
      const now=performance.now(),delta=Math.min(.2,Math.max(0,(now-this.lastPulse)/1000));this.lastPulse=now;
      if(this.active){
        if(!this.permitted())return this.stop('操控条件失效，已停船并退出操控');
        if(Number(this.nodes.driverMode.value)===2){
          const sign=Number(this.held('right'))-Number(this.held('left'));
          if(sign){const heading=((this.headingValue()/100+sign*30*delta)%360+360)%360;this.nodes.driverHeading.value=heading.toFixed(2);}
        }
        this.sendInput();
      }
      if(this.visible()&&now-this.lastPoll>(this.active?500:2000))this.poll();
    }
    renderKeys() {
      for(const node of this.document.querySelectorAll('[data-driver-key]'))node.dataset.pressed=String(this.held(KEYS[node.dataset.driverKey]));
      const input=this.inputs();this.text('driverInput',(this.active?input.throttle/10:0)+'% / '+(this.active?input.turn/10:0)+'%');
    }
    headingMode() {
      const enabled=Number(this.nodes.driverMode.value)===2;
      this.nodes.driverHeading.disabled=!enabled;this.nodes.driverHoldHeading.disabled=!enabled;
      this.nodes.driverHeading.closest('label').dataset.disabled=String(!enabled);
    }
    focusMedia(name) {
      this.setMediaFocus(this.nodes['view-driving'].dataset.focus===name?'':name);
    }
    setMediaFocus(name) {
      const panel=this.nodes['view-driving'];
      if(name)panel.dataset.focus=name;else delete panel.dataset.focus;
      if(name)this.document.documentElement.dataset.driverFocus='true';else delete this.document.documentElement.dataset.driverFocus;
      for(const [type,id]of [['video','driverVideoExpand'],['map','driverMapExpand']]){
        const active=panel.dataset.focus===type;this.nodes[id].setAttribute('aria-pressed',String(active));
        this.text(id,active?'还原布局':type==='video'?'放大图传':'放大地图');
      }
      this.nodes.driverFocusTools.hidden=!panel.hasAttribute('data-focus');
      this.updateOverlayInteraction();
      window.dispatchEvent(new CustomEvent('boat-driver-layout-change'));
    }
    setOverlayOpacity(value) {
      const opacity=Math.max(0,Math.min(100,Number(value)||0));
      this.nodes.driverOverlayOpacity.value=String(opacity);
      this.nodes['view-driving'].style.setProperty('--driver-overlay-opacity',(opacity/100).toFixed(2));
      this.nodes['view-driving'].dataset.overlayHidden=String(opacity===0);
      this.updateOverlayInteraction();
      this.text('driverOverlayOpacityValue',opacity+'%');
      try{window.localStorage?.setItem('boat-driver-overlay-opacity',String(opacity));}catch(_){}
    }
    updateOverlayInteraction() {
      const panel=this.nodes['view-driving'];
      // 普通布局恢复全部仪表的交互，隐藏的浮层不进入 Tab 焦点顺序。
      const hidden=panel.hasAttribute('data-focus')&&panel.dataset.overlayHidden==='true';
      for(const node of panel.querySelectorAll('.driver-instrument-grid,.driver-telemetry,.driver-notice'))node.inert=hidden;
    }
    render() {
      if(this.destroyed)return;
      this.text('driverBoatName',this.context.deviceId||'未选择无人船');
      const state=this.active?'active':this.pending?'pending':'idle';this.nodes.driverState.dataset.state=state;
      this.text('driverState',this.active?'电脑已接管':this.pending?'等待船端确认':this.remote?.state===2?'停船保护':'监测待机');
      this.nodes.driverEnable.disabled=!this.permitted()||this.active||this.pending||!this.remote?.ready||(Number(this.nodes.driverMode.value)===2&&!Number.isFinite(this.actualHeading));
      this.text('driverEnable',this.pending?'等待确认…':this.active?'操控已启用':'启用操控');
      this.nodes.driverEnable.hidden=!this.admin();
      this.nodes.driverRelease.disabled=!this.active&&!this.pending;this.nodes.driverEmergency.disabled=!this.active&&!this.pending;
      let message=this.message;
      if(!this.active&&!this.pending){
        if(!this.admin())message='驾驶画面可查看；仅登录的管理员可启用电脑操控。';
        else if(!this.context.deviceId)message='请先选择需要操控的无人船。';
        else if(!this.context.connected)message='无人船未在线；等待实时连接后才能接管。';
        else if(this.context.parameterBusy)message='调参或固件升级正在进行，请完成后再接管。';
        else if(this.remote?.supported===false)message='当前固件不支持电脑操控，请先更新船端固件及 MQTT 管理组件。';
        else if(this.remote&&!this.remote.ready)message=this.remote.message||'当前无法接管，请确认船已停稳且无其他驾驶员占用。';
      }
      this.text('driverNotice',message);this.nodes.driverNotice.dataset.tone=this.tone;
      this.renderKeys();
    }
    destroy(){if(this.destroyed)return;this.stop('驾驶界面已关闭，已请求停船');this.setMediaFocus('');this.destroyed=true;window.clearInterval(this.timer);for(const [target,event,handler]of this.handlers)target.removeEventListener(event,handler);this.handlers=[];}
  }
  window.BoatDriverControl=BoatDriverControl;
})();
