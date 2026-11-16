/* 任务实测轨迹：显隐只影响画面，清除写入服务器；始终不改变船只的运动控制。 */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const labels={preparing:'等待任务接管',running:'任务执行中',paused:'已暂停',completed:'已完成',stopped:'已停止',failed:'任务异常',interrupted:'服务器已重启 / 停止'};
  class MissionTrackPanel{
    constructor(){
      this.selection='';this.visible=true;this.track=null;this.generation=0;this.attached=new WeakSet();this.drawKeys=new WeakMap();
      $('missionTrackSelect').onchange=()=>{this.selection=$('missionTrackSelect').value;this.track=null;this.error='';this.notice='';this.cancel();this.cancelClear();this.sync();};
      $('missionTrackToggle').onclick=()=>{this.visible=!this.visible;this.render();};
      $('missionTrackClear').onclick=()=>this.clear();
      $('missionTrackFit').onclick=()=>{
        const points=this.track?.chunks.flatMap(c=>c.points)||[];
        if(points.length){this.visible=true;this.render();window.BoatMissions?.map?.fitLocations(points,{maxZoom:18,padding:[35,35]});}
      };
      window.addEventListener('boat-mission-change',()=>this.sync());
      window.addEventListener('boat-view-change',()=>this.render());
      window.addEventListener('pagehide',()=>{this.cancel();this.cancelClear();});this.sync();
    }
    get missions(){return window.BoatMissions;}
    selectLatest(){this.selection='';this.visible=true;this.notice='';this.sync();}
    cancel(){this.generation++;this.controller?.abort();this.controller=null;this.pending='';}
    cancelClear(){this.clearing?.controller.abort();this.clearing=null;}
    async clear(){
      const m=this.missions,s=this.summary;
      if(this.clearing||!m?.admin||!s?.pointCount)return;
      const continuation=['preparing','running'].includes(s.status)?'任务会继续运行，后续按原设置重新记录。':s.status==='paused'?'任务保持暂停，继续后按原设置重新记录。':'记录名称和任务信息会保留。';
      if(!window.confirm('清除“'+s.name+'”当前已记录的 '+s.pointCount+' 个实测点？服务器中的这些轨迹点会被清空。'+continuation))return;
      this.cancel();const operation={deviceId:m.deviceId,id:s.id,scope:this.scope,controller:new AbortController()};
      this.clearing=operation;this.error='';this.notice='';this.render();
      const current=()=>this.clearing===operation&&this.scope===operation.scope&&this.missions?.deviceId===operation.deviceId&&this.summary?.id===operation.id&&this.missions?.admin;
      const timer=setTimeout(()=>operation.controller.abort(),5000);
      try{
        const result=await m.request('/tracks/clear',{method:'POST',body:JSON.stringify({deviceId:operation.deviceId,id:operation.id}),signal:operation.controller.signal});
        if(!current())return;
        this.track=result.track;m.trackSummaries=result.tracks;m.trackStorage=result.recording;
        this.notice='当前轨迹已清除并保存到服务器。'+continuation;this.sync();
      }catch(error){
        if(current())this.error=error.name==='AbortError'?'清除请求超时，结果待确认，请刷新任务记录':error.message;
      }finally{
        clearTimeout(timer);
        if(this.clearing===operation){this.clearing=null;this.render();if(this.scope===operation.scope)m.poll(true);}
      }
    }
    isShowing(map){return !!this.missions?.admin&&this.visible&&!!this.summary&&this.track?.id===this.summary.id&&!!map;}
    sync(){
      const m=this.missions,key=JSON.stringify([m?.deviceId,window.BoatAuth?.generation,m?.admin]);
      if(key!==this.scope){this.scope=key;this.cancel();this.cancelClear();this.selection='';this.track=null;this.error='';this.notice='';}
      this.summaries=m?.admin?m.trackSummaries||[]:[];
      if(this.selection&&!this.summaries.some(t=>t.id===this.selection))this.selection='';
      const previousId=this.summary?.id;
      this.summary=this.summaries.find(t=>t.id===this.selection)||this.summaries[0]||null;
      if(previousId!==this.summary?.id){this.cancel();this.cancelClear();this.track=null;this.error='';this.notice='';}
      const signature=JSON.stringify(this.summaries.map(t=>[t.id,t.name,t.startedAt]));
      if(signature!==this.optionsKey){
        this.optionsKey=signature;$('missionTrackSelect').replaceChildren(new Option('最近一次记录',''),...this.summaries.map(t=>new Option(t.name+' · '+new Date(t.startedAt).toLocaleString('zh-CN',{hour12:false}),t.id)));
      }
      $('missionTrackSelect').value=this.selection;
      this.render();
      const summary=this.summary;
      // 摘要随原任务轮询更新；只有点数/状态改变才重新读取坐标，不重复拉取静态历史。
      if(this.clearing||!m?.admin||!summary||this.track?.id===summary.id&&this.track.revision===summary.revision)return;
      const pending=summary.id+':'+summary.revision;if(this.pending?.startsWith(summary.id+':'))return;
      this.load(summary,pending);
    }
    async load(summary,pending){
      this.cancel();const generation=this.generation,deviceId=this.missions.deviceId,controller=new AbortController();this.controller=controller;this.pending=pending;
      const timer=setTimeout(()=>controller.abort(),5000);
      try{
        const result=await this.missions.request('/tracks?deviceId='+encodeURIComponent(deviceId)+'&id='+encodeURIComponent(summary.id),{signal:controller.signal});
        if(generation!==this.generation||this.summary?.id!==summary.id||deviceId!==this.missions.deviceId)return;
        this.track=result.track;this.error='';this.render();
      }catch(error){
        if(generation===this.generation){this.error=error.name==='AbortError'?'任务轨迹读取超时，正在重试':error.message;this.render();}
      }finally{clearTimeout(timer);if(generation===this.generation){this.controller=null;this.pending='';}}
    }
    render(){
      const m=this.missions,s=this.summary;
      $('missionTrackSelect').disabled=!m?.admin||!this.summaries?.length||!!this.clearing;
      $('missionTrackToggle').disabled=!s;$('missionTrackToggle').textContent=this.visible?'隐藏实测轨迹':'显示实测轨迹';$('missionTrackToggle').setAttribute('aria-pressed',String(this.visible));
      $('missionTrackFit').disabled=!this.track?.pointCount||!!this.clearing;
      $('missionTrackClear').disabled=!m?.admin||!s?.pointCount||!!this.clearing||!!m?.statusError||!!m?.trackStorage?.storageError;
      $('missionTrackClear').textContent=this.clearing?'正在清除…':'清除当前轨迹';
      $('missionTrackClear').title='清空当前记录在服务器保存的实测点；任务继续，后续按原规则重新记录。';
      $('missionTrackState').textContent=m?.statusError?'状态同步中断':s?labels[s.status]||'记录状态未知':'暂无记录';
      $('missionTrackSummary').textContent=s?s.name+' · '+s.pointCount+' 个实测点 · '+(s.recording?'实线段 · 正在记录':s.status==='running'?s.clearedAt&&!s.pointCount?'轨迹已清空 · 后续按实线航段记录':'虚线 / 转场 / 返回段 · 暂不记录':labels[s.status]||'等待中')+(s.truncated?' · 较早轨迹已裁剪':''):'点击“开始任务并记录轨迹”后生成独立记录。';
      const storage=m?.trackStorage;
      $('missionTrackStatus').textContent=storage?.storageError||this.error||m?.statusError||(this.clearing?'正在清除当前轨迹并保存到服务器…':this.notice)||(s?(storage?.persistent?'服务器保存；刷新后可重新查看。':'当前为内存记录，服务器重启后清空。')+'绿色实测线按航段分开，跳过的航程不会连线。':'虚线段、前往起点、自动返回和转场段不计入任务轨迹。遥测历史仍按原方式保存。');
      $('missionTrackStatus').dataset.error=String(!!storage?.storageError||!!this.error||!!m?.statusError);
      this.draw();window.dispatchEvent(new CustomEvent('boat-mission-track-change'));
    }
    draw(){
      const maps=[this.missions?.map,window.boatMonitor?.map,window.BoatMissionQueue?.preview?.map].filter(Boolean);
      for(const map of maps){
        if(!this.attached.has(map)){this.attached.add(map);const restore=()=>{this.drawKeys.delete(map);this.draw();};map.on('ready',restore);map.on('providerchange',restore);}
        const show=this.isShowing(map),key=JSON.stringify([show,this.track?.id,this.track?.revision,map.provider,map.ready]);
        if(this.drawKeys.get(map)===key)continue;this.drawKeys.set(map,key);
        const lines=show?this.track.chunks.filter(c=>c.points.length>1).map(c=>({points:c.points.map(p=>({latitude:p.latitude,longitude:p.longitude})),color:'#10a987',width:4,className:'mission-recorded-track'})):[];
        map.setOverlayLines('mission-recording',lines);
      }
    }
  }
  window.BoatMissionTracks=new MissionTrackPanel();
})();
