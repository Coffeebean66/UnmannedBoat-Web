/* 船队总览使用一条独立 SSE，切换单船详情不影响其他船的实时摘要。 */
(() => {
  'use strict';
  const DEVICE_ID=/^[A-Za-z0-9_-]{1,64}$/;
  class BoatFleetLink extends EventTarget {
    constructor(cloud) {
      super();this.cloud=cloud;this.generation=0;this.devices=new Map();this.streamConnected=false;
      this.brokerConnected=false;this.message='请先登录平台';this.accountGeneration=window.BoatAuth?.generation;
      this.lastServerTime=0;this.destroyed=false;this.refreshing=null;
      this.onCloud=()=>this.reconcile();
      this.onVisibility=()=>this.reconcile();
      cloud.addEventListener('cloudstate',this.onCloud);
      document.addEventListener('visibilitychange',this.onVisibility);
    }
    state() {
      return {enabled:this.cloud.enabled,authenticated:this.cloud.authenticated,
        brokerConnected:this.brokerConnected,streamConnected:this.streamConnected,
        devices:[...this.devices.values()],selectedId:this.cloud.selectedId,
        serverOffset:this.cloud.serverOffset||0,message:this.message};
    }
    notify(){this.dispatchEvent(new CustomEvent('fleetstate',{detail:this.state()}));}
    current(token){return !this.destroyed&&token===this.generation&&this.cloud.enabled&&this.cloud.authenticated&&!document.hidden;}
    reconcile() {
      if(this.destroyed)return;
      const accountGeneration=window.BoatAuth?.generation;
      if(accountGeneration!==this.accountGeneration){this.accountGeneration=accountGeneration;this.stop(true);}
      if(!this.cloud.enabled||!this.cloud.authenticated||document.hidden){
        this.stop(!this.cloud.authenticated);
        this.message=!this.cloud.enabled?'服务器尚未启用 MQTT 云端监测':!this.cloud.authenticated?'请先登录平台':'页面已暂停，返回后接收实时船况';
        this.notify();return;
      }
      if(!this.stream)this.start();
    }
    cleanDevice(device,serverTime) {
      if(!device||!DEVICE_ID.test(device.id||''))return null;
      const result={id:device.id,online:this.brokerConnected&&device.online===true,
        lastReceivedAt:Number.isFinite(device.lastReceivedAt)?device.lastReceivedAt:null,
        parametersReady:device.parametersReady===true,summary:null,
        // 视频地址独立于遥测时效；视频更新不能续期船速、定位或设备在线状态。
        video:device.video&&typeof device.video==='object'&&!Array.isArray(device.video)?{...device.video}:null};
      const source=device.summary;
      if(!result.online||!source||!Number.isFinite(source.receivedAt)||serverTime-source.receivedAt>=1000)return result;
      const summary={receivedAt:source.receivedAt,validUntil:{}};
      for(const key of ['speedMps','targetSpeedMps','headingDegrees','latitude','longitude','voltageV','controlMode']) {
        const validityKey=['latitude','longitude'].includes(key)?'position':key;
        const until=source.validUntil?.[validityKey];
        summary.validUntil[validityKey]=Number.isFinite(until)?Math.min(until,source.receivedAt+1000):0;
        const value=source[key];
        summary[key]=Number.isFinite(value)&&summary.validUntil[validityKey]>serverTime?value:null;
      }
      if(summary.latitude===null||summary.longitude===null||Math.abs(summary.latitude)>90||Math.abs(summary.longitude)>180)summary.latitude=summary.longitude=null;
      if(summary.speedMps!==null&&summary.speedMps<0)summary.speedMps=null;
      if(summary.headingDegrees!==null&&(summary.headingDegrees<0||summary.headingDegrees>=360))summary.headingDegrees=null;
      if(summary.voltageV!==null&&summary.voltageV<0)summary.voltageV=null;
      result.summary=summary;return result;
    }
    accept(value,replace) {
      if(!value||typeof value.brokerConnected!=='boolean'||!Number.isFinite(value.serverTime)||value.serverTime<this.lastServerTime)return;
      if(replace&&(!Array.isArray(value.devices)||value.devices.length>64))return;
      if(!replace&&(!value.device||!DEVICE_ID.test(value.device.id||'')))return;
      this.lastServerTime=value.serverTime;this.brokerConnected=value.brokerConnected;
      if(replace){
        const next=new Map();
        for(const device of value.devices){const item=this.cleanDevice(device,value.serverTime);if(item)next.set(item.id,item);}
        this.devices=next;
      } else {
        const item=this.cleanDevice(value.device,value.serverTime);
        if(item&&(this.devices.has(item.id)||this.devices.size<64))this.devices.set(item.id,item);
      }
      if(!this.brokerConnected)this.invalidateDevices();
      this.message=this.brokerConnected?'正在接收全部无人船的实时状态':'服务器与 MQTT Broker 的连接已断开';
      this.notify();
    }
    invalidateDevices(){for(const [id,device]of this.devices)this.devices.set(id,{...device,online:false,parametersReady:false,summary:null});}
    start() {
      const token=++this.generation;
      this.lastServerTime=0;this.message='正在连接船队监测通道';this.notify();
      const stream=this.stream=new EventSource('/api/cloud/fleet/events',{withCredentials:true});
      const current=()=>this.current(token)&&this.stream===stream;
      stream.addEventListener('open',()=>{if(current()){this.streamConnected=true;this.message='船队通道已连接，等待实时船况';this.notify();}});
      for(const [event,replace]of [['fleet',true],['fleet-device',false]])stream.addEventListener(event,message=>{
        if(!current())return;
        try{this.accept(JSON.parse(message.data),replace);}catch(_){/* 无效摘要不能替代已确认的数据。 */}
      });
      stream.addEventListener('error',()=>{
        if(!current())return;
        this.streamConnected=false;this.invalidateDevices();this.message='船队通道中断，正在重连';this.notify();
        // EventSource 无法读取 HTTP 状态，用同源快照确认登录；保持浏览器自带的重连节奏。
        this.refresh().catch(()=>{});
      });
      this.refresh().catch(()=>{});
    }
    async refresh() {
      if(this.refreshing)return this.refreshing;
      if(!this.current(this.generation))return;
      const token=this.generation,controller=new AbortController();this.refreshController=controller;
      const timer=setTimeout(()=>controller.abort(),6000);
      const pending=(async()=>{
        try{
          const value=await this.cloud.api('fleet',{signal:controller.signal});
          if(this.current(token))this.accept(value,true);
        }catch(error){
          if(this.current(token)){
            if(error.status===401){
              this.cloud.authenticated=false;this.cloud.disconnect('登录会话已过期，请重新登录');
              window.BoatAuth?.expire();this.stop(true);this.message='请重新登录平台';
            }else this.message=error.status===404?'服务器尚不支持船队总览，请更新网页后台':'无法读取船队状态，等待通道恢复';
            this.notify();
          }
          throw error;
        }finally{clearTimeout(timer);if(this.refreshController===controller){this.refreshing=null;this.refreshController=null;}}
      })();
      this.refreshing=pending;return pending;
    }
    stop(clear=false) {
      ++this.generation;this.stream?.close();this.stream=null;this.streamConnected=false;
      this.refreshController?.abort();this.refreshController=null;this.refreshing=null;
      this.lastServerTime=0;this.brokerConnected=false;
      if(clear)this.devices.clear();else this.invalidateDevices();
    }
    destroy(){if(this.destroyed)return;this.stop(true);this.destroyed=true;this.cloud.removeEventListener('cloudstate',this.onCloud);document.removeEventListener('visibilitychange',this.onVisibility);}
  }
  window.BoatFleetLink=BoatFleetLink;
})();
