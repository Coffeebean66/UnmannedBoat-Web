/* 任务组预览只编辑本组的航线副本，拖动期间使用草稿，明确保存才发送服务器。 */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),clone=x=>JSON.parse(JSON.stringify(x));
  class MissionQueuePreview {
    constructor(owner){
      this.owner=owner;this.index=0;this.editing=false;this.pointsVisible=true;this.markers=[];this.geometryCache=new Map();
      $('missionQueuePreviewRoute').onchange=()=>this.select(Number($('missionQueuePreviewRoute').value));
      $('missionQueueFit').onclick=()=>this.fit();
      $('missionQueueEdit').onclick=()=>{if(!owner.canEdit())return;this.cancelDrag(false);this.editing=!this.editing;if(this.editing)this.pointsVisible=true;this.render();};
      $('missionQueueWaypoints').onclick=()=>{this.cancelDrag(false);this.pointsVisible=!this.pointsVisible;if(!this.pointsVisible)this.editing=false;this.render();};
      $('missionQueueAlign').onclick=()=>{
        if(!this.editable()||this.index<1)return;
        const previous=this.routes[this.index-1],end=previous.loopEnabled?previous.points[0]:previous.points.at(-1);
        Object.assign(this.route.points[0],end);owner.changed();owner.notice('本航线副本起点已对齐上一条的完成位置，请核对曲线和转场后保存队列。');
      };
      $('missionQueueMapProvider').onclick=()=>{if(!this.map)return;this.map.switchProvider(this.map.provider==='osm'?'arcgis':'osm').catch(error=>owner.notice(error.message,true));};
      document.addEventListener('keydown',event=>{if(event.code==='Escape'&&this.drag){event.preventDefault();event.stopPropagation();this.cancelDrag();}},true);
      window.addEventListener('blur',()=>this.cancelDrag());
      document.addEventListener('visibilitychange',()=>{if(document.hidden)this.cancelDrag();});
      window.addEventListener('boat-view-change',()=>{if(!this.visible())this.cancelDrag();else this.initialize();});
      window.addEventListener('boat-theme-change',()=>this.map?.setTheme(document.documentElement.dataset.theme));
      this.resize=new ResizeObserver(()=>{if(this.visible())this.initialize();else this.cancelDrag();});this.resize.observe($('missionQueueMap'));
      window.addEventListener('pagehide',()=>{this.endDrag();this.resize.disconnect();this.map?.destroy();});
    }
    get routes(){return this.owner.queue.routes||[];}
    get route(){return this.routes[this.index];}
    color(index){
      // 黄金角分配色相，32 条航线各自有颜色，重排后按执行序号重新标色。
      const h=(index*137.508+214)%360,s=.72,l=.59,a=s*Math.min(l,1-l);
      return '#'+[0,8,4].map(n=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');}).join('');
    }
    visible(){const box=$('missionQueueMap').getBoundingClientRect();return !document.hidden&&box.width>0&&box.height>0&&this.owner.m.admin;}
    editable(){return this.editing&&this.pointsVisible&&this.owner.canEdit()&&!!this.route;}
    select(index){this.cancelDrag(false);this.index=Math.max(0,Math.min(this.routes.length-1,index||0));this.render();}
    geometry(route,index){
      const key=JSON.stringify([route.points,route.segments]),cached=this.geometryCache.get(index);
      if(cached?.key===key)return cached.path;
      let path;try{
        const nav=BoatModules.missionNavigation;path=BoatModules.missionPath.compile(route);
        for(let i=1;i<route.points.length;i++){
          const start=route.points[i-1],end=route.points[i],distance=nav.distance(start,end);
          if(distance<.5||distance>20000)throw Error('相邻航点距离须为 0.5 米—20 千米');
          const segment=route.segments?.[i-1];if(segment?.type==='curve'){
            const control=segment.control,projection=nav.guide(control,start,end,0);
            if(nav.distance(start,control)>20000||nav.distance(end,control)>20000||projection.alongM<-.01||projection.alongM>projection.lengthM+.01)throw Error('弯曲控制点须位于航段两端之间，且距两端均不超过 20 千米');
          }
        }
        if(path.segments.some(s=>s.lengthM>20000))throw Error('曲线航段长度不能超过 20 千米，请增加航点拆分');
      }catch(error){path={...(path||{points:[],segments:[],lengthM:0}),error:error.message};}
      this.geometryCache.set(index,{key,path});return path;
    }
    async initialize(){
      if(!this.visible())return;
      if(this.map){this.map.invalidateSize();this.draw();return;}
      this.map=new BoatMapView('missionQueueMap');
      this.map.on('rotationchange',()=>this.cancelDrag());
      this.map.on('status',status=>{$('missionQueueMapStatus').textContent=status.message;});
      this.map.on('providerchange',()=>{this.drawKey='';this.draw();});
      this.map.on('switching',value=>{if(value)this.cancelDrag();this.drawKey='';});
      try{await this.map.initialize();this.draw();this.fit();}catch(error){this.owner.notice(error.message,true);}
    }
    dragValid(session){return this.drag===session&&this.owner.queue===session.queue&&this.route===session.route&&this.owner.m.generation===session.generation&&this.editable()&&this.map?.ready&&!this.map.switching&&this.visible();}
    point(value){return value&&Number.isFinite(value.latitude)&&Number.isFinite(value.longitude)&&Math.abs(value.latitude)<=85&&Math.abs(value.longitude)<=180?{latitude:Number(value.latitude.toFixed(7)),longitude:Number(value.longitude.toFixed(7))}:null;}
    dragOptions(kind,index){
      const queue=this.owner.queue,route=this.route,generation=this.owner.m.generation;let session;
      return {draggable:this.editable(),
        onDragStart:(_point,marker)=>{
          if(this.drag||queue!==this.owner.queue||route!==this.route||generation!==this.owner.m.generation||!this.editable())return false;
          session=this.drag={queue,route,generation,kind,index,preview:clone(route),marker};marker.getElement()?.classList.add('mission-dragging');this.owner.render();return true;
        },
        onDrag:value=>{
          if(!session)return;if(!this.dragValid(session))return this.cancelDrag();const point=this.point(value);if(!point)return;
          Object.assign(kind==='point'?session.preview.points[index]:session.preview.segments[index].control,point);
          if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;if(this.dragValid(session))this.drawLines(session.preview);});
        },
        onDragEnd:value=>{
          if(!session)return;if(!this.dragValid(session))return this.cancelDrag();const point=this.point(value);
          if(!point)return this.cancelDrag();this.endDrag();Object.assign(kind==='point'?route.points[index]:route.segments[index].control,point);
          this.owner.changed();this.owner.notice('任务组航点副本已修改，请保存队列；原航线保持原样。');
        },
        onDragCancel:()=>{if(session&&this.drag===session)this.cancelDrag();}
      };
    }
    endDrag(){if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;this.drag?.marker.getElement()?.classList.remove('mission-dragging');this.drag=null;this.drawKey='';}
    cancelDrag(announce=true){if(!this.drag)return;this.endDrag();this.owner.render();if(announce)this.owner.notice('已取消拖动，保留之前的任务组草稿。');}
    drawLines(preview){
      if(!this.map?.ready)return;const lines=[];
      this.routes.forEach((saved,i)=>{
        const route=i===this.index&&preview?preview:saved,color=this.color(i),path=this.geometry(route,i);
        if(path.points.length>1)lines.push({points:path.points,color,width:i===this.index?5:3,className:'mission-queue-route-line',routeIndex:i});
        if(route.loopEnabled)lines.push({points:[route.points.at(-1),route.points[0]],color,width:2,dashed:true,className:'mission-queue-loop-line'});
        const nextIndex=(i+1)%this.routes.length,next=this.routes[i+1]||(this.owner.queue.loopEnabled?this.routes[0]:null);
        if(next){const end=route.loopEnabled?route.points[0]:route.points.at(-1),start=nextIndex===this.index&&preview?preview.points[0]:next.points[0];
          lines.push({points:[end,start],color:'#929cab',width:2,dashed:true,behind:true,className:'mission-queue-transfer-line'});
        }
        if(this.editable()&&i===this.index)route.segments?.forEach((s,j)=>{if(s.type==='curve')lines.push({points:[route.points[j],s.control,route.points[j+1]],color,width:1,dashed:true,className:'mission-queue-curve-guide'});});
      });
      this.map.setTrackLines(lines);
    }
    draw(){
      if(!this.map?.ready)return;
      if(this.drag){if(!this.dragValid(this.drag)){this.cancelDrag();return;}this.drawLines(this.drag.preview);return;}
      const key=JSON.stringify([this.owner.deviceId,this.owner.m.generation,this.routes,this.owner.queue.loopEnabled,this.index,this.editable(),this.pointsVisible,this.map.provider]);
      if(key===this.drawKey&&this.markerQueue===this.owner.queue)return;
      this.drawKey=key;this.markerQueue=this.owner.queue;for(const marker of this.markers)marker.remove();this.markers=[];this.drawLines();
      if(!this.owner.m.admin)return;
      if(this.pointsVisible&&this.route){
        this.route.points.forEach((point,i)=>{
          const marker=this.map.createMarker(point,{className:'mission-queue-pin',html:'<span style="background:'+this.color(this.index)+'">'+(i+1)+'</span>',iconSize:[28,28],iconAnchor:[14,14],interactive:true,bubble:false,title:'航线 '+(this.index+1)+' 副本 · 航点 '+(i+1),...this.dragOptions('point',i)});if(marker)this.markers.push(marker);
        });
        if(this.editable())this.route.segments?.forEach((s,i)=>{if(s.type!=='curve')return;
          const marker=this.map.createMarker(s.control,{className:'mission-queue-pin mission-queue-control-pin',html:'<span style="background:'+this.color(this.index)+'">◇</span>',iconSize:[26,26],iconAnchor:[13,13],interactive:true,bubble:false,title:'航线 '+(this.index+1)+' 副本 · 弯曲控制点',...this.dragOptions('curve',i)});if(marker)this.markers.push(marker);
        });
      }
    }
    render(){
      const owner=this.owner,q=owner.queue;
      if(this.queue!==q||this.deviceId!==owner.deviceId){this.endDrag();this.queue=q;this.deviceId=owner.deviceId;this.editing=false;this.index=Math.min(this.index,Math.max(0,this.routes.length-1));this.geometryCache.clear();}
      this.index=Math.min(this.index,Math.max(0,this.routes.length-1));
      if(!owner.canEdit())this.editing=false;
      if(this.drag&&!this.dragValid(this.drag))this.endDrag();
      const signature=JSON.stringify([this.routes.map(r=>r.name),this.index]);
      if(signature!==this.selectKey){
        this.selectKey=signature;$('missionQueuePreviewRoute').replaceChildren(...(this.routes.length?this.routes.map((r,i)=>new Option((i+1)+' · '+r.name,String(i))):[new Option('请先添加航线','')]));
        $('missionQueuePreviewRoute').value=this.routes.length?String(this.index):'';
        const legend=$('missionQueueLegend');legend.replaceChildren();this.routes.forEach((route,i)=>{const b=document.createElement('button');b.type='button';b.className='mission-queue-legend-item';b.style.setProperty('--queue-route-color',this.color(i));b.textContent=(i+1)+' · '+route.name;b.setAttribute('aria-pressed',String(i===this.index));b.onclick=()=>this.select(i);legend.append(b);});
      }
      $('missionQueuePreviewRoute').disabled=!!this.drag||!this.routes.length;
      $('missionQueueEdit').disabled=!owner.canEdit()||!this.route;$('missionQueueEdit').setAttribute('aria-pressed',String(this.editing));$('missionQueueEdit').textContent=this.editing?'完成航点编辑':'编辑航点';
      $('missionQueueWaypoints').setAttribute('aria-pressed',String(this.pointsVisible));$('missionQueueWaypoints').textContent=this.pointsVisible?'隐藏航点':'显示航点';
      $('missionQueueAlign').disabled=!this.editable()||this.index<1||!!this.drag;
      $('missionQueueRouteInfo').textContent=this.route?this.route.points.length+' 个航点 · '+this.route.speedMps+' m/s · 半径 '+this.route.arrivalRadiusM+' m · '+(this.route.loopEnabled?'本航线循环 '+this.route.loopCount+' 圈':'单次')+' · 独立副本':'选择一条航线查看航点。';
      const errors=this.routes.flatMap((r,i)=>{const error=this.geometry(r,i).error;return error?['航线 '+(i+1)+'：'+error]:[];});
      $('missionQueuePreviewError').textContent=errors.join('；');$('missionQueuePreviewError').hidden=!errors.length;
      this.renderPoints();this.draw();
      if(this.visible())this.initialize();
    }
    renderPoints(){
      const route=this.route,queue=this.owner.queue,key=JSON.stringify([route,this.editable(),!!this.drag]);
      if(key===this.pointsKey&&this.formRoute===route&&this.formQueue===queue)return;
      this.pointsKey=key;this.formRoute=route;this.formQueue=queue;const list=$('missionQueuePoints');list.replaceChildren();if(!route)return;
      const valid=()=>this.owner.queue===queue&&this.route===route&&this.editable()&&!this.drag;
      const coordinate=(row,point,key,label,max)=>{
        const field=document.createElement('label');field.textContent=label;const input=document.createElement('input');input.type='number';input.step='0.0000001';input.min=-max;input.max=max;input.value=point[key].toFixed(7);input.disabled=!valid();input.setAttribute('aria-label','任务组航线 '+(this.index+1)+' '+label+' WGS84');
        input.onchange=()=>{if(!valid())return;const n=Number(input.value);if(!input.value.trim()||!Number.isFinite(n)||Math.abs(n)>max){input.value=point[key].toFixed(7);return this.owner.notice('请输入有效的 WGS84 经纬度。',true);}point[key]=n;this.owner.changed();this.owner.notice('已修改本任务组副本，请保存队列。');};field.append(input);row.append(field);
      };
      route.points.forEach((point,i)=>{const row=document.createElement('li'),title=document.createElement('strong');row.className='mission-queue-point-row';row.dataset.pointIndex=String(i);title.textContent=(i+1)+' · '+(i===0?'起点':i===route.points.length-1?'终点':'航点');row.append(title);
        coordinate(row,point,'latitude','航点 '+(i+1)+' 纬度',85);coordinate(row,point,'longitude','航点 '+(i+1)+' 经度',180);
        const segment=route.segments?.[i-1];if(segment?.type==='curve'){coordinate(row,segment.control,'latitude','弯点 '+i+' 纬度',85);coordinate(row,segment.control,'longitude','弯点 '+i+' 经度',180);}list.append(row);
      });
    }
    fit(){if(!this.map?.ready)return;const points=this.routes.flatMap((r,i)=>this.geometry(r,i).points.length?this.geometry(r,i).points:r.points);if(points.length)this.map.fitLocations(points,{maxZoom:18,padding:[35,35]});}
  }
  window.BoatMissionQueuePreview=MissionQueuePreview;
})();
