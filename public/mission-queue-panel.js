/* 多航线队列只在明确点击时保存或启动，执行和轮次推进由服务器负责。 */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),copy=x=>JSON.parse(JSON.stringify(x));
  class MissionQueuePanel {
    constructor(){
      this.deviceId='';this.queue=this.blank();this.dirty=false;this.drafts=new Map();
      $('missionQueueSelect').onchange=()=>this.load($('missionQueueSelect').value);
      $('missionQueueNew').onclick=()=>{this.queue=this.blank();this.dirty=false;this.remember();this.fill();this.render();};
      for(const id of ['missionQueueName','missionQueueLoopEnabled','missionQueueLoopCount'])$(id).oninput=()=>{
        this.queue.name=$('missionQueueName').value;this.queue.loopEnabled=$('missionQueueLoopEnabled').checked;this.queue.loopCount=Number($('missionQueueLoopCount').value);
        if(!this.queue.loopEnabled&&(!Number.isSafeInteger(this.queue.loopCount)||this.queue.loopCount<1||this.queue.loopCount>999)){this.queue.loopCount=1;$('missionQueueLoopCount').value=1;}this.changed();
      };
      $('missionQueueAdd').onclick=()=>{
        const id=$('missionQueueRoute').value;if(!this.m.routes.some(r=>r.id===id))return;
        if(this.queue.routeIds.length>=32)return this.notice('每个任务队列最多 32 条航线',true);
        this.queue.routeIds.push(id);this.changed();
      };
      $('missionQueueSave').onclick=()=>this.perform(()=>this.save());
      $('missionQueueDelete').onclick=()=>this.perform(()=>this.remove());
      for(const [id,action]of [['missionQueueGoto','queueGoto'],['missionQueueStart','queueStart']])$(id).onclick=()=>this.perform(()=>this.execute(action));
      for(const [id,action]of [['missionQueuePause','pause'],['missionQueueResume','resume']])$(id).onclick=()=>this.perform(()=>this.m.submitNavigation(action));
      $('missionQueueStop').onclick=()=>{const run=this.m.run();if(run?.queue)this.m.stop(run).catch(error=>this.notice(error.message,true));};
      window.addEventListener('boat-mission-change',()=>this.sync());
      this.sync();
    }
    get m(){return window.BoatMissions;}
    blank(){return {name:'新任务队列',routeIds:[],loopEnabled:false,loopCount:1};}
    remember(){if(this.deviceId)this.drafts.set(this.deviceId,{queue:copy(this.queue),dirty:this.dirty});}
    sync(){
      const auth=String(window.BoatAuth?.generation);
      if(this.auth!==auth){this.auth=auth;this.deviceId='';this.drafts.clear();this.queue=this.blank();this.dirty=false;this.fill();this.notice('');}
      if(this.deviceId!==this.m.deviceId){
        this.remember();this.deviceId=this.m.deviceId;const draft=this.drafts.get(this.deviceId);
        this.queue=draft?copy(draft.queue):this.blank();this.dirty=!!draft?.dirty;this.fill();this.notice('');
      }
      if(this.m.admin&&!this.queue.id&&!this.dirty&&!this.queue.routeIds.length&&!this.drafts.has(this.deviceId)&&this.m.queues.length)this.load(this.m.queues[0].id);
      else this.render();
    }
    fill(){
      $('missionQueueName').value=this.queue.name;$('missionQueueLoopEnabled').checked=this.queue.loopEnabled;$('missionQueueLoopCount').value=this.queue.loopCount;
    }
    load(id){
      if(this.dirty&&!window.confirm('放弃当前未保存的队列修改？')){$('missionQueueSelect').value=this.queue.id||'';return;}
      const saved=this.m.queues.find(q=>q.id===id);this.queue=saved?copy(saved):this.blank();this.dirty=false;this.remember();this.fill();this.notice('');this.render();
    }
    changed(){this.dirty=true;this.remember();this.render();}
    notice(text,error=false){$('missionQueueNotice').textContent=text;$('missionQueueNotice').dataset.error=String(error);}
    perform(fn){
      const id=this.deviceId;
      return this.m.action(async()=>{try{await fn();}catch(error){if(id===this.deviceId)this.notice(error.name==='AbortError'?'请求超时，请刷新确认操作结果':error.message,true);throw error;}});
    }
    async save(){
      const m=this.m,generation=m.generation,id=this.deviceId,{name,routeIds,loopEnabled,loopCount}=this.queue;
      const data=await m.request('/queue',{method:'POST',body:JSON.stringify({deviceId:id,queue:{name,routeIds,loopEnabled,loopCount},...(this.queue.id?{id:this.queue.id,revision:this.queue.revision}:{})})});
      if(generation!==m.generation)return;
      this.queue=data.queue;this.dirty=false;this.remember();m.queues=m.queues.filter(q=>q.id!==data.queue.id).concat(data.queue);this.fill();this.render();this.notice('任务队列已保存到服务器，下次可直接调用。');
    }
    async remove(){
      const m=this.m,generation=m.generation,queue=this.queue;
      if(!queue.id||!window.confirm('删除任务队列“'+queue.name+'”？原航线会保留。'))return;
      await m.request('/queue',{method:'DELETE',body:JSON.stringify({deviceId:this.deviceId,id:queue.id,revision:queue.revision})});
      if(generation!==m.generation)return;
      m.queues=m.queues.filter(q=>q.id!==queue.id);this.queue=this.blank();this.dirty=false;this.remember();this.fill();this.render();this.notice('任务队列已删除，原航线仍可使用。');
    }
    async execute(action){
      if(this.dirty)throw Error('请先保存修改后的任务队列');
      const m=this.m,generation=m.generation,id=this.deviceId;
      if(m.dirty&&this.queue.routeIds.includes(m.route.id))throw Error('队列中的航线有未保存修改，请先保存航线');
      const routeRevisions=this.queue.routeIds.map(id=>m.routes.find(r=>r.id===id)?.revision);
      const data=await m.request('/run',{method:'POST',body:JSON.stringify({deviceId:id,action,queueId:this.queue.id,revision:this.queue.revision,routeRevisions})});
      if(generation!==m.generation)return;
      m.runs=m.runs.filter(r=>r.deviceId!==id).concat(data.run);m.render();
      this.notice(action==='queueGoto'?'正在前往首条航线起点，到达后停止。':'队列已交给服务器，关闭网页后继续执行。');
    }
    render(){
      const m=this.m,q=this.queue,run=m.run(),active=!!run?.active,paused=run?.status==='paused',own=!!run?.queue&&run.queue.id===q.id;
      const locked=m.busy||!m.admin||!this.deviceId,editingLocked=locked||(active&&own);
      const valid=q.routeIds.length>0&&q.routeIds.length<=32&&q.routeIds.every(id=>m.routes.some(r=>r.id===id))&&Number.isSafeInteger(q.loopCount)&&q.loopCount>=1&&q.loopCount<=999;
      const signature=JSON.stringify([m.queues.map(q=>[q.id,q.name,q.revision]),m.routes.map(r=>[r.id,r.name,r.revision])]);
      if(signature!==this.optionsKey){
        this.optionsKey=signature;const old=$('missionQueueRoute').value;
        $('missionQueueSelect').replaceChildren(new Option('新任务队列',''),...m.queues.map(q=>new Option(q.name,q.id)));
        $('missionQueueRoute').replaceChildren(new Option('请选择已保存航线',''),...m.routes.map(r=>new Option(r.name,r.id)));
        if(m.routes.some(r=>r.id===old))$('missionQueueRoute').value=old;
      }
      $('missionQueueSelect').value=q.id||'';
      for(const id of ['missionQueueNew','missionQueueSelect'])$(id).disabled=locked;
      for(const id of ['missionQueueName','missionQueueLoopEnabled','missionQueueRoute'])$(id).disabled=editingLocked;
      $('missionQueueLoopCount').disabled=editingLocked||!q.loopEnabled;
      $('missionQueueAdd').disabled=editingLocked||!m.routes.length||q.routeIds.length>=32;
      $('missionQueueSave').disabled=editingLocked||!valid||!!m.storageError;
      $('missionQueueDelete').disabled=editingLocked||!q.id;
      const unavailable=locked||active||this.dirty||!q.id||!valid||!!m.storageError||!!m.statusError;
      $('missionQueueGoto').disabled=$('missionQueueStart').disabled=unavailable;
      $('missionQueuePause').disabled=locked||!own||!active||run.status==='stopping';
      $('missionQueueResume').disabled=locked||!own||!paused||!run.resumable||!!m.statusError;
      $('missionQueueStop').disabled=!m.admin||!own||(!active&&!paused)||run.status==='stopping'||m.stops.has(this.deviceId);
      $('missionQueueHelp').textContent=q.loopEnabled?'首条 → 依次执行 → 末条 → 返回首条起点算一轮；最后一轮也返回起点后停止。':'按列表依次执行，每条航线保留自己的循环设置；整组只执行一次。';
      $('missionQueueSummary').textContent=q.routeIds.length+' 条航线 · '+(this.dirty?'有未保存修改':q.id?'已保存 v'+q.revision:'尚未保存')+(m.dirty&&q.routeIds.includes(m.route.id)?' · 请先保存航线修改':'');
      $('missionQueueProgress').textContent=run?.queue?m.statusError?'队列状态同步中断，请刷新':m.runTitle(run)+' · '+(run.queue.currentLoop===null?'前往起点':'第 '+run.queue.currentLoop+' / '+run.queue.loopCount+' 轮，已完成 '+run.queue.completedLoops+' 轮')+' · '+run.message:'当前没有执行中的任务队列';
      const key=JSON.stringify([q.routeIds,m.routes.map(r=>[r.id,r.name,r.speedMps,r.loopEnabled,r.loopCount]),editingLocked,own&&run?.queue?.routeIndex,active,paused]);
      if(key!==this.listKey){
        this.listKey=key;const list=$('missionQueueList');list.replaceChildren();$('missionQueueEmpty').hidden=q.routeIds.length>0;
        q.routeIds.forEach((id,index)=>{
          const route=m.routes.find(r=>r.id===id),row=document.createElement('li');row.className='mission-queue-row';row.dataset.current=String(own&&(active||paused)&&run.queue.routeIndex===index);
          const label=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('span');
          name.textContent=(index+1)+' · '+(route?.name||'航线已不存在，请移除');detail.textContent=route?route.speedMps+' m/s · '+(route.loopEnabled?'自身循环 '+route.loopCount+' 圈':'单次'):'请选择有效航线';label.append(name,detail);row.append(label);
          const tools=document.createElement('div');tools.className='mission-point-tools';
          for(const [text,offset]of [['↑',-1],['↓',1],['移除',0]]){
            const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-label','队列第 '+(index+1)+' 条航线'+text);
            button.disabled=editingLocked||(offset===-1&&index===0)||(offset===1&&index===q.routeIds.length-1);
            button.onclick=()=>{if(offset)[q.routeIds[index],q.routeIds[index+offset]]=[q.routeIds[index+offset],q.routeIds[index]];else q.routeIds.splice(index,1);this.changed();};tools.append(button);
          }
          row.append(tools);list.append(row);
        });
      }
    }
  }
  window.BoatMissionQueue=new MissionQueuePanel();
})();
