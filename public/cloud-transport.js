/* 云端遥测与管理员参数事务；参数成功必须收到 STM32 的原协议响应。 */
(() => {
  'use strict';
  const {UART4StreamParser,decodeParameterFrame}=BoatModules.uart4Protocol;
  // 缺少校时元数据时保留未知，不能把字符串、负数或异常大值显示成有效延迟。
  const validDelay=value=>Number.isFinite(value)&&value>=0&&value<=60000?value:null;
  class CloudBoatLink extends EventTarget {
    constructor() {
      super();this.parser=new UART4StreamParser();this.generation=0;this.devices=[];this.videoConfig={allowedOrigins:[]};
      this.enabled=false;this.configurationKnown=false;this.requiresLogin=true;this.authenticated=false;this.brokerConnected=false;
      this.pending=null;this.lastReadOnly=true;this.parameterCapableId='';
      this.selectedId='';this.wanted=false;this.live=false;this.serverOffset=0;this.clockKnown=false;
      this.lastPayloadAt=null;this.message='尚未连接云端';
      this.accountGeneration=window.BoatAuth?.generation;
      window.BoatAuth?.addEventListener('change',()=>{
        const auth=window.BoatAuth;
        if(this.accountGeneration===auth.generation)return;
        this.accountGeneration=auth.generation;
        // 选择与调参能力属于当前登录会话；先清理，再通知断开，以便新账户重新自动选船。
        this.selectedId='';this.parameterCapableId='';
        this.disconnect('账户已变化，请重新连接云端');this.devices=[];
        if(auth.enabled===true){
          this.authenticated=auth.canMonitor;
          this.message=auth.canMonitor?'账户已登录，请选择无人船':'请先登录监测平台';
          this.notify();
          if(auth.canMonitor&&this.enabled)this.refreshDevices().catch(()=>{});
        }
      });
    }
    emit(name,detail){this.dispatchEvent(new CustomEvent(name,{detail}));}
    get source(){return 'cloud';}
    get connected(){return this.live;}
    get parametersReady(){
      const device=this.devices.find(device=>device.id===this.selectedId);
      return this.configurationKnown&&this.enabled&&this.authenticated&&this.brokerConnected&&device?.online===true&&device.parametersReady===true;
    }
    get readOnly(){return !(window.BoatAuth?.enabled===true&&window.BoatAuth.canManage&&this.parametersReady);}
    get busy(){return !!this.connecting||!!this.pending;}
    get parameterReadOnlyReason(){
      if(window.BoatAuth?.enabled!==true)return '此云端当前仅支持只读监测；调参需要启用管理员账户和新版固件';
      if(!window.BoatAuth.canManage)return '访客账户仅可监测，云端调参需要管理员权限';
      if(!this.configurationKnown||!this.enabled)return '服务器云端配置尚未确认，暂不能操作参数';
      if(this.pending)return '正在等待当前参数操作的设备确认，请稍候';
      if(!this.parametersReady&&this.parameterCapableId===this.selectedId)return '当前设备调参暂未就绪，请稍候后读取；若持续不可用，请检查设备连接';
      if(!this.parametersReady)return '当前无人船尚未就绪或不支持云端调参，请检查在线状态并更新固件';
      return '';
    }
    uncertain(kind,message){
      return Object.assign(Error(message+(kind==='algorithm'?'；切换可能已生效，请等待船端算法状态刷新，确认后再试。':kind==='read'?'；请确认连接后重新读取参数。':'；写入可能已生效，请先读取确认后再重试。')),{uncertain:true});
    }
    finishParameter(pending,error,frame){
      if(this.pending!==pending)return;
      clearTimeout(pending.timer);this.pending=null;
      if(error){pending.abort?.abort();pending.reject(error);}else pending.resolve(frame);
      this.notify();
    }
    cancelParameters(message='云端参数连接已断开'){
      if(this.pending)this.finishParameter(this.pending,this.uncertain(this.pending.kind,message));
    }
    async request(kind,values){
      if(!['read','write','flash','algorithm'].includes(kind))throw Error('不支持的参数命令');
      if(this.pending)throw Error('请等待当前云端参数操作完成');
      if(this.readOnly)throw Error(this.parameterReadOnlyReason);
      if(!this.connected||!this.wanted)throw Error('请先连接云端无人船并等待实时数据');
      const generation=this.generation,deviceId=this.selectedId,accountGeneration=window.BoatAuth.generation;
      return new Promise((resolve,reject)=>{
        const pending={kind,generation,deviceId,accountGeneration,resolve,reject,
          abort:typeof AbortController==='function'?new AbortController():null};
        this.pending=pending;
        pending.timer=setTimeout(()=>this.finishParameter(pending,this.uncertain(kind,'云端参数响应超时，尚未收到设备确认')),kind==='flash'?22000:7000);
        this.notify();
        const current=()=>{
          if(this.pending!==pending||this.generation!==generation||this.selectedId!==deviceId||
            window.BoatAuth?.generation!==accountGeneration||!window.BoatAuth?.canManage||
            (!pending.sent&&this.readOnly)||!this.enabled||!this.configurationKnown||!this.brokerConnected||!this.connected||!this.wanted){
            throw this.uncertain(kind,'连接、设备或账户已变化，已丢弃迟到的参数结果');
          }
        };
        (async()=>{
          await window.BoatAuth.verifyManage();current();
          // 点击时刷新能力，不使用过期的在线/固件能力缓存发送命令。
          await this.refreshDevices();current();
          const body={deviceId,kind,...(kind==='read'?{}:{values})};
          pending.sent=true;
          const result=await this.api('parameters',{method:'POST',body:JSON.stringify(body),...(pending.abort?{signal:pending.abort.signal}:{})});
          current();
          if(typeof result.frame!=='string'||result.frame.length!==76||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.frame))throw Error('参数响应格式错误，尚未收到有效设备确认');
          const raw=atob(result.frame),bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));
          const frame=kind==='algorithm'?BoatModules.controlAlgorithm.response(bytes):decodeParameterFrame(bytes);
          if(!frame)throw Error('参数响应校验失败，尚未收到有效设备确认');
          if(kind==='algorithm'){
            const device=this.devices.find(device=>device.id===deviceId);
            if(device?.controlAlgorithm)device.controlAlgorithm={...device.controlAlgorithm,id:frame.algorithm};
          }
          return frame;
        })().then(frame=>this.finishParameter(pending,null,frame)).catch(error=>{
          if(error.status===401){this.authenticated=false;window.BoatAuth?.expire();}
          const uncertain=[400,401,403,409].includes(error.status)?error:this.uncertain(kind,error.message||'云端参数请求中断');
          this.finishParameter(pending,uncertain);
        });
      });
    }
    state(){return {enabled:this.enabled,requiresLogin:this.requiresLogin,authenticated:this.authenticated,
      brokerConnected:this.brokerConnected,devices:this.devices,selectedId:this.selectedId,streaming:this.wanted,
      parametersReady:this.parametersReady,readOnly:this.readOnly,parameterBusy:!!this.pending,videoConfig:this.videoConfig,message:this.message};}
    notify(){
      const readOnly=this.readOnly;
      if(this.lastReadOnly!==readOnly){
        this.lastReadOnly=readOnly;
        // 单次令牌发送即消费，等待响应时 parametersReady=false 属于正常状态。
        this.emit('permissionchange',{readOnly,capabilityOnly:true});
      }
      this.emit('cloudstate',this.state());
    }
    async api(path,options={}) {
      const started=Date.now();
      const response=await fetch('/api/cloud/'+path,{credentials:'same-origin',cache:'no-store',...options,
        headers:{'Content-Type':'application/json',...options.headers}});
      const result=await response.json().catch(()=>({}));
      if(Number.isFinite(result.serverTime)){this.serverOffset=result.serverTime-(started+Date.now())/2;this.clockKnown=true;}
      if(!response.ok){
        const error=Error(response.status===401?'云端访问会话已过期，请重新登录':result.error||'云端请求失败（'+response.status+'）');
        error.status=response.status;throw error;
      }
      return result;
    }
    async initialize() {
      if(window.BoatAuth)await window.BoatAuth.whenReady();
      this.configurationKnown=false;
      const config=await this.api('config');this.configurationKnown=typeof config.enabled==='boolean';this.enabled=this.configurationKnown&&config.enabled;this.requiresLogin=!!config.requiresLogin;
      this.videoConfig={allowedOrigins:Array.isArray(config.video?.allowedOrigins)?config.video.allowedOrigins.filter(origin=>typeof origin==='string'):[]};
      if(!this.enabled){this.message='服务器尚未启用 MQTT 云端监测';this.notify();return;}
      if(window.BoatAuth?.enabled!==false&&window.BoatAuth&&!window.BoatAuth.canMonitor){this.authenticated=false;this.message='请先登录监测平台';this.notify();return;}
      try{await this.refreshDevices();}catch(error){if(error.status!==401)throw error;}
      this.notify();
    }
    async login(password) {
      if(window.BoatAuth?.enabled!==false&&window.BoatAuth){window.BoatAuth.openLogin?.();throw Error('请使用统一账户登录监测平台');}
      await this.api('login',{method:'POST',body:JSON.stringify({password})});
      this.authenticated=true;await this.refreshDevices();
    }
    async logout() {
      if(window.BoatAuth?.enabled===true)return window.BoatAuth.logout();
      this.disconnect('已退出云端会话');
      await this.api('session',{method:'DELETE'});this.authenticated=false;this.devices=[];this.notify();
    }
    async refreshDevices() {
      try {
        window.BoatAuth?.assertMonitor();
        const accountGeneration=window.BoatAuth?.generation;
        const result=await this.api('devices');
        if(window.BoatAuth&&(accountGeneration!==window.BoatAuth.generation||!window.BoatAuth.canMonitor))throw Error('账户已变化，已丢弃旧会话设备列表');
        this.authenticated=true;this.brokerConnected=!!result.brokerConnected;
        this.devices=Array.isArray(result.devices)?result.devices:[];
        if(this.devices.some(device=>device.id===this.selectedId&&device.parametersReady===true))this.parameterCapableId=this.selectedId;
        if(!this.brokerConnected)this.invalidate('服务器与 MQTT Broker 的连接已断开');
        else if(!this.wanted)this.message=this.devices.length?'请选择无人船并连接':'Broker 已连接，等待单片机上线';
        this.notify();return result;
      } catch(error) {
        if(error.status===401){this.authenticated=false;this.disconnect('请登录云端监测');window.BoatAuth?.expire();this.emit('authrequired',{});}
        throw error;
      }
    }
    async connect(id=this.selectedId) {
      window.BoatAuth?.assertMonitor();
      if(!this.enabled)throw Error('服务器尚未启用 MQTT 云端监测');
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(id||''))throw Error('请先选择有效的云端无人船');
      this.disconnect('正在连接云端…');this.selectedId=id;this.wanted=true;
      this.parser=new UART4StreamParser();this.connecting=true;this.message='正在连接云端，等待实时遥测';
      const token=this.generation;this.notify();
      try {
        await this.refreshDevices();if(token!==this.generation||!this.wanted)return;
        this.openStream(token);
      } catch(error){if(token===this.generation)this.disconnect(error.message);throw error;}
      finally{if(token===this.generation)this.connecting=false;}
    }
    openStream(token) {
      if(token!==this.generation||!this.wanted||document.hidden)return;
      const stream=this.stream=new EventSource('/api/cloud/events?device='+encodeURIComponent(this.selectedId),{withCredentials:true});
      const current=()=>token===this.generation&&this.stream===stream&&this.wanted&&!document.hidden;
      stream.addEventListener('open',()=>{if(current()){this.message='云端通道已建立，等待单片机实时遥测';this.notify();}});
      stream.addEventListener('state',event=>{
        if(!current())return;
        try {
          const state=JSON.parse(event.data);this.brokerConnected=!!state.brokerConnected;
          if(state.device?.id===this.selectedId){
            if(state.device.parametersReady===true)this.parameterCapableId=this.selectedId;
            const i=this.devices.findIndex(d=>d.id===this.selectedId);
            if(i<0)this.devices.push(state.device);else this.devices[i]=state.device;
          }
          if(!this.brokerConnected)this.invalidate('服务器与 MQTT Broker 的连接已断开');
          else if(state.device?.online===false)this.invalidate('单片机已离线，等待重新上线');
          this.notify();
        }catch(_){/* 无效状态不改变已确认的遥测。 */}
      });
      stream.addEventListener('telemetry',event=>{
        if(!current()||!this.brokerConnected)return;
        try {
          const packet=JSON.parse(event.data);if(packet.deviceId!==this.selectedId)return;
          const now=performance.now();
          const wallAge=this.clockKnown&&Number.isFinite(packet.receivedAt)?Date.now()+this.serverOffset-packet.receivedAt:0;
          const age=Math.max(0,Number(packet.ageMs)||0,wallAge);
          if(age>=1000||typeof packet.payload!=='string'||packet.payload.length>4096)return;
          const raw=atob(packet.payload),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
          if(bytes.length!==176)return;
          const frames=this.parser.push(bytes).filter(frame=>!frame.parameters);
          if(!frames.length)return;
          this.lastPayloadAt=now-age;this.message=this.readOnly?'云端实时遥测 · 只读监测':'云端实时遥测 · 管理员可远程调参';
          if(!this.live){this.live=true;this.emit('connection',{connected:true,id:'cloud:'+this.selectedId,name:this.selectedId,readOnly:this.readOnly,source:'cloud'});}
          for(const frame of frames){
            frame.receivedAtMonotonic=now-age;
            // 只估计服务器至浏览器的转发耗时，不能当作船端全链路延迟或 RTT。
            frame.cloudForwardDelayMs=this.clockKnown&&Number.isFinite(packet.receivedAt)?Math.max(0,wallAge):null;
            // 上行耗时由后台通过船端时钟校准估计；老固件/校时失效逐包回到未知。
            frame.cloudUplinkDelayMs=validDelay(packet.uplinkDelayMs);
            frame.cloudUplinkRttMs=validDelay(packet.uplinkRttMs);
            frame.cloudUplinkUncertaintyMs=validDelay(packet.uplinkUncertaintyMs);
            this.emit('frame',frame);
          }
          this.notify();
        }catch(_){/* Base64 / JSON / 协议错误均不续期已有数据。 */}
      });
      stream.addEventListener('error',()=>{
        if(!current())return;
        this.invalidate('云端通道中断，正在重连…');this.notify();
        // EventSource 无法直接读取 HTTP 401，使用同源接口确认会话状态。
        this.refreshDevices().catch(()=>{});
      });
      this.watchdog=setInterval(()=>{
        if(current()&&this.live&&performance.now()-this.lastPayloadAt>=1000){this.invalidate('单片机遥测已超时，等待新数据');this.notify();}
      },250);
    }
    invalidate(message) {
      this.message=message;
      this.cancelParameters(message);
      if(this.live){this.live=false;this.emit('connection',{connected:false,message,source:'cloud',readOnly:this.readOnly});}
    }
    closeStream(){this.stream?.close();this.stream=null;clearInterval(this.watchdog);this.watchdog=null;}
    disconnect(message='已断开云端监测') {
      this.cancelParameters(message);
      ++this.generation;this.wanted=false;this.connecting=false;this.closeStream();this.lastPayloadAt=null;
      this.live=false;this.message=message;this.emit('connection',{connected:false,message,source:'cloud',readOnly:this.readOnly});this.notify();
    }
    suspend() {
      if(!this.wanted)return;
      ++this.generation;this.connecting=false;this.closeStream();this.invalidate('页面已暂停，返回后重新接收实时数据');this.notify();
    }
    resume() {
      if(!this.wanted||document.hidden||this.stream)return;
      // 建立全新 SSE，不接收后台积压数据，也不重播缓存。
      this.parser=new UART4StreamParser();this.lastPayloadAt=null;this.openStream(this.generation);
    }
  }
  window.CloudBoatLink=CloudBoatLink;
})();
