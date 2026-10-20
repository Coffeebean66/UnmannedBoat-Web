/* 每次连接独立拥有通知监听和参数事务，旧连接不能覆盖新会话。 */
(() => {
  const { UART4StreamParser, encodeParameterReadRequest, encodeParameterWriteRequest, encodeParameterSaveRequest } = BoatModules.uart4Protocol;
  const ISSC = { service:'49535343-fe7d-4ae5-8fa9-9fafd205e455', tx:'49535343-1e4d-4bd9-ba61-23c647249616', rx:'49535343-8841-43f4-a8d4-ecbe34729bb3' };
  const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  class BoatLink extends EventTarget {
    constructor() {
      super(); this.generation=0; this.sequence=0; this.parser=new UART4StreamParser(); this.pending=null; this.busy=false;
    }
    emit(name, detail) { this.dispatchEvent(new CustomEvent(name, {detail})); }
    get connected() { return !!(this.device?.gatt.connected && this.tx); }
    async connect() {
      window.BoatAuth?.assertMonitor();
      if(this.busy || this.connected) return;
      if(!window.isSecureContext) throw Error('蓝牙需要 HTTPS 或本机 localhost 地址');
      if(!navigator.bluetooth) throw Error('当前浏览器不支持 Web Bluetooth，请使用支持蓝牙的 Chrome/Edge');
      this.busy=true;
      const token=++this.generation;
      const current=()=>{if(token!==this.generation)throw Error('连接已取消');};
      const services=[ISSC.service,NUS,0xffe0,0xfff0];
      try {
        // 不要求广播包含串口 UUID，兼容 T10 只广播设备名称的情况。
        const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true, optionalServices:services});
        current(); this.device=device;
        this.disconnected=()=>{if(token===this.generation)this.disconnect('蓝牙连接已断开');};
        device.addEventListener('gattserverdisconnected',this.disconnected);
        const server=await device.gatt.connect();current();
        const available=await server.getPrimaryServices();current();
        const candidates=[];
        for(const service of available) {
          const chars=await service.getCharacteristics();current();
          const isISSC=service.uuid.toLowerCase()===ISSC.service;
          for(const tx of chars.filter(c=>c.properties.notify||c.properties.indicate)) {
            if(isISSC&&tx.uuid.toLowerCase()!==ISSC.tx)continue;
            const writers=chars.filter(c=>c.properties.write||c.properties.writeWithoutResponse);
            const rx=isISSC?writers.find(c=>c.uuid.toLowerCase()===ISSC.rx)||
              writers.find(c=>c.uuid.toLowerCase()===ISSC.tx):writers[0];
            candidates.push({tx,rx,score:isISSC?100:service.uuid===NUS?80:20});
          }
        }
        candidates.sort((a,b)=>b.score-a.score);
        let lastError;
        for(const candidate of candidates) {
          current();this.parser=new UART4StreamParser();
          const listener=e=>{
            if(token!==this.generation)return;
            for(const frame of this.parser.push(e.target.value)) {
              if(frame.parameters) this.handleResponse(frame);
              this.emit('frame',frame);
            }
          };
          candidate.tx.addEventListener('characteristicvaluechanged',listener);
          try {
            await candidate.tx.startNotifications();current();
            this.tx=candidate.tx;this.rx=candidate.rx;this.listener=listener;break;
          } catch(error) {
            candidate.tx.removeEventListener('characteristicvaluechanged',listener);lastError=error;
          }
        }
        if(!this.tx)throw Error('无法开启串口通知：'+(lastError?.message||'未找到支持的串口服务'));
        this.emit('connection',{connected:true,name:device.name||'蓝牙设备',id:device.id,tx:this.tx.uuid,rx:this.rx?.uuid||'无可写特征'});
      } catch(error) {
        if(token===this.generation)this.disconnect(error.name==='NotFoundError'?'已取消选择':error.message);
        throw error;
      } finally { this.busy=false; }
    }
    disconnect(message='已断开') {
      ++this.generation;
      if(this.pending)this.finish(Error('连接已断开，请重新读取参数'));
      if(this.tx&&this.listener)this.tx.removeEventListener('characteristicvaluechanged',this.listener);
      if(this.device&&this.disconnected)this.device.removeEventListener('gattserverdisconnected',this.disconnected);
      if(this.device?.gatt.connected)this.device.gatt.disconnect();
      this.tx=null;this.rx=null;this.device=null;this.listener=null;
      this.emit('connection',{connected:false,message});
    }
    async write(bytes, token, pending) {
      const rx=this.rx;
      for(let i=0;i<bytes.length;i+=20) {
        window.BoatAuth?.assertManage();
        if(token!==this.generation||!this.connected||this.pending!==pending)throw Error('发送已取消');
        const chunk=bytes.slice(i,i+20);
        // 按特征实际属性选择写法，存在 API 方法不代表设备支持该写法。
        if(rx.properties.write) {
          if(rx.writeValueWithResponse)await rx.writeValueWithResponse(chunk);
          else await rx.writeValue(chunk);
        } else if(rx.properties.writeWithoutResponse)await rx.writeValueWithoutResponse(chunk);
        else throw Error('蓝牙特征不可写');
      }
    }
    async request(kind, values) {
      if(window.BoatAuth)await window.BoatAuth.verifyManage();
      if(this.pending)return Promise.reject(Error('请等待当前参数操作完成'));
      if(!this.connected||!this.rx)return Promise.reject(Error('请先连接支持参数写入的设备'));
      const seq=this.sequence=(this.sequence+1)>>>0;
      let bytes;
      try { bytes=kind==='read'?encodeParameterReadRequest(seq):kind==='flash'?encodeParameterSaveRequest(seq,values):encodeParameterWriteRequest(seq,values); }
      catch(error){return Promise.reject(error);}
      return new Promise((resolve,reject)=>{
        const pending={seq,kind,resolve,reject};
        this.pending=pending;
        pending.timer=setTimeout(()=>{
          if(this.pending===pending)this.finish(Error(kind==='flash'?'Flash 响应超时，请重新读取确认，不要假定保存成功':'参数响应超时，请检查 T10 → R10 → STM32 接收线路'));
        },kind==='flash'?15000:3000);
        this.write(bytes,this.generation,pending).catch(error=>{if(this.pending===pending)this.finish(error);});
      });
    }
    handleResponse(frame) {
      if(this.pending?.seq!==frame.requestSequence)return;
      if(window.BoatAuth&&!window.BoatAuth.canManage){this.finish(Error('账户权限已变化，请重新登录管理员'));return;}
      this.finish(null,frame);
    }
    finish(error, frame) {
      const pending=this.pending;if(!pending)return;
      clearTimeout(pending.timer);this.pending=null;
      if(error)pending.reject(error);else pending.resolve(frame);
    }
  }
  window.BoatLink=BoatLink;
})();
