/* 平台管理员编辑启动开关；关闭窗口或更换身份时取消本页尚未完成的请求。 */
(() => {
  'use strict';
  class BoatStartupSettingsPanel {
    constructor(){
      this.auth=window.BoatAuth;this.nodes=Object.fromEntries(['startupSettings','startupSettingsForm','startupSettingsEnabled','startupSettingsRead','startupSettingsSave','startupSettingsStatus'].map(id=>[id,document.getElementById(id)]));
      this.operation=0;this.loaded=false;this.busy=false;this.revision=0;this.generation=this.auth?.generation;
      this.auth?.addEventListener('change',()=>{
        if(this.generation!==this.auth.generation){this.generation=this.auth.generation;this.close();if(document.getElementById('platformSettingsDialog').open)this.open();}
        this.render();
      });
      this.nodes.startupSettingsForm.addEventListener('submit',event=>{event.preventDefault();this.save();});
      this.nodes.startupSettingsRead.addEventListener('click',()=>this.read());
      this.nodes.startupSettingsEnabled.addEventListener('change',()=>this.notice('设置尚未保存。'));
      this.render();
    }
    get allowed(){return this.auth?.ready===true&&this.auth.enabled===true&&this.auth.user?.role==='admin';}
    notice(message,tone='neutral'){this.nodes.startupSettingsStatus.textContent=message;this.nodes.startupSettingsStatus.dataset.tone=tone;}
    render(){
      const n=this.nodes;n.startupSettings.hidden=!this.allowed;
      n.startupSettingsEnabled.disabled=!this.allowed||this.busy||!this.loaded;
      n.startupSettingsRead.disabled=!this.allowed||this.busy;
      n.startupSettingsSave.disabled=!this.allowed||this.busy||!this.loaded;
      n.startupSettingsForm.setAttribute('aria-busy',String(this.busy));
    }
    open(){this.render();if(this.allowed&&!this.loaded&&!this.busy)return this.read();}
    close(){++this.operation;this.controller?.abort();this.busy=false;this.loaded=false;this.revision=0;this.nodes.startupSettingsEnabled.checked=true;this.notice('尚未读取启动设置。');this.render();}
    read(){return this.request('GET');}
    save(){if(this.loaded)return this.request('PUT',{revision:this.revision,enabled:this.nodes.startupSettingsEnabled.checked});}
    async request(method,body){
      if(!this.allowed||this.busy)return;
      const operation=++this.operation,generation=this.auth.generation,controller=this.controller=new AbortController();
      this.busy=true;this.notice(method==='PUT'?'正在保存启动设置…':'正在读取启动设置…');this.render();
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},8000);
      try{
        // PUT在服务器再次验证有效管理员会话，本页用身份代数拒绝迟到响应。
        if(operation!==this.operation||generation!==this.auth.generation||!this.allowed)return;
        const response=await fetch('/api/startup-settings',{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
          headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        const data=await response.json();
        if(!response.ok)throw Object.assign(Error(data.error||'启动设置请求失败'),{status:response.status});
        if(operation!==this.operation||generation!==this.auth.generation||!this.allowed)return;
        if(typeof data.enabled!=='boolean'||!Number.isSafeInteger(data.revision)||data.revision<0)throw Error('启动设置响应无效，请重新读取');
        this.nodes.startupSettingsEnabled.checked=data.enabled;this.revision=data.revision;this.loaded=true;
        this.notice(data.error||(method==='PUT'?'已保存。对所有用户下次打开或刷新页面生效。':(data.enabled?'当前已开启：动画结束后等待按键或点击进入。':'当前已关闭：打开页面后直接进入后台。')),data.error?'error':'success');
      }catch(error){
        if(operation!==this.operation||generation!==this.auth.generation)return;
        this.loaded=false;
        if(error.status===401)this.auth.expire();
        this.notice(timedOut?'请求超时，结果尚未确认，请重新读取后再操作。':error.message,'error');
      }finally{clearTimeout(timer);if(operation===this.operation){this.busy=false;this.controller=null;this.render();}}
    }
  }
  window.BoatStartupSettingsPanel=BoatStartupSettingsPanel;
})();
