/* 驾驶页的自主导航入口复用任务服务；地图点选只改草稿，明确保存后才写服务器。 */
(() => {
  'use strict';
  class BoatDriverNavigation {
    constructor(driver){
      this.driver=driver;this.document=driver.document;this.mode='manual';this.deviceId='';this.routeId='';this.busy=false;this.draft=null;this.editingHome=false;this.handlers=[];
      this.nodes=Object.fromEntries(['driverAutonomy','driverRouteSelect','driverNavSpeed','driverNavRadius','driverNavSave','driverGoto','driverNavStart','driverNavPause','driverNavResume','driverNavNotice','driverHomeSet','driverReturnHome','driverHomeEditor','driverHomeDraft','driverHomeSave','driverHomeCancel','driverHomeStatus'].map(id=>[id,this.document.getElementById(id)]));
      for(const button of this.document.querySelectorAll('[data-navigation-mode]'))this.listen(button,'click',()=>this.selectMode(button.dataset.navigationMode));
      this.listen(this.nodes.driverRouteSelect,'change',()=>{this.routeId=this.nodes.driverRouteSelect.value;this.fillRoute();this.render();});
      for(const action of ['goto','start','pause','resume'])this.listen(this.nodes[{goto:'driverGoto',start:'driverNavStart',pause:'driverNavPause',resume:'driverNavResume'}[action]],'click',()=>this.perform(async operation=>{
        if(['goto','start'].includes(action)&&this.mode==='auto'&&this.routeDirty())throw Error('航速或半径已修改，请先点击保存设置');
        const run=await this.missions.submitNavigation(action==='start'&&this.mode==='hold'?'hold':action,{routeId:this.routeId,...this.values()});
        if(operation?.cancelled&&run?.active){await this.missions.stop(run);return;}
        this.notice(action==='pause'?'已请求停船；收到船端确认后可以继续。':action==='resume'?'正在重新校验反馈并申请接管。':'已提交服务器；关闭网页后继续，可暂停或急停。');
      },{motion:['goto','start','resume'].includes(action)}));
      this.listen(this.nodes.driverNavSave,'click',()=>this.perform(async()=>{await this.missions.saveNavigationSpeed(this.routeId,this.values().speedMps,this.values().arrivalRadiusM);this.notice('航线航速和到点半径已保存到服务器。');}));
      this.listen(this.nodes.driverHomeSet,'click',()=>{this.setHomeEditing(!this.editingHome);driver.nodes.driverMapOptions.open=false;this.render();});
      this.listen(this.nodes.driverHomeCancel,'click',()=>{this.setHomeEditing(false);this.render();});
      this.listen(this.nodes.driverHomeSave,'click',()=>this.perform(async()=>{if(!this.draft)throw Error('请先在地图上选择返航点');await this.missions.saveHome(this.draft);this.setHomeEditing(false);this.notice('当前船的返航点已保存到服务器。');}));
      this.listen(this.nodes.driverReturnHome,'click',()=>this.perform(async operation=>{const run=await this.missions.submitNavigation('home',this.values());if(operation?.cancelled){await this.missions.stop(run);return;}this.notice('正在返回已保存返航点；直线返航不包含自动避障。');},{motion:true}));
      this.listen(driver.nodes.driverEmergency,'click',()=>{
        if(!this.missions?.admin||(!this.missions.run()?.active&&(!this.motionPending||this.pendingMotion?.deviceId!==this.deviceId)))return;
        this.cancelMotion=true;if(this.pendingMotion?.deviceId===this.deviceId)this.pendingMotion.cancelled=true;
        this.notice('急停已请求，等待服务器和船端停止确认。');this.missions.poll(true);this.render();
      });
      this.listen(window,'boat-mission-change',()=>this.render());
      this.listen(window,'boat-view-change',event=>{if(event.detail?.view!=='driving')this.setHomeEditing(false);});
      this.listen(window,'boat-selection-change',event=>{if(event.detail?.selectedId!==this.deviceId)this.setHomeEditing(false);this.render();});
      this.listen(window,'boat-theme-change',()=>this.render());
      this.render();
    }
    get missions(){return window.BoatMissions;}
    listen(node,event,handler){node.addEventListener(event,handler);this.handlers.push([node,event,handler]);}
    notice(message,error=false){this.nodes.driverNavNotice.textContent=message;this.nodes.driverNavNotice.dataset.error=String(error);}
    values(){return {speedMps:Number(this.nodes.driverNavSpeed.value),arrivalRadiusM:Number(this.nodes.driverNavRadius.value)};}
    fillRoute(){const route=this.missions?.routes.find(r=>r.id===this.routeId);if(route){this.nodes.driverNavSpeed.value=route.speedMps;this.nodes.driverNavRadius.value=route.arrivalRadiusM;}}
    routeDirty(){const route=this.missions?.routes.find(r=>r.id===this.routeId),v=this.values();return !!route&&(route.speedMps!==v.speedMps||route.arrivalRadiusM!==v.arrivalRadiusM);}
    selectMode(mode){
      if(!['manual','auto','hold'].includes(mode)||this.busy)return;
      const run=this.missions?.run();
      if(run?.active){this.notice('请先停止当前自主导航，再切换航行方式。',true);return;}
      if(mode!==this.mode){this.driver.stop('已切换航行方式，已停船并退出键盘操控');this.mode=mode;this.notice('');if(mode==='auto')this.fillRoute();}
      this.driver.render();
    }
    async perform(fn,{motion=false}={}){
      const id=this.driver.context.deviceId,generation=window.BoatAuth?.generation;
      if(this.busy||!this.missions?.admin||!id||id!==this.missions.deviceId||this.driver.layout?.editing)return;
      const operation=motion?{deviceId:id,cancelled:false}:null;
      this.busy=true;this.motionPending=motion;this.pendingMotion=operation;if(motion)this.cancelMotion=false;this.render();
      try{await fn(operation);}catch(error){if(id===this.driver.context.deviceId&&generation===window.BoatAuth?.generation)this.notice(error.name==='AbortError'?'请求超时，结果未知，请等待状态刷新后核对。':error.message,true);}
      finally{this.busy=false;this.motionPending=false;this.pendingMotion=null;this.missions?.poll(true);this.driver.lastPoll=0;this.driver.poll();this.render();}
    }
    bindMap(){
      const map=window.boatMonitor?.map;if(!map||map===this.map)return;
      this.map=map;this.mapClick=point=>{
        if(!this.editingHome||!this.missions?.admin||this.busy||this.driver.context.deviceId!==this.missions.deviceId)return;
        if(!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude)||Math.abs(point.latitude)>85||Math.abs(point.longitude)>180)return;
        this.draft={latitude:Number(point.latitude.toFixed(7)),longitude:Number(point.longitude.toFixed(7))};this.render();
      };
      this.mapRestore=()=>{this.markerKey='';this.drawHome();};
      map.on('click',this.mapClick);map.on('ready',this.mapRestore);map.on('providerchange',this.mapRestore);
    }
    setHomeEditing(value){this.editingHome=!!value;this.draft=null;this.nodes.driverHomeEditor.hidden=!value;this.drawHome();}
    drawHome(){
      if(!this.map)return;
      const allowed=this.missions?.admin&&this.driver.context.deviceId===this.missions.deviceId;
      const home=allowed?(this.editingHome&&this.draft?this.draft:this.missions.home):null;
      const key=JSON.stringify([this.deviceId,home,this.editingHome,this.map.provider,this.map.ready]);if(key===this.markerKey)return;this.markerKey=key;
      this.marker?.remove();this.marker=null;
      if(home&&this.map.ready)this.marker=this.map.createMarker(home,{className:'driver-home-pin',html:'<span>'+(this.editingHome?'选':'返')+'</span>',iconSize:[30,30],iconAnchor:[15,15],interactive:false,title:this.editingHome?'待保存返航点':'当前船已保存返航点'});
    }
    render(){
      const m=this.missions,d=this.driver;if(!m)return;
      if(this.deviceId!==d.context.deviceId){this.deviceId=d.context.deviceId;this.mode='manual';this.routeId='';this.seenRun='';this.routeSignature='';this.cancelMotion=false;this.setHomeEditing(false);this.notice('');}
      const same=!!this.deviceId&&m.deviceId===this.deviceId,run=same?m.run():null,active=run?.active===true,paused=run?.status==='paused';
      if((active||paused)&&this.seenRun!==run.runId){this.seenRun=run.runId;this.mode=run.action==='hold'?'hold':'auto';}
      if(!m.admin)this.setHomeEditing(false);
      const locked=this.busy||m.busy||!m.admin||!same||!!m.statusError||!!m.storageError||d.layout?.editing;
      const ready=!locked&&d.context.connected&&!d.active&&!d.pending&&d.remote?.ready===true&&!d.context.parameterBusy&&!this.editingHome;
      const routes=same?m.routes:[],signature=JSON.stringify(routes.map(r=>[r.id,r.revision,r.name]));
      if(signature!==this.routeSignature){
        const previous=this.routeId;this.routeSignature=signature;
        if(!routes.some(r=>r.id===this.routeId))this.routeId=routes.find(r=>r.id===run?.routeId)?.id||routes[0]?.id||'';
        this.nodes.driverRouteSelect.replaceChildren(new Option('请选择已保存航线',''),...routes.map(r=>new Option(r.name,r.id)));this.nodes.driverRouteSelect.value=this.routeId;
        if(previous!==this.routeId||!this.formRouteRevision)this.fillRoute();
        this.formRouteRevision=routes.find(r=>r.id===this.routeId)?.revision||0;
      }
      d.nodes['view-driving'].dataset.navigationMode=this.mode;
      this.nodes.driverAutonomy.hidden=this.mode==='manual';
      for(const button of this.document.querySelectorAll('[data-navigation-mode]')){button.setAttribute('aria-pressed',String(button.dataset.navigationMode===this.mode));button.disabled=locked||active||d.pending;}
      const auto=this.mode==='auto';this.nodes.driverRouteSelect.closest('label').hidden=!auto;this.nodes.driverNavSave.hidden=!auto;
      this.nodes.driverNavSave.disabled=locked||active||!this.routeId;
      this.nodes.driverRouteSelect.disabled=locked||active;
      for(const id of ['driverNavSpeed','driverNavRadius'])this.nodes[id].disabled=locked||active;
      this.nodes.driverGoto.hidden=!auto;this.nodes.driverGoto.disabled=!ready||!this.routeId||active;
      this.nodes.driverNavStart.textContent=auto?'开始任务':'启动定点保持';this.nodes.driverNavStart.disabled=!ready||active||(auto&&!this.routeId);
      this.nodes.driverNavPause.disabled=locked||!active||run.status==='stopping';this.nodes.driverNavResume.disabled=!ready||!paused||!run.resumable;
      this.nodes.driverHomeSet.disabled=locked||active||d.active||d.pending;this.nodes.driverHomeSet.setAttribute('aria-pressed',String(this.editingHome));
      this.nodes.driverReturnHome.disabled=!ready||active||!m.home;
      this.nodes.driverReturnHome.title='按 '+this.values().speedMps+' m/s、到点半径 '+this.values().arrivalRadiusM+' m 直线返航；不包含自动避障';
      this.nodes.driverHomeSave.disabled=locked||!this.draft;
      this.nodes.driverHomeEditor.hidden=!this.editingHome;
      this.nodes.driverHomeDraft.textContent=this.draft?this.draft.latitude.toFixed(7)+' / '+this.draft.longitude.toFixed(7):'请在地图上选择位置';
      this.nodes.driverHomeStatus.textContent=same&&m.home?'返航点 · '+m.home.latitude.toFixed(6)+' / '+m.home.longitude.toFixed(6):'当前船尚未设置返航点';
      if(this.mode!=='manual')d.nodes.driverEnable.disabled=true;
      const pendingHere=this.motionPending&&this.pendingMotion?.deviceId===this.deviceId;
      d.nodes.driverEmergency.disabled=(!d.active&&!d.pending&&!active&&!pendingHere)||!m.admin;
      const layoutButton=this.document.getElementById('driverLayoutToggle');layoutButton.disabled=active;layoutButton.title=active?'先停止自主导航，再编辑布局':'拖动模块并设置单独透明度';
      // 停止请求不排在正在等待的导航 HTTP 后面；迟到的接管结果也必须停掉。
      if(this.cancelMotion&&active&&run.status!=='stopping'&&!this.emergencyPending&&m.admin){
        this.emergencyPending=true;m.stop(run).catch(error=>this.notice('急停确认失败：'+error.message,true)).finally(()=>{this.emergencyPending=false;});
      }
      if(this.cancelMotion&&!this.motionPending&&!active&&run&&['stopped','completed','failed'].includes(run.status))this.cancelMotion=false;
      if(active||paused)d.text('driverSystemMode',(run.action==='hold'?'定点保持':run.action==='home'?'一键返航':'自动航行')+' · '+(paused?'已暂停':run.status==='running'?'运行中':'准备中'));
      if(active||paused){d.text('driverTakeoverStatus',paused?'任务已暂停':run.status==='running'?'服务器已接管':run.status==='stopping'?'等待停船确认':'等待自主接管');d.nodes.driverTakeoverStatus.dataset.state=run.status==='running'?'active':paused?'idle':'pending';}
      d.hud.setNavigation(same?m.navigationState():null);
      this.bindMap();this.drawHome();
    }
    destroy(){for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);this.map?.off('click',this.mapClick);this.map?.off('ready',this.mapRestore);this.map?.off('providerchange',this.mapRestore);this.marker?.remove();}
  }
  window.BoatDriverNavigation=BoatDriverNavigation;
})();
