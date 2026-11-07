/* Xbox 标准映射只提供归一化输入，沿用原网页接管、序号和超时链路。 */
(function(scope){
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const pressed=button=>button?.pressed===true||(Number.isFinite(button?.value)&&button.value>.5);
  // 死区外重新缩放到满量程，满杆仍对应网页设定的运动幅度。
  function axis(value,deadzone){
    if(!Number.isFinite(value))return 0;
    const magnitude=Math.abs(clamp(value,-1,1));
    return magnitude<=deadzone?0:Math.sign(value)*(magnitude-deadzone)/(1-deadzone);
  }
  function readPad(pad,deadzone=.15){
    if(!pad||pad.connected!==true||pad.mapping!=='standard'||!Number.isInteger(pad.index)||pad.index<0||typeof pad.id!=='string'||!pad.id||pad.id.length>1024||!pad.axes||pad.axes.length<4||!pad.buttons||pad.buttons.length<10)return null;
    const axes=Array.from(pad.axes).slice(0,4);
    if(!axes.every(value=>Number.isFinite(value)&&Math.abs(value)<=1))return null;
    if(!Array.from(pad.buttons).slice(0,10).every(button=>button&&typeof button.pressed==='boolean'&&Number.isFinite(button.value)&&button.value>=0&&button.value<=1))return null;
    return {key:JSON.stringify([pad.index,pad.id]),index:pad.index,id:pad.id,forward:axis(-axes[1],deadzone),turn:axis(axes[2],deadzone),
      neutral:axes.every(value=>Math.abs(value)<=deadzone),rb:pressed(pad.buttons[5]),stop:pressed(pad.buttons[1])||pressed(pad.buttons[9]),mode:pressed(pad.buttons[2]),swap:pressed(pad.buttons[3]),
      buttonsReleased:!Array.from(pad.buttons).some(pressed)};
  }
  class BoatDriverGamepad{
    constructor({driver,scope:host=scope,navigator=host.navigator,document=driver.document}={}){
      this.driver=driver;this.scope=host;this.navigator=navigator;this.document=document;
      this.nodes=Object.fromEntries(['driverInputSource','driverGamepadPanel','driverGamepadDevice','driverGamepadRefresh','driverGamepadDeadzone','driverGamepadDeadzoneValue','driverGamepadStatus','driverInputBadge'].map(id=>[id,document.getElementById(id)]));
      this.source='keyboard';this.selectedKey='';this.sample=null;this.previous=null;this.devices=[];this.deadzone=.15;this.error='';this.deviceSignature='';this.lastTick=null;this.destroyed=false;this.handlers=[];
      try{const saved=host.localStorage?.getItem('boat-driver-gamepad-deadzone');if(saved!==null&&saved!==undefined&&Number.isFinite(Number(saved)))this.deadzone=clamp(Number(saved),.05,.3);}catch(_){}
      this.reset();this.nodes.driverInputSource.value='keyboard';
      this.listen(this.nodes.driverInputSource,'change',()=>this.selectSource(this.nodes.driverInputSource.value));
      this.listen(this.nodes.driverGamepadDevice,'change',()=>{
        this.driver.stop('已切换手柄，已停船并退出操控');this.selectedKey=this.nodes.driverGamepadDevice.value;this.previous=null;this.reset();this.scan();this.driver.render();
      });
      this.listen(this.nodes.driverGamepadRefresh,'click',()=>{this.scan();this.driver.render();});
      this.listen(this.nodes.driverGamepadDeadzone,'change',()=>{
        const value=Number(this.nodes.driverGamepadDeadzone.value);if(!Number.isFinite(value)){this.render();return;}
        this.driver.stop('已调整手柄死区，已停船并退出操控');this.deadzone=clamp(value/100,.05,.3);this.reset();
        try{host.localStorage?.setItem('boat-driver-gamepad-deadzone',String(this.deadzone));}catch(_){}
        this.scan();this.driver.render();
      });
      this.listen(host,'gamepadconnected',()=>{this.scan();this.driver.render();});
      this.listen(host,'gamepaddisconnected',event=>{
        if(this.sample?.index===event.gamepad?.index||this.selectedKey===JSON.stringify([event.gamepad?.index,event.gamepad?.id])){
          if(this.enabled())this.driver.stop('手柄已断开，已停船并退出操控',true);
          this.sample=null;this.previous=null;this.reset();
        }
        this.scan();this.driver.render();
      });
      this.scan();this.render();
    }
    listen(node,event,handler){node.addEventListener(event,handler);this.handlers.push([node,event,handler]);}
    enabled(){return this.source==='gamepad';}
    reset(){this.vector={forward:0,turn:0};this.needsNeutral=true;this.engaged=false;}
    input(){return this.vector;}
    scan(){
      let pads=[];this.error='';
      try{
        if(this.scope.isSecureContext===false)throw Error('手柄需要 HTTPS 或 localhost 访问。');
        if(typeof this.navigator?.getGamepads!=='function')throw Error('浏览器未提供手柄接口，请使用新版 Chrome 或 Edge。');
        pads=Array.from(this.navigator.getGamepads()||[]).filter(Boolean).slice(0,16);
      }catch(error){this.error=error.message||'手柄接口不可用，请检查浏览器权限。';}
      this.devices=pads.map(pad=>({pad,value:readPad(pad,this.deadzone)}));
      // 只在尚未选择过设备时自动选第一个标准手柄；断开后不能换另一只继续驾驶。
      if(!this.selectedKey)this.selectedKey=this.devices.find(device=>device.value)?.value.key||'';
      this.sample=this.devices.find(device=>device.value?.key===this.selectedKey)?.value||null;
      return this.sample;
    }
    selectSource(value){
      const source=value==='gamepad'?'gamepad':'keyboard';if(source===this.source)return;
      this.driver.stop('已切换控制输入，已停船并退出操控');this.driver.keys.clear();this.source=source;this.previous=null;this.lastTick=null;this.reset();this.scan();this.driver.render();
    }
    canAcquire(){return !this.enabled()||!!this.sample&&this.sample.neutral&&this.sample.buttonsReleased;}
    prepareAcquire(){
      if(!this.enabled())return true;
      this.reset();this.lastTick=null;this.scan();this.render();
      if(this.canAcquire())return true;
      this.driver.toast(this.sample?'请先将两个摇杆回中并松开所有手柄按钮。':this.problem());return false;
    }
    confirmAcquire(){if(!this.enabled())return true;this.scan();return !!this.sample&&!this.sample.stop;}
    begin(){this.reset();this.previous=this.sample;}
    problem(){return this.error||(this.devices.length?'所选手柄未连接或不是标准映射；请选择 Xbox / 标准 PC 手柄。':'未检测到手柄；连接后按一次手柄按钮，再刷新设备。');}
    tick(now){
      if(this.destroyed||!this.driver.visible())return false;
      const before=JSON.stringify([this.sample,this.engaged,this.needsNeutral,this.error]),last=this.lastTick;this.lastTick=now;
      const sample=this.scan(),previous=this.previous;this.previous=sample;
      if(!this.enabled()){this.render();return false;}
      const d=this.driver;
      if(!sample){this.reset();if(d.active||d.pending)d.stop('手柄连接或映射失效，已停船并退出操控',true);}
      else if(d.admin()){
        // 急停先于表单、模式及摇杆处理，不以鼠标焦点作为急停条件。
        if(sample.stop&&!previous?.stop)d.nodes.driverEmergency.click();
        const blocked=this.document.querySelector('dialog[open]')||d.editing(this.document.activeElement)||d.layout?.editing;
        if((d.active||d.pending)&&last!==null&&now-last>=500){d.stop('手柄采样中断，已停船并退出操控',true);this.reset();}
        else if(blocked){if(d.active||d.pending)d.stop('正在编辑界面，已停船并退出手柄操控');this.reset();}
        else {
          if(sample.swap&&!previous?.swap)d.setMediaFocus(d.nodes['view-driving'].dataset.primary==='map'?'video':'map');
          if(sample.mode&&!previous?.mode&&!d.active&&!d.pending&&d.permitted()&&sample.neutral&&!sample.rb&&!d.nodes.driverMode.disabled){
            let mode=(Number(d.nodes.driverMode.value)+1)%3;if(mode===2&&!Number.isFinite(d.actualHeading))mode=0;
            d.nodes.driverMode.value=String(mode);d.nodes.driverMode.dispatchEvent(new this.scope.Event('change'));
          }
          if(!d.active){this.reset();}
          else if(!d.permitted()){this.reset();}
          else if(!sample.rb){
            if(this.engaged)d.stop('已松开 RB，已停船并退出手柄操控');
            this.vector={forward:0,turn:0};this.engaged=false;if(sample.neutral&&!sample.stop)this.needsNeutral=false;
          }else if(!this.engaged&&(this.needsNeutral||!sample.neutral)){
            this.needsNeutral=true;this.vector={forward:0,turn:0};
          }else {this.engaged=true;this.vector={forward:sample.forward,turn:sample.turn};}
        }
      }else this.reset();
      this.render();return before!==JSON.stringify([this.sample,this.engaged,this.needsNeutral,this.error]);
    }
    render(){
      if(this.destroyed)return;
      const n=this.nodes,d=this.driver,enabled=this.enabled(),allowed=d.admin();
      n.driverInputSource.value=this.source;n.driverInputSource.disabled=!allowed;n.driverGamepadPanel.hidden=!enabled;
      const signature=JSON.stringify([this.selectedKey,this.devices.map(({pad,value})=>[pad.index,pad.id,!!value])]);
      if(signature!==this.deviceSignature){
        this.deviceSignature=signature;const options=[];
        const add=(text,value,disabled=false)=>{const option=this.document.createElement('option');option.textContent=text;option.value=value;option.disabled=disabled;options.push(option);};
        if(!this.devices.length)add('连接手柄后按一次按钮','');
        for(const {pad,value}of this.devices)add((pad.id||'未知手柄').slice(0,160)+(value?'':' · 非标准映射'),value?.key||JSON.stringify([pad.index,pad.id]),!value);
        if(this.selectedKey&&!this.sample)add('原手柄已断开，请重新连接或选择设备',this.selectedKey);
        n.driverGamepadDevice.replaceChildren(...options);n.driverGamepadDevice.value=this.selectedKey;
      }
      n.driverGamepadDevice.disabled=!allowed;n.driverGamepadRefresh.disabled=!allowed;n.driverGamepadDeadzone.disabled=!allowed;
      if(this.document.activeElement!==n.driverGamepadDeadzone)n.driverGamepadDeadzone.value=String(Math.round(this.deadzone*100));
      n.driverGamepadDeadzoneValue.textContent=Math.round(this.deadzone*100)+'%';
      n.driverInputBadge.hidden=!enabled;
      const status=!this.sample?this.problem():d.pending?'等待船端确认，摇杆输入保持为零。':!d.active?(!this.sample.neutral||!this.sample.buttonsReleased?'将两个摇杆回中并松开所有按钮，再点击“启用操控”。':'手柄已连接；先在网页点击“启用操控”。'):this.engaged?'RB 已按住，摇杆正在控制无人船。':this.needsNeutral?'将摇杆回中并松开 RB，再按住 RB 驾驶。':'摇杆已回中，按住 RB 后移动摇杆驾驶。';
      if(n.driverGamepadStatus.textContent!==status)n.driverGamepadStatus.textContent=status;n.driverGamepadStatus.dataset.error=String(!this.sample);
      const badge=!this.sample?'手柄未就绪':d.active?(this.engaged?'手柄 · RB 驾驶中':'手柄 · 等待 RB'):'手柄 · 未接管';
      if(n.driverInputBadge.textContent!==badge)n.driverInputBadge.textContent=badge;
      n.driverInputBadge.title=status;d.nodes['view-driving'].dataset.inputSource=this.source;
    }
    destroy(){this.destroyed=true;this.reset();for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);this.handlers=[];}
  }
  scope.BoatDriverGamepad=BoatDriverGamepad;
  if(typeof module==='object'&&module.exports)module.exports={BoatDriverGamepad,readPad,axis};
})(typeof window==='object'?window:globalThis);
