/* 浏览器只在管理员/驾驶员主动接管并收到船端确认后发送运动；不保存接管凭据。 */
(() => {
  'use strict';
  const MODES=['PWM 油门','船速闭环','航向闭环'];
  const KEYS={KeyW:'forward',ArrowUp:'forward',KeyS:'backward',ArrowDown:'backward',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right'};
  const DEVICE=/^[A-Za-z0-9_-]{1,64}$/,LEASE=/^[0-9a-f]{16}$/;
  const INPUT_PERIOD_MS=100,RESPONSE_TIMEOUT_MS=600,MAX_INPUT_REQUESTS=4;
  class BoatDriverControl {
    constructor({document=window.document,fetch=window.fetch.bind(window),auth=window.BoatAuth,toast=()=>{},onOpenSettings=()=>document.getElementById('settingsEntry')?.click()}={}) {
      this.document=document;this.fetch=fetch;this.auth=auth;this.toast=toast;
      this.nodes=Object.fromEntries(['view-driving','driverBoatName','driverLinkStatus','driverState','driverEnable','driverRelease','driverEmergency','driverTestMode','driverTestNotice','driverTestAck','driverNotice','driverActualSpeed','driverTargetSpeed','driverActualHeading','driverActualMode','driverInput','driverLatitude','driverLongitude','driverFixStatus','driverImuStatus','driverModelPreview','driverMode','driverLimit','driverLimitValue','driverHeading','driverHoldHeading','driverVideoExpand','driverMapExpand','driverOverlayOpacity','driverOverlayOpacityValue','driverFocusTools','driverDetailsPanel','driverDetailsToggle','driverDetailsClose','driverDisplayOptions','driverControlOptions','driverInstrumentToggle'].map(id=>[id,document.getElementById(id)]));
      this.hud=new window.BoatDriverHud({document});
      for(const id of ['driverDeviceSelect','driverOperator','driverConnectionToggle','driverAccount','driverLogout','driverSystemSettings','driverCommonOutput','driverMotorRpm','driverMotorVoltage','driverAttitudeAngles','driverMapLayer','driverMapFollow'])this.nodes[id]=document.getElementById(id);
      for(const id of ['driverSystemMode','driverTopFix','driverTopPower','driverUtc','driverMqttStatus','driverNetworkDelay','driverLeftRpmBar','driverRightRpmBar','driverLeftPwm','driverRightPwm','driverLeftOutput','driverRightOutput','driverVideoResolution','driverVideoDelay','driverVideoNetwork','driverTakeoverStatus','driverImmersiveToggle','driverSwapMedia','driverMapOptions'])this.nodes[id]=document.getElementById(id);
      const random=new Uint8Array(8);window.crypto.getRandomValues(random);
      this.clientId=Array.from(random,value=>value.toString(16).padStart(2,'0')).join('');
      this.context={deviceId:'',connected:false,authenticated:false,canManage:false,parameterBusy:false};
      this.keys=new Set();this.remote=null;this.leaseId='';this.sequence=0;this.active=false;this.pending=false;this.testMode=false;
      this.request=null;this.polling=false;this.generation=0;this.destroyed=false;this.lastPoll=0;this.lastPulse=performance.now();
      this.inputRequests=new Map();this.lastInputSentAt=-Infinity;this.lastInputSignature='';this.lastInputResponseAt=0;this.lastAcceptedSequence=0;
      this.message='选择在线无人船，由管理员或驾驶员启用操控后使用键盘驾驶。';this.stopReason='';this.tone='';this.actualHeading=null;
      this.lastMode=Number(this.nodes.driverMode.value);
      this.normalMode=this.lastMode;
      this.handlers=[];
      this.listen(this.nodes.driverEnable,'click',()=>this.acquire());
      this.listen(this.nodes.driverTestMode,'click',()=>this.setTestMode(!this.testMode));
      this.listen(this.nodes.driverRelease,'click',()=>this.stop('已停船并退出电脑操控'));
      this.listen(this.nodes.driverEmergency,'click',()=>this.stop('急停已触发；需要重新启用操控',true));
      this.listen(this.nodes.driverMode,'change',()=>{
        if(this.testMode){this.nodes.driverMode.value='0';return;}
        const mode=Number(this.nodes.driverMode.value);
        if(mode===2&&!Number.isFinite(this.actualHeading)){this.nodes.driverMode.value=String(this.lastMode);this.toast('等待有效的真北船头航向后才能进入航向模式');return;}
        if(mode===2)this.nodes.driverHeading.value=this.actualHeading.toFixed(2);
        this.lastMode=mode;this.keys.clear();this.renderKeys();this.headingMode();this.sendInput();this.render();
      });
      this.listen(this.nodes.driverLimit,'input',()=>{this.text('driverLimitValue',this.nodes.driverLimit.value+'%');this.sendInput();});
      // 控制台入口复用平台的选船、登录与设置流程，不建立第二条设备连接。
      this.listen(this.nodes.driverDeviceSelect,'change',()=>{
        const select=document.getElementById('cloudDevice');select.value=this.nodes.driverDeviceSelect.value;select.dispatchEvent(new Event('change'));
      });
      this.listen(this.nodes.driverConnectionToggle,'click',()=>{
        const id=!this.context.authenticated?'cloudLoginOpen':!document.getElementById('disconnectButton').disabled?'disconnectButton':'connectButton';
        document.getElementById(id)?.click();
      });
      for(const button of document.querySelectorAll('[data-driver-proxy]'))this.listen(button,'click',()=>{
        if(['settingsEntry','platformSettingsToggle','accountLoginOpen','accountLogout'].includes(button.dataset.driverProxy))this.stop('已打开账户或设置，已停船并退出操控');
        if(button.dataset.driverProxy==='settingsEntry')return onOpenSettings();
        document.getElementById(button.dataset.driverProxy)?.click();
      });
      for(const button of document.querySelectorAll('[data-driver-mode]'))this.listen(button,'click',()=>{
        if(this.nodes.driverMode.disabled)return;
        this.nodes.driverMode.value=button.dataset.driverMode;this.nodes.driverMode.dispatchEvent(new Event('change'));
      });
      this.listen(document.getElementById('driverMapCenter'),'click',()=>document.getElementById('mapCenter').click());
      this.listen(document.getElementById('driverMapFocus'),'click',()=>this.focusMedia('map'));
      this.listen(this.nodes.driverMapFollow,'click',()=>{
        const follow=document.getElementById('mapFollow');follow.checked=!follow.checked;follow.dispatchEvent(new Event('change'));this.render();
      });
      this.listen(this.nodes.driverMapLayer,'change',()=>{
        const map=window.boatMonitor?.map;if(!map)return;
        map.switchProvider(this.nodes.driverMapLayer.value).catch(error=>this.toast(error.message)).finally(()=>this.render());
      });
      let savedOpacity;
      try{const storedOpacity=window.localStorage?.getItem('boat-driver-console-hud-opacity');if(storedOpacity!==null)savedOpacity=Number(storedOpacity);}catch(_){}
      if(Number.isFinite(savedOpacity))this.nodes.driverOverlayOpacity.value=String(Math.max(0,Math.min(100,Math.round(savedOpacity/5)*5)));
      this.setOverlayOpacity(this.nodes.driverOverlayOpacity.value);
      this.listen(this.nodes.driverOverlayOpacity,'input',()=>this.setOverlayOpacity(this.nodes.driverOverlayOpacity.value));
      this.listen(this.nodes.driverDetailsToggle,'click',()=>this.setDetailsOpen(this.nodes.driverDetailsPanel.hidden));
      this.listen(this.nodes.driverDetailsClose,'click',()=>this.setDetailsOpen(false,true));
      let instrumentsVisible=false;
      try{instrumentsVisible=window.localStorage?.getItem('boat-driver-console-instruments')==='true';}catch(_){}
      this.setInstrumentsVisible(instrumentsVisible);
      this.listen(this.nodes.driverInstrumentToggle,'click',()=>this.setInstrumentsVisible(this.nodes['view-driving'].dataset.instrumentsHidden==='true'));
      // 收起非必要弹层不改接管租约；点回主画面时也不再遮挡地图和图传。
      this.listen(document,'pointerdown',event=>{
        for(const id of ['driverDisplayOptions','driverControlOptions','driverMapOptions'])if(!this.nodes[id].contains(event.target))this.nodes[id].open=false;
      });
      this.listen(this.nodes.driverHeading,'change',()=>{this.headingValue(true);this.sendInput();});
      this.listen(this.nodes.driverHoldHeading,'click',()=>{
        if(!Number.isFinite(this.actualHeading))return this.toast('等待有效的真北船头航向');
        this.nodes.driverHeading.value=this.actualHeading.toFixed(2);this.sendInput();
      });
      this.listen(this.nodes.driverVideoExpand,'click',()=>this.focusMedia('video'));
      this.listen(this.nodes.driverMapExpand,'click',()=>this.focusMedia('map'));
      // 驾驶只使用沉浸布局；返回后台沿用正常离页流程，释放手动接管。
      this.listen(this.nodes.driverImmersiveToggle,'click',()=>window.BoatWorkspace.exitDriving());
      this.listen(this.nodes.driverSwapMedia,'click',()=>this.setMediaFocus(this.nodes['view-driving'].dataset.primary==='map'?'video':'map'));
      this.listen(this.nodes.driverModelPreview,'toggle',()=>window.dispatchEvent(new CustomEvent('boat-driver-layout-change')));
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
          this.setDetailsOpen(false);
          this.nodes.driverDisplayOptions.open=this.nodes.driverControlOptions.open=false;
          this.nodes.driverMapOptions.open=false;
        }else this.setMediaFocus(this.cloudLayout?.preferredPrimary()||this.nodes['view-driving'].dataset.focus||'video');
        this.render();if(event.detail?.view==='driving'){this.lastPoll=0;this.poll();}
      });
      this.listen(window,'boat-selection-change',event=>{
        if(event.detail?.selectedId!==this.context.deviceId){this.stop('无人船已切换，已停止原船操控');this.nodes.driverMapOptions.open=false;}
      });
      if(auth)this.listen(auth,'change',()=>{if(!this.admin())this.stop('驾驶权限已失效，已停船并退出操控');this.render();});
      this.layout=new window.BoatDriverLayout({document,onEditingChange:editing=>{
        if(editing){this.keys.clear();this.stop('已进入布局编辑，已停船并退出操控');}
        else if(this.stopReason==='已进入布局编辑，已停船并退出操控'){this.stopReason='';this.message='布局已保存，点击启用操控继续驾驶。';}
        this.render();
      },onReset:()=>{this.setOverlayOpacity(100);this.setInstrumentsVisible(false);}});
      this.navigation=new window.BoatDriverNavigation(this);
      if(this.visible())this.setMediaFocus('video');
      this.timer=window.setInterval(()=>this.pulse(),100);
      this.headingMode();this.render();
      this.cloudLayout=new window.BoatDriverCloudLayout({driver:this,document,auth,fetch});
    }
    listen(target,event,handler){target.addEventListener(event,handler);this.handlers.push([target,event,handler]);}
    text(id,value){const text=String(value??'--');if(this.nodes[id].textContent!==text)this.nodes[id].textContent=text;}
    visible(){return window.BoatWorkspace?.current==='driving'&&!this.document.hidden;}
    admin(){return this.auth?.enabled===true&&this.auth?.ready===true&&['admin','driver'].includes(this.auth?.user?.role);}
    permitted(){return this.visible()&&this.admin()&&this.context.connected&&this.context.authenticated&&DEVICE.test(this.context.deviceId)&&!this.context.parameterBusy&&!this.layout?.editing&&(!this.navigation||this.navigation.mode==='manual'&&!this.navigation.editingHome&&!this.navigation.busy);}
    editing(target){return !!(target?.isContentEditable||target?.closest?.('input,select,textarea,[contenteditable="true"],dialog[open]'));}
    held(direction){return [...this.keys].some(code=>KEYS[code]===direction);}
    state(){return {deviceId:this.context.deviceId,active:this.active,pending:this.pending,testMode:this.testMode,leaseId:this.leaseId,sequence:this.sequence,keys:[...this.keys],remote:this.remote};}
    setTestMode(enabled,announce=true) {
      if(this.active||this.pending||enabled===this.testMode)return;
      if(enabled&&(!this.permitted()||!this.remote?.testSupported)){this.toast('请先连接无人船并更新支持测试场景的单片机固件');return;}
      this.keys.clear();this.testMode=enabled;
      if(enabled){this.normalMode=Number(this.nodes.driverMode.value);this.nodes.driverMode.value='0';}
      else this.nodes.driverMode.value=String(this.normalMode===2&&!Number.isFinite(this.actualHeading)?1:this.normalMode);
      this.lastMode=Number(this.nodes.driverMode.value);this.headingMode();this.renderKeys();
      if(announce){this.stopReason='';this.message=enabled?'测试场景已开启：PWM 开环会产生真实输出，点击启用操控后使用键盘。':'已关闭测试场景，恢复正常接管条件。';this.tone='';}
      this.render();
    }
    update(next={}) {
      const before=this.context;
      const merged={...before,...next};
      if(before.deviceId!==merged.deviceId){this.stop('无人船已切换，已停止原船操控');this.remote=null;this.stopReason='';this.lastPoll=0;}
      this.context=merged;
      if((this.active||this.pending)&&!this.permitted())this.stop('操控条件已变化，已停船并退出操控');
      if(!merged.connected||!merged.authenticated)this.setTestMode(false,false);
      this.render();
    }
    setTelemetry(value={}) {
      this.hud.setTelemetry(value);
      this.text('driverActualSpeed',value.actual);this.text('driverTargetSpeed',value.target);
      this.text('driverActualHeading',value.actualHeading);this.text('driverActualMode',value.modeText);
      this.text('driverLatitude',value.latitude);this.text('driverLongitude',value.longitude);
      this.text('driverFixStatus',value.fixStatus);this.text('driverImuStatus',value.imuStatus);
      this.nodes.driverFixStatus.dataset.valid=String(value.fixValid===true);
      this.nodes.driverImuStatus.dataset.valid=String(value.imuValid===true);
      this.text('driverCommonOutput',value.common);
      const motors=value.motors||[];
      this.text('driverMotorRpm',motors.map(m=>m.Rpm).concat(['--','--']).slice(0,2).join(' / '));
      this.text('driverMotorVoltage',motors.map(m=>m.Voltage).concat(['--','--']).slice(0,2).join(' / '));
      this.text('driverTopFix','RTK · '+(value.fixStatus||'--'));
      this.text('driverTopPower','供电 · '+motors.map(m=>m.Voltage).concat(['--','--']).slice(0,2).join(' / ')+' V');
      if(this.rpmDevice!==this.context.deviceId){this.rpmDevice=this.context.deviceId;this.rpmScale=1000;}
      const rpm=motors.slice(0,2).map(m=>Number(m.Rpm));
      this.rpmScale=Math.max(this.rpmScale,...rpm.filter(Number.isFinite).map(n=>Math.ceil(Math.abs(n)/1000)*1000));
      for(let i=0;i<2;i++){
        const side=i?'Right':'Left',pwm=Number(motors[i]?.Pwm),valid=motors[i]?.Pwm!==undefined&&motors[i]?.Pwm!=='--'&&Number.isFinite(pwm);
        const bar=this.nodes['driver'+side+'RpmBar'];bar.style.width=(Number.isFinite(rpm[i])?Math.min(100,Math.abs(rpm[i])/this.rpmScale*100):0)+'%';bar.parentElement.title='转速自动量程 · '+this.rpmScale+' RPM';
        this.text('driver'+side+'Pwm',valid?pwm.toFixed(1)+'%':'--');
        this.nodes['driver'+side+'Output'].style.width=(valid?Math.min(100,Math.abs(pwm)):0)+'%';
        this.nodes['driver'+side+'Output'].dataset.reverse=String(valid&&pwm<0);
      }
      this.text('driverNetworkDelay',Number.isFinite(value.networkDelayMs)?Math.round(value.networkDelayMs):'--');
      this.text('driverAttitudeAngles',value.imu?.eulerFresh?[value.imu.rollDegrees,value.imu.pitchDegrees].map(n=>Number.isFinite(n)?n.toFixed(1):'--').join(' / '):'-- / --');
      this.actualHeading=typeof value.actualHeading==='string'&&value.actualHeading.trim()!==''&&value.actualHeading!=='--'?Number(value.actualHeading):Number.isFinite(value.actualHeading)?value.actualHeading:null;
      this.renderVideoMetadata();
    }
    renderVideoMetadata(){
      const view=window.boatMonitor?.videoView,video=view?.video,ready=view?.deviceId===this.context.deviceId&&view.active&&view.playing;
      this.text('driverVideoResolution',ready&&video.videoWidth>0?video.videoWidth+' × '+video.videoHeight:'-- × --');
      const latency=ready&&view.format==='hls'?view.player?.latency:null;
      this.text('driverVideoDelay',Number.isFinite(latency)&&latency>=0?'直播落后 · '+latency.toFixed(1)+' s':'视频延迟 · --');
      this.text('driverVideoNetwork',ready?'视频已连接':view?.status||'等待视频');
      this.nodes.driverVideoNetwork.dataset.connected=String(!!ready);
    }
    setDevices(devices=[],selected='',authenticated=false) {
      const select=this.nodes.driverDeviceSelect,signature=JSON.stringify([devices.map(d=>[d.id,!!d.online]),selected,authenticated]);
      if(select.dataset.devices===signature)return;
      select.dataset.devices=signature;select.replaceChildren();
      if(!devices.length)select.add(new Option(authenticated?'等待设备上线':'请先登录云端',''));
      for(const device of devices)select.add(new Option(device.id+' · '+(device.online?'在线':'离线'),device.id));
      if(selected&&!devices.some(d=>d.id===selected))select.add(new Option(selected+' · 等待上线',selected));
      if(selected)select.value=selected;
      select.disabled=!authenticated;
    }
    async api(body,{timeout=1200,keepalive=false,controller=new AbortController()}={}) {
      const timer=window.setTimeout(()=>controller.abort(),timeout);
      try {
        const url='/api/cloud/control'+(body?'':'?deviceId='+encodeURIComponent(this.context.deviceId)+'&clientId='+this.clientId);
        const response=await this.fetch(url,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',cache:'no-store',keepalive,signal:controller.signal,
          headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        const value=await response.json().catch(()=>({}));
        if(!response.ok){if(response.status===401)this.auth?.expire?.();throw Object.assign(Error(value.error||'驾驶控制请求失败（'+response.status+'）'),{status:response.status,code:value.code});}
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
      const mode=this.testMode?0:Number(this.nodes.driverMode.value);
      return {mode,throttle:forward*amount,turn:mode===2?0:turn*amount,targetHeading:this.headingValue(),testMode:this.testMode};
    }
    payload(action,id=this.context.deviceId,leaseId=this.leaseId) {
      return {deviceId:id,clientId:this.clientId,action,leaseId,sequence:++this.sequence,...this.inputs()};
    }
    async acquire() {
      if(!this.permitted()||this.active||this.pending||!this.remote?.ready)return;
      if(this.testMode&&!this.remote?.testSupported){this.toast('当前船端不支持测试场景，请先更新固件');return;}
      if(Number(this.nodes.driverMode.value)===2){
        if(!Number.isFinite(this.actualHeading)){this.toast('等待有效的真北船头航向后才能启用航向模式');return;}
        this.nodes.driverHeading.value=this.actualHeading.toFixed(2);
      }
      this.keys.clear();this.renderKeys();this.pending=true;this.stopReason='';this.message='正在等待单片机确认接管；确认前键盘不会驱动电机';this.tone='';this.render();
      const generation=++this.generation,id=this.context.deviceId,controller=new AbortController();this.request=controller;
      try {
        const result=await this.api({deviceId:id,clientId:this.clientId,action:'acquire',...this.inputs(),throttle:0,turn:0},{timeout:3000,controller});
        const acknowledged=result.active===true&&result.owned===true&&result.state===1&&result.status==='active'&&LEASE.test(result.leaseId||'')&&!!result.testMode===this.testMode;
        if(generation!==this.generation||!this.permitted()){
          if(LEASE.test(result.leaseId||''))this.releaseDetached(id,result.leaseId);
          return;
        }
        if(!acknowledged)throw Error(result.message||'未收到单片机接管确认，操控未启用');
        this.remote=result;this.leaseId=result.leaseId;this.sequence=0;this.active=true;
        this.lastInputSentAt=-Infinity;this.lastInputSignature='';this.lastInputResponseAt=performance.now();this.lastAcceptedSequence=0;
        this.message=this.testMode?'测试场景已接管：真实 PWM 输出，按住键盘运动，松开归零。':'单片机已确认电脑接管，遥控器输入已屏蔽；按住键盘运动，松开归零。';
      } catch(error) {
        if(generation===this.generation){this.message=error.name==='AbortError'?'接管确认超时，操控未启用':error.message;this.tone='error';}
      } finally {
        if(generation===this.generation){this.pending=false;this.request=null;this.render();if(this.active)this.sendInput();}
      }
    }
    async poll() {
      if(this.destroyed||this.pending||this.polling||!this.visible()||!this.admin()||!this.context.authenticated||!DEVICE.test(this.context.deviceId))return;
      const id=this.context.deviceId,generation=this.generation;this.polling=true;this.lastPoll=performance.now();
      try {
        const value=await this.api(null,{timeout:1200});
        if(id!==this.context.deviceId||generation!==this.generation)return;
        this.remote=value;
        if(this.active&&(!value.active||!value.owned||value.status!=='active'||value.leaseId!==this.leaseId||!!value.testMode!==this.testMode))this.stop(value.message||'单片机已退出接管，已停船');
      } catch(error) {
        if(id===this.context.deviceId&&generation===this.generation){
          if(this.active)this.stop('控制状态中断，已请求停船并退出操控');
          this.remote=null;this.message=error.name==='AbortError'?'无法读取船端操控状态':error.message;this.tone='error';
        }
      } finally {this.polling=false;this.render();}
    }
    async sendInput() {
      if(!this.active||!this.permitted())return;
      const now=performance.now();
      if(now-this.lastInputResponseAt>=RESPONSE_TIMEOUT_MS)return this.stop('控制链路持续无响应，已请求停船',true);
      const signature=JSON.stringify(this.inputs()),changed=signature!==this.lastInputSignature;
      if(!changed&&now-this.lastInputSentAt<INPUT_PERIOD_MS-10)return;
      // 心跳不等待上一条 HTTP 返回，最多四条在途；松键/改模式优先发送当前输入。
      // 不排队重发旧油门，服务器递增序号使乱序到达的旧请求无法覆盖新输入。
      if(this.inputRequests.size>=MAX_INPUT_REQUESTS){
        if(!changed)return;
        const [sequence,oldest]=this.inputRequests.entries().next().value;
        oldest.superseded=true;oldest.controller.abort();this.inputRequests.delete(sequence);
      }
      const generation=this.generation,controller=new AbortController(),request={controller,superseded:false};
      const payload=this.payload('input');this.inputRequests.set(payload.sequence,request);
      this.lastInputSentAt=now;this.lastInputSignature=signature;this.renderKeys();
      try {
        const value=await this.api(payload,{timeout:RESPONSE_TIMEOUT_MS,controller});
        if(generation!==this.generation||request.superseded||payload.sequence<=this.lastAcceptedSequence)return;
        if(!value.active||!value.owned||value.state!==1||value.status!=='active'||value.leaseId!==this.leaseId||!!value.testMode!==this.testMode)return this.stop(value.message||'单片机不再处于电脑操控状态');
        this.lastAcceptedSequence=payload.sequence;this.lastInputResponseAt=performance.now();
        if((value.sequence??0)>=(this.remote?.sequence??0))this.remote=value;
      } catch(error) {
        if(generation!==this.generation||request.superseded||payload.sequence<this.lastAcceptedSequence)return;
        if(error.code==='STALE_CONTROL_SEQUENCE')return;
        // 单次丢包不撤销仍有新确认的会话；鉴权/租约等明确拒绝立即停止。
        if(error.status||performance.now()-this.lastInputResponseAt>=RESPONSE_TIMEOUT_MS)
          this.stop(error.name==='AbortError'?'控制链路持续无响应，已请求停船':error.message,true);
      } finally {if(this.inputRequests.get(payload.sequence)===request)this.inputRequests.delete(payload.sequence);this.render();}
    }
    releaseDetached(id,leaseId,emergency=false) {
      const stop=this.payload(emergency?'stop':'release',id,leaseId);stop.throttle=0;stop.turn=0;
      // keepalive用于关闭/切页时尽力发出停船；船端仍独立检查500ms心跳，不能依靠此请求保证。
      const task=this.api(stop,{timeout:600,keepalive:true}).catch(()=>{});
      if(emergency)task.finally(()=>{const release=this.payload('release',id,leaseId);release.throttle=release.turn=0;this.api(release,{timeout:600,keepalive:true}).catch(()=>{});});
    }
    stop(message='已停船并退出电脑操控',emergency=false) {
      const wasActive=this.active||this.pending,id=this.context.deviceId,leaseId=this.leaseId;
      if(!wasActive&&!leaseId){this.setTestMode(false,false);return;}
      ++this.generation;this.request?.abort();this.request=null;this.active=false;this.pending=false;this.leaseId='';
      for(const request of this.inputRequests.values())request.controller.abort();this.inputRequests.clear();
      this.keys.clear();this.message=this.stopReason=message;this.tone=emergency?'error':'';this.renderKeys();
      if(LEASE.test(leaseId))this.releaseDetached(id,leaseId,emergency);
      this.setTestMode(false,false);
      this.lastPoll=0;this.render();
    }
    keyDown(event) {
      // 原生弹窗先处理自己的 Esc，避免关闭设置时同时离开驾驶。
      if(event.defaultPrevented)return;
      if(event.code==='Escape'&&this.document.querySelector('dialog[open]'))return;
      if(event.code==='Escape'&&this.layout?.editing){event.preventDefault();this.layout.setEditing(false);return;}
      if(event.code==='Escape'&&this.visible()){
        if(!this.nodes.driverDetailsPanel.hidden){event.preventDefault();this.setDetailsOpen(false,true);return;}
        for(const id of ['driverDisplayOptions','driverControlOptions','driverMapOptions'])if(this.nodes[id].open){event.preventDefault();this.nodes[id].open=false;this.nodes[id].querySelector('summary').focus({preventScroll:true});return;}
      }
      if(event.code==='Escape'&&this.visible()){event.preventDefault();window.BoatWorkspace.exitDriving();return;}
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
        if(now-this.lastInputResponseAt>=RESPONSE_TIMEOUT_MS)return this.stop('控制链路持续无响应，已请求停船',true);
        if(Number(this.nodes.driverMode.value)===2){
          const sign=Number(this.held('right'))-Number(this.held('left'));
          if(sign){const heading=((this.headingValue()/100+sign*30*delta)%360+360)%360;this.nodes.driverHeading.value=heading.toFixed(2);}
        }
        this.sendInput();
      }
      // 输入响应已经携带驾驶状态，操控中不再额外 GET 抢占连接或误用旧状态。
      if(!this.active&&this.visible()&&now-this.lastPoll>2000)this.poll();
    }
    renderKeys() {
      for(const node of this.document.querySelectorAll('[data-driver-key]'))node.dataset.pressed=String(this.held(KEYS[node.dataset.driverKey]));
      const input=this.inputs();this.text('driverInput',(this.active?input.throttle/10:0)+'% / '+(this.active?input.turn/10:0)+'%');
    }
    headingMode() {
      const enabled=Number(this.nodes.driverMode.value)===2;
      this.nodes.driverHeading.disabled=!enabled;this.nodes.driverHoldHeading.disabled=!enabled;
      this.nodes.driverHeading.closest('label').dataset.disabled=String(!enabled);
      this.nodes['view-driving'].dataset.mode=this.nodes.driverMode.value;
    }
    focusMedia(name) {
      this.setMediaFocus(name);
    }
    setMediaFocus(name) {
      const panel=this.nodes['view-driving'];
      if(name)panel.dataset.focus=name;else delete panel.dataset.focus;
      panel.scrollTop=0;
      // 地图和图传交换主画面，另一画面始终保留为小窗。
      panel.dataset.primary=name||'video';
      if(name)this.document.documentElement.dataset.driverFocus='true';else delete this.document.documentElement.dataset.driverFocus;
      for(const [type,id]of [['video','driverVideoExpand'],['map','driverMapExpand']]){
        const active=panel.dataset.focus===type;this.nodes[id].setAttribute('aria-pressed',String(active));
        const label=active?(type==='video'?'图传已为主画面':'地图已为主画面'):type==='video'?'切换为图传主画面':'切换为地图主画面';
        this.nodes[id].title=label;this.nodes[id].setAttribute('aria-label',label);
      }
      this.nodes.driverFocusTools.hidden=false;
      this.nodes.driverImmersiveToggle.querySelector('span').textContent='返回后台 · Esc';
      this.nodes.driverImmersiveToggle.title='返回进入驾驶前的页面，也可按 Esc';
      this.nodes.driverSwapMedia.hidden=!name;
      this.nodes.driverSwapMedia.querySelector('span').textContent=name==='map'?'图传主画面':'地图主画面';
      this.nodes.driverMapOptions.open=false;
      this.updateOverlayInteraction();
      this.layout?.refresh();
      window.dispatchEvent(new CustomEvent('boat-driver-layout-change'));
    }
    setOverlayOpacity(value,{persist=true,cloud=false}={}) {
      if(this.layout?.cloudLocked&&!cloud)return;
      const opacity=Math.max(0,Math.min(100,Number(value)||0));
      this.nodes.driverOverlayOpacity.value=String(opacity);
      this.nodes['view-driving'].style.setProperty('--driver-overlay-opacity',(opacity/100).toFixed(2));
      this.nodes['view-driving'].dataset.overlayHidden=String(opacity===0);
      this.updateOverlayInteraction();
      this.layout?.refresh();
      this.text('driverOverlayOpacityValue',opacity+'%');
      if(persist)try{window.localStorage?.setItem('boat-driver-console-hud-opacity',String(opacity));}catch(_){}
    }
    setDetailsOpen(open,restoreFocus=false) {
      this.nodes.driverDetailsPanel.hidden=!open;
      this.nodes.driverDetailsToggle.setAttribute('aria-expanded',String(open));
      if(!open&&this.nodes.driverDetailsPanel.contains(this.nodes.driverModelPreview))this.nodes.driverModelPreview.open=false;
      if(restoreFocus)this.nodes.driverDetailsToggle.focus({preventScroll:true});
      this.layout?.refresh();
      window.dispatchEvent(new CustomEvent('boat-driver-layout-change'));
    }
    setInstrumentsVisible(visible,{persist=true,cloud=false}={}) {
      if(this.layout?.cloudLocked&&!cloud)return;
      this.nodes['view-driving'].dataset.instrumentsHidden=String(!visible);
      this.document.querySelector('.driver-instrument-grid').hidden=!visible;
      this.nodes.driverInstrumentToggle.setAttribute('aria-pressed',String(visible));
      this.text('driverInstrumentToggle',visible?'仪表：显示':'仪表：隐藏');
      if(persist)try{window.localStorage?.setItem('boat-driver-console-instruments',String(visible));}catch(_){}
      this.layout?.refresh();
      window.dispatchEvent(new CustomEvent('boat-driver-layout-change'));
    }
    updateOverlayInteraction() {
      const panel=this.nodes['view-driving'];
      // 0% 时 HUD 不进入 Tab 顺序；主动展开的详情和驾驶提示仍可使用。
      const hidden=panel.dataset.overlayHidden==='true';
      for(const node of panel.querySelectorAll('[data-driver-overlay]'))node.inert=hidden;
    }
    render() {
      if(this.destroyed)return;
      this.text('driverBoatName',this.context.deviceId||'未选择无人船');
      this.nodes.driverLinkStatus.dataset.connected=String(this.context.connected);
      this.text('driverLinkStatus',this.context.connected?'实时遥测已连接':'等待实时连接');
      this.text('driverMqttStatus',this.context.connected?'MQTT · 已连接':'MQTT · 未连接');
      this.text('driverSystemMode',this.active?(this.testMode?'手动驾驶 · 测试场景':'手动驾驶 · 已接管'):this.pending?'手动驾驶 · 等待确认':'监测待机');
      const utc=new Date();this.text('driverUtc','UTC '+utc.toISOString().slice(11,19));this.nodes.driverUtc.dateTime=utc.toISOString();
      this.text('driverOperator',this.auth?.user?this.auth.user.username+' · '+({admin:'管理员',driver:'驾驶员',guest:'访客'}[this.auth.user.role]):'未登录');
      this.nodes.driverAccount.title=this.auth?.user?'切换登录账户':'登录平台';
      this.nodes.driverLogout.hidden=!this.auth?.user;
      this.nodes.driverSystemSettings.hidden=this.auth?.user?.role!=='admin';
      const canDisconnect=!this.document.getElementById('disconnectButton').disabled;
      const connectionLabel=canDisconnect?'断开无人船':'连接无人船';
      this.nodes.driverConnectionToggle.title=connectionLabel;this.nodes.driverConnectionToggle.setAttribute('aria-label',connectionLabel);
      this.nodes.driverConnectionToggle.disabled=this.context.authenticated&&this.document.getElementById(canDisconnect?'disconnectButton':'connectButton').disabled;
      this.nodes['view-driving'].dataset.controlActive=String(this.active||this.pending);
      for(const button of this.document.querySelectorAll('[data-driver-mode]')){
        button.setAttribute('aria-pressed',String(button.dataset.driverMode===this.nodes.driverMode.value));button.disabled=this.testMode;
      }
      this.nodes.driverMapFollow.setAttribute('aria-pressed',String(this.document.getElementById('mapFollow').checked));
      const map=window.boatMonitor?.map;
      if(map){
        this.nodes.driverMapLayer.disabled=map.switching;
        if(this.nodes.driverMapLayer.value!==map.provider)this.nodes.driverMapLayer.value=map.provider;
        this.nodes.driverMapLayer.querySelector('[value="amap"]').disabled=map.config?.configured!==true;
        this.nodes.driverMapLayer.querySelector('[value="tianditu"]').disabled=map.config?.tianditu?.configured!==true;
      }
      const state=this.active?(this.testMode?'test':'active'):this.pending?'pending':'idle';this.nodes.driverState.dataset.state=state;
      this.text('driverState',this.active?(this.testMode?'测试场景 · 已接管':'电脑已接管'):this.pending?'等待船端确认':this.remote?.state===2?'停船保护':'监测待机');
      this.text('driverTakeoverStatus',this.active?(this.testMode?'测试接管':'电脑已接管'):this.pending?'等待船端确认':this.remote?.state===2?'停船保护':'未接管');
      this.nodes.driverTakeoverStatus.dataset.state=state;
      this.nodes.driverEnable.disabled=!this.permitted()||this.active||this.pending||!this.remote?.ready||(this.testMode&&!this.remote?.testSupported)||(Number(this.nodes.driverMode.value)===2&&!Number.isFinite(this.actualHeading));
      this.nodes.driverTestMode.hidden=!this.admin();
      this.nodes.driverTestMode.disabled=this.active||this.pending||!this.permitted()||(!this.testMode&&!this.remote?.testSupported);
      this.nodes.driverTestMode.setAttribute('aria-pressed',String(this.testMode));
      this.nodes.driverTestMode.title=this.remote?.testSupported?'真实 PWM 开环，跳过电调反馈和停稳检查；先停止操控才能切换':'需要更新支持测试场景的单片机固件';
      this.text('driverTestMode',this.testMode?'测试场景：开 · PWM':'测试场景：关');
      this.nodes.driverMode.disabled=this.testMode;
      this.nodes.driverTestNotice.hidden=!this.testMode;
      this.text('driverTestAck',this.active?'船端确认序号：'+(this.remote?.sequence??0):'尚未接管');
      this.text('driverEnable',this.pending?'等待确认…':this.active?'操控已启用':'启用操控');
      this.nodes.driverEnable.hidden=!this.admin();
      this.nodes.driverRelease.disabled=!this.active&&!this.pending;this.nodes.driverEmergency.disabled=!this.active&&!this.pending;
      let message=this.message;
      if(!this.active&&!this.pending){
        if(this.layout?.editing)message='布局编辑中；完成后重新启用操控。';
        else if(!this.admin())message='仅登录的管理员或驾驶员可启用电脑操控。';
        else if(!this.context.deviceId)message='请先选择需要操控的无人船。';
        else if(!this.context.connected)message='无人船未在线；等待实时连接后才能接管。';
        else if(this.context.parameterBusy)message='调参或固件升级正在进行，请完成后再接管。';
        else if(this.stopReason)message=this.stopReason;
        // 未收到实时能力也可能是 MQTT 权限或状态过期，不能据此断言固件不支持。
        else if(this.remote?.supported===false)message=this.remote.message||'尚未收到船端驾驶状态，请检查固件及 MQTT 驾驶主题权限。';
        else if(this.remote&&!this.remote.ready)message=this.remote.message||'当前无法接管，请确认船已停稳且无其他驾驶员占用。';
        else if(this.testMode)message=this.remote?.testSupported?'测试场景：跳过电调反馈和停稳检查，使用真实 PWM 开环；点击启用操控开始测试。':'当前船端未声明测试场景能力，请先更新单片机固件。';
      }
      this.text('driverNotice',message);this.nodes.driverNotice.dataset.tone=this.tone;
      this.renderKeys();
      this.navigation?.render();
    }
    destroy(){if(this.destroyed)return;this.stop('驾驶界面已关闭，已请求停船');this.setMediaFocus('');this.cloudLayout?.destroy();this.navigation?.destroy();this.layout?.destroy();this.destroyed=true;window.clearInterval(this.timer);for(const [target,event,handler]of this.handlers)target.removeEventListener(event,handler);this.handlers=[];}
  }
  window.BoatDriverControl=BoatDriverControl;
})();
