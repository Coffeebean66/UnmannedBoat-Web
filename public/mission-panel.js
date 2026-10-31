/* 航线编辑器只提交显式操作；轮询用于显示，切页/关闭网页不会产生停止或续航命令。 */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),clone=x=>JSON.parse(JSON.stringify(x));
  const labels={preparing:'读取参数',acquiring:'等待接管',running:'执行中',stopping:'正在停止',completed:'已完成',stopped:'已停止',failed:'异常停止'};
  class BoatMissionPanel {
    constructor(){
      this.deviceId='';this.routes=[];this.runs=[];this.route=this.blank();this.dirty=false;this.editing=false;this.busy=false;this.drafts=new Map();this.stops=new Set();this.activeRows=new Map();this.markers=[];this.position=null;this.generation=0;
      for(const id of ['missionName','missionSpeed','missionRadius'])$(id).addEventListener('input',()=>{this.readForm();this.dirty=true;this.render();});
      $('missionRouteSelect').addEventListener('change',()=>this.load($('missionRouteSelect').value));
      $('missionNew').onclick=()=>{this.route=this.blank();this.dirty=false;this.drafts.set(this.deviceId,{route:clone(this.route),dirty:false});this.fillForm();this.renderPoints();this.render();this.draw();};
      $('missionEdit').onclick=()=>{this.editing=!this.editing;this.render();};
      $('missionFit').onclick=()=>this.fit();$('missionCenter').onclick=()=>{if(this.position)this.map?.setView(this.position,18);else this.notice('当前没有有效实时船位',true);};
      $('missionProvider').onclick=()=>this.action(async()=>{if(this.map){if(this.map.mode==='satellite')await this.map.switchMode('planar');else await this.map.switchProvider(this.map.provider==='amap'||!this.map.ready?'osm':'amap');}this.draw();});
      $('missionRefresh').onclick=()=>this.poll(true);
      $('missionAddPosition').onclick=()=>{if(this.position)this.addPoint(this.position);else this.notice('当前没有有效实时船位',true);};
      $('missionAddCenter').onclick=()=>{const p=this.map?.getCenter();if(p)this.addPoint(p);};
      $('missionClear').onclick=()=>{this.route.points=[];this.changed();};
      $('missionSave').onclick=()=>this.action(()=>this.save());
      $('missionDelete').onclick=()=>this.action(()=>this.remove());
      for(const action of ['goto','start'])$('mission'+(action==='goto'?'Goto':'Start')).onclick=()=>this.action(()=>this.execute(action));
      const stop=()=>{const run=this.run();if(run)this.stop(run).catch(error=>this.notice(error.message,true));};
      $('missionStop').onclick=stop;$('driverMissionStop').onclick=stop;
      window.addEventListener('keydown',event=>{
        if(event.code!=='Space'||event.repeat||!this.admin||!this.run()?.active||!['missions','driving'].includes(window.BoatWorkspace?.current)||event.target.closest?.('input,select,textarea,button,[contenteditable="true"]'))return;
        event.preventDefault();stop();
      });
      window.addEventListener('boat-selection-change',event=>this.select(event.detail?.selectedId||''));
      window.addEventListener('boat-view-change',event=>{if(event.detail?.view==='missions')this.initializeMap();});
      window.addEventListener('boat-theme-change',()=>this.map?.setTheme(document.documentElement.dataset.theme));
      window.BoatAuth?.addEventListener('change',()=>{
        const key=String(BoatAuth.generation);
        if(this.authKey!==key){this.authKey=key;this.generation++;this.controller?.abort();this.polling=false;this.routes=[];this.runs=[];this.position=null;this.editing=false;this.drafts.clear();this.route=this.blank();this.dirty=false;this.fillForm();this.renderPoints();this.draw();}
        if(this.admin)this.poll(true);this.render();
      });
      this.timer=setInterval(()=>{if(!document.hidden)this.poll();},1000);
      window.addEventListener('pagehide',()=>{clearInterval(this.timer);this.controller?.abort();this.map?.destroy();});
      this.fillForm();this.renderPoints();this.render();
      if(window.BoatWorkspace?.current==='missions')this.initializeMap();
    }
    blank(){return {name:'新航线',speedMps:1,arrivalRadiusM:3,points:[]};}
    get admin(){return window.BoatAuth?.enabled===true&&BoatAuth.ready&&BoatAuth.user?.role==='admin';}
    run(){return this.runs.find(r=>r.deviceId===this.deviceId);}
    readForm(){this.route.name=$('missionName').value;this.route.speedMps=Number($('missionSpeed').value);this.route.arrivalRadiusM=Number($('missionRadius').value);}
    fillForm(){ $('missionName').value=this.route.name;$('missionSpeed').value=this.route.speedMps;$('missionRadius').value=this.route.arrivalRadiusM;$('missionRouteSelect').value=this.route.id||''; }
    select(id){
      if(id===this.deviceId)return;
      if(this.deviceId){this.readForm();this.drafts.set(this.deviceId,{route:clone(this.route),dirty:this.dirty});}
      this.deviceId=id;this.generation++;this.controller?.abort();this.routes=[];this.position=null;
      const draft=this.drafts.get(id);this.route=draft?clone(draft.route):this.blank();this.dirty=!!draft?.dirty;this.editing=false;
      this.fillForm();this.renderPoints();this.render();this.draw();this.poll(true);
    }
    async request(path,options={}){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
      try{
        const response=await fetch('/api/missions'+path,{credentials:'same-origin',cache:'no-store',redirect:'error',...options,signal:options.signal||controller.signal,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});
        const data=await response.json();if(!response.ok)throw Error(data.error||'任务请求失败');return data;
      }finally{clearTimeout(timer);}
    }
    async poll(force=false){
      if(!this.admin)return;
      if(this.polling&&!force)return;
      if(force)this.controller?.abort();
      const generation=this.generation,id=this.deviceId,controller=new AbortController();this.controller=controller;this.polling=true;
      const timer=setTimeout(()=>controller.abort(),5000);
      try{
        const data=await this.request('?deviceId='+encodeURIComponent(id),{signal:controller.signal});
        if(generation!==this.generation||this.controller!==controller)return;
        this.routes=data.routes;this.runs=data.runs;this.position=data.position;this.storageError=data.storageError||'';this.statusError='';
        if(!this.route.id&&!this.dirty&&!this.route.points.length&&this.routes.length&&!this.drafts.has(id)){
          this.route=clone(this.routes.find(r=>r.id===this.run()?.routeId&&this.run()?.active)||this.routes[0]);this.fillForm();this.renderPoints();
        }
        this.render();this.draw();
      }catch(error){if(this.controller===controller&&generation===this.generation){this.position=null;this.statusError='状态同步中断，请刷新';this.notice('任务状态更新失败：'+(error.name==='AbortError'?'请求超时':error.message),true);this.render();this.draw();}}
      finally{clearTimeout(timer);if(this.controller===controller)this.polling=false;}
    }
    async action(fn){
      if(this.busy)return;this.busy=true;this.render();
      try{await fn();}catch(error){this.notice(error.name==='AbortError'?'请求超时，操作结果未知，请刷新任务状态':error.message,true);}
      finally{this.busy=false;this.render();this.poll(true);}
    }
    notice(text,error=false){$('missionNotice').textContent=text;$('missionNotice').dataset.error=String(error);}
    async save(){
      const id=this.deviceId,generation=this.generation;this.readForm();
      const {name,speedMps,arrivalRadiusM,points}=this.route;
      const data=await this.request('/route',{method:'POST',body:JSON.stringify({deviceId:id,route:{name,speedMps,arrivalRadiusM,points},...(this.route.id?{id:this.route.id,revision:this.route.revision}:{})})});
      if(generation!==this.generation)return;
      this.route=data.route;this.dirty=false;this.drafts.set(id,{route:clone(this.route),dirty:false});this.fillForm();this.notice('航线已保存到服务器，下次可直接调用。');
    }
    async remove(){
      if(!this.route.id||!window.confirm('删除服务器中的航线“'+this.route.name+'”？'))return;
      const generation=this.generation;
      await this.request('/route',{method:'DELETE',body:JSON.stringify({deviceId:this.deviceId,id:this.route.id,revision:this.route.revision})});
      if(generation!==this.generation)return;
      this.route=this.blank();this.dirty=false;this.drafts.set(this.deviceId,{route:clone(this.route),dirty:false});this.fillForm();this.renderPoints();this.draw();this.notice('航线已删除。');
    }
    load(id){
      const route=this.routes.find(r=>r.id===id);
      this.route=route?clone(route):this.blank();this.dirty=false;this.drafts.set(this.deviceId,{route:clone(this.route),dirty:false});
      this.fillForm();this.renderPoints();this.render();this.draw();this.fit();
    }
    async execute(action){
      if(this.dirty)throw Error('请先保存修改后的航线');
      const id=this.deviceId,authKey=this.authKey;
      const data=await this.request('/run',{method:'POST',body:JSON.stringify({deviceId:id,routeId:this.route.id,revision:this.route.revision,action})});
      if(authKey!==this.authKey)return;
      this.runs=this.runs.filter(r=>r.deviceId!==id).concat(data.run);this.notice('任务已提交服务器，关闭网页后仍会继续；可随时点击停止任务。');this.render();
    }
    async stop(run){
      if(this.stops.has(run.deviceId)||!this.admin)return;
      const authKey=this.authKey;
      this.stops.add(run.deviceId);this.render();
      try{
        const data=await this.request('/run',{method:'POST',body:JSON.stringify({deviceId:run.deviceId,runId:run.runId,action:'stop'})});
        if(authKey!==this.authKey)return;
        this.runs=this.runs.filter(r=>r.deviceId!==run.deviceId).concat(data.run);this.notice('已请求停止 '+run.deviceId+' 的任务，请等待船端确认。');
      }finally{this.stops.delete(run.deviceId);this.render();this.poll(true);}
    }
    changed(){this.dirty=true;this.renderPoints();this.render();this.draw();}
    addPoint(p){
      if(!this.admin||!this.deviceId||this.busy)return;
      if(!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||Math.abs(p.latitude)>85||Math.abs(p.longitude)>180)return this.notice('航点须位于纬度 ±85° 内',true);
      if(this.route.points.length>=256)return this.notice('每条航线最多 256 个航点',true);
      this.route.points.push({latitude:Number(p.latitude.toFixed(7)),longitude:Number(p.longitude.toFixed(7))});this.changed();
    }
    renderPoints(){
      const list=$('missionPoints');list.replaceChildren();$('missionPointsEmpty').hidden=this.route.points.length>0;
      this.route.points.forEach((point,index)=>{
        const row=document.createElement('li');row.className='mission-point-row';
        const label=document.createElement('strong');label.className='mission-point-label';label.textContent=(index+1)+' · '+(index===0?'开始点':index===this.route.points.length-1?'结束点':'中间点');row.append(label);
        for(const [key,text,max]of [['latitude','纬度',85],['longitude','经度',180]]){
          const field=document.createElement('label');field.textContent=text;
          const input=document.createElement('input');input.type='number';input.min=-max;input.max=max;input.step='0.0000001';input.value=point[key].toFixed(7);input.dataset.missionEditor='';input.setAttribute('aria-label','航点 '+(index+1)+' '+text+' WGS84');
          input.addEventListener('change',()=>{const n=Number(input.value);if(!input.value.trim()||!Number.isFinite(n)||Math.abs(n)>max){input.value=point[key].toFixed(7);return this.notice('请输入有效 WGS84 经纬度',true);}point[key]=n;this.changed();});field.append(input);row.append(field);
        }
        const tools=document.createElement('div');tools.className='mission-point-tools';
        for(const [text,action,disabled]of [['↑',()=>{[this.route.points[index-1],this.route.points[index]]=[point,this.route.points[index-1]];},index===0],['↓',()=>{[this.route.points[index+1],this.route.points[index]]=[point,this.route.points[index+1]];},index===this.route.points.length-1],['删除',()=>this.route.points.splice(index,1),false]]){
          const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.missionEditor='';b.dataset.fixedDisabled=String(disabled);b.setAttribute('aria-label','航点 '+(index+1)+' '+text);b.onclick=()=>{action();this.changed();};tools.append(b);
        }
        row.append(tools);list.append(row);
      });
    }
    render(){
      const run=this.run(),active=!!run?.active,locked=this.busy||!this.admin||!this.deviceId,routeLocked=active&&run.routeId===this.route.id;
      $('missionBoatName').textContent=this.deviceId||'请选择无人船';
      const select=$('missionRouteSelect'),signature=JSON.stringify(this.routes.map(r=>[r.id,r.revision,r.name]));
      if(signature!==this.routeSignature){this.routeSignature=signature;select.replaceChildren(new Option('新航线',''),...this.routes.map(r=>new Option(r.name,r.id)));}
      select.value=this.route.id||'';
      const N=BoatModules.missionNavigation;let length=0;for(let i=1;i<this.route.points.length;i++)length+=N.distance(this.route.points[i-1],this.route.points[i]);
      $('missionRouteSummary').textContent=this.route.points.length+' 个航点 · '+(length>=1000?(length/1000).toFixed(2)+' km':length.toFixed(1)+' m')+' · '+(this.dirty?'有未保存修改':this.route.id?'已保存 v'+this.route.revision:'尚未保存');
      for(const id of ['missionNew','missionRouteSelect'])$(id).disabled=locked;
      for(const id of ['missionName','missionSpeed','missionRadius','missionEdit','missionClear','missionAddCenter'])$(id).disabled=locked||routeLocked;
      $('missionSave').disabled=locked||routeLocked||this.route.points.length<2||!!this.storageError;
      $('missionDelete').disabled=locked||routeLocked||!this.route.id;
      $('missionAddPosition').disabled=locked||routeLocked||!this.position;
      $('missionGoto').disabled=$('missionStart').disabled=locked||active||!this.route.id||this.dirty||!!this.storageError;
      $('missionStop').disabled=!this.admin||this.stops.has(this.deviceId)||!active||run.status==='stopping';
      $('driverMissionStop').hidden=!this.admin||!active;$('driverMissionStop').disabled=$('missionStop').disabled;
      $('missionEdit').setAttribute('aria-pressed',String(this.editing&&!locked&&!routeLocked));$('missionEdit').textContent=this.editing?'停止点选':'开启点选航点';
      $('missionMap').dataset.editing=String(this.editing&&!locked&&!routeLocked);
      for(const el of document.querySelectorAll('[data-mission-editor]'))el.disabled=locked||routeLocked||el.dataset.fixedDisabled==='true';
      $('missionRunState').textContent=labels[run?.status]||'待命';$('missionRunState').dataset.status=run?.status||'idle';
      $('missionRunMessage').textContent=run?(run.routeName+' · '+run.message):'先保存航线，再前往开始点。';
      $('missionWaypointProgress').textContent=run?(run.targetIndex+1)+' / '+run.pointCount:'--';
      $('missionDistance').textContent=Number.isFinite(run?.distanceM)?run.distanceM.toFixed(1)+' m':'--';
      $('missionHeading').textContent=Number.isFinite(run?.targetHeading)?run.targetHeading.toFixed(1)+'°':'--';
      $('missionCommandSpeed').textContent=run?run.commandSpeedMps.toFixed(2)+' m/s':'--';
      this.renderRunningBar();
      if(this.storageError)this.notice(this.storageError,true);
      else if(BoatAuth.enabled===false)this.notice('航线任务需要在服务器启用平台账户，并使用管理员登录。');
      else if(!this.admin)this.notice('航线任务界面仅供管理员使用。');
    }
    renderRunningBar(){
      const bar=$('missionActiveBar'),runs=this.admin?this.runs.filter(r=>r.active):[],keys=new Set(runs.map(r=>r.runId));bar.hidden=!runs.length;
      for(const [key,value]of this.activeRows)if(!keys.has(key)){value.row.remove();this.activeRows.delete(key);}
      for(const run of runs){
        let item=this.activeRows.get(run.runId);
        if(!item){
          const row=document.createElement('div');row.className='mission-active-item';const text=document.createElement('p'),name=document.createElement('strong'),message=document.createElement('span');name.textContent=run.deviceId+' · '+run.routeName;text.append(name,message);row.append(text);
          const buttons=document.createElement('div');buttons.className='mission-actions';buttons.style.marginTop='0';const a=document.createElement('a');a.href='#missions';a.textContent='任务页面';a.onclick=event=>{event.preventDefault();Promise.resolve(window.boatMonitor?.selectBoat(run.deviceId,false)).then(()=>BoatWorkspace.navigate('missions')).catch(error=>this.notice(error.message,true));};buttons.append(a);
          const b=document.createElement('button');b.type='button';b.className='small-button mission-danger';b.textContent='停止 '+run.deviceId;b.onclick=()=>this.stop(run).catch(error=>this.notice(error.message,true));buttons.append(b);row.append(buttons);bar.append(row);
          item={row,message,button:b};this.activeRows.set(run.runId,item);
        }
        item.message.textContent=this.statusError||run.message;item.button.disabled=!this.admin||this.stops.has(run.deviceId)||run.status==='stopping';
      }
    }
    async initializeMap(){
      if(window.BoatWorkspace?.canAccessView&&!BoatWorkspace.canAccessView('missions'))return;
      if(this.map){this.map.invalidateSize();return;}
      this.map=new BoatMapView('missionMap');
      this.map.on('click',p=>{const r=this.run();if(this.editing&&!(r?.active&&r.routeId===this.route.id))this.addPoint(p);});
      this.map.on('status',s=>{$('missionMapStatus').textContent=s.message;});
      this.map.on('providerchange',()=>this.draw());
      await this.map.initialize();this.draw();this.fit();
    }
    draw(){
      if(!this.map?.ready)return;
      const points=this.route.points,run=this.run(),current=run?.active&&run.routeId===this.route.id&&!this.dirty?run.targetIndex:-1;
      const key=JSON.stringify([points,current,this.map.provider]);
      if(key!==this.drawKey){
        this.drawKey=key;for(const m of this.markers)m.remove();this.markers=[];
        this.map.setTrackLines(points.length>1?[{points,color:'#467dff',width:3}]:[]);
        points.forEach((p,i)=>{
          const kind=i===0?'start':i===points.length-1?'end':'via';
          const m=this.map.createMarker(p,{className:'mission-pin',html:'<span data-kind="'+kind+'" data-current="'+(i===current)+'">'+(i+1)+'</span>',iconSize:[28,28],iconAnchor:[14,14],bubble:false,interactive:true,title:'航点 '+(i+1),onClick:()=>this.map.setView(p,Math.max(this.map.getZoom(),17))});if(m)this.markers.push(m);
        });
      }
      if(this.position){
        if(this.boatMarker)this.boatMarker.setPosition(this.position);
        else this.boatMarker=this.map.createMarker(this.position,{className:'mission-boat-pin',html:'<span>▲</span>',iconSize:[26,26],iconAnchor:[13,13],interactive:false,title:'当前实时船位'});
      }else{this.boatMarker?.remove();this.boatMarker=null;}
    }
    fit(){if(this.route.points.length)this.map?.fitLocations(this.route.points,{maxZoom:18,padding:[35,35]});else if(this.position)this.map?.setView(this.position,17);}
  }
  window.BoatMissions=new BoatMissionPanel();
})();
