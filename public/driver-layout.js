/* 只保存显示偏好，不保存船只接管凭据；共享仪表离开驾驶页后恢复原样。 */
(() => {
  'use strict';
  // 保留原存储键与版本，旧位置/透明度兼容；新增宽高使用 CSS 像素。
  const STORAGE='boat-driver-platform-layout-v1';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const SIZE_MIN={navigation:[280,88],hud:[240,200],angles:[180,32],horizon:[80,80],compass:[80,80],map:[160,120],video:[160,120],console:[280,180],mission:[170,100],details:[260,180],motors:[240,180],model:[260,300],emergency:[96,44]};
  const SIZE_MAX=16384;
  const PARTS=[
    ['navigation','航行读数','.driver-navigation-data'],
    ['hud','图传 HUD','#driverHud'],
    ['angles','姿态数值','.imu-euler-values'],
    ['horizon','人工地平仪','.imu-horizon-panel'],
    ['compass','航向罗盘','#compassCard'],
    ['map','地图','.driver-region-map'],
    ['video','图传','.driver-region-video'],
    ['console','驾驶控制条','.driver-console',20],
    ['mission','任务状态','.driver-mission-summary'],
    ['details','航行详情','#driverDetailsPanel'],
    ['motors','电机详情','.driver-propulsion',0,true],
    ['model','三维船体','#driverModelPreview',0,true],
    ['emergency','急停','.driver-emergency-dock',100]
  ];
  class BoatDriverLayout {
    constructor({document=window.document,onEditingChange=()=>{},onReset=()=>{}}={}) {
      this.document=document;this.root=document.getElementById('view-driving');this.stage=document.getElementById('driverStage');
      this.onEditingChange=onEditingChange;this.onReset=onReset;this.editing=false;this.selected='navigation';
      this.handlers=[];this.parts=[];this.frame=0;this.drag=null;this.destroyed=false;
      this.ui=Object.fromEntries(['driverLayoutToggle','driverLayoutEditor','driverLayoutCompact','driverLayoutControls','driverLayoutDone','driverLayoutModule','driverPartOpacity','driverPartOpacityValue','driverPartWidth','driverPartHeight','driverPartSizeReset','driverPartSizeValue','driverLayoutHint','driverLayoutFloat','driverLayoutResetPart','driverLayoutResetAll','driverLayoutSaved'].map(id=>[id,document.getElementById(id)]));
      this.profiles=this.load();
      for(const [id,label,selector,min=0,floating=false]of PARTS){
        const node=document.querySelector(selector);if(!node)continue;
        const part={id,label,node,min,floating};
        node.dataset.driverLayoutModule=id;
        // 独立仪表缩放时保留原网格占位，避免把相邻仪表挤走；离开驾驶仍为 display:contents。
        if(['angles','horizon','compass'].includes(id)){
          const slot=document.createElement('div');slot.className='driver-layout-size-slot';slot.dataset.sizeSlot=id;
          node.before(slot);slot.append(node);part.slot=slot;
        }
        if(floating){part.home=document.createComment('驾驶浮层原位置：'+id);node.before(part.home);}
        const grip=document.createElement('button');grip.type='button';grip.className='driver-layout-grip';
        grip.textContent='⠿ '+label;grip.setAttribute('aria-label','拖动'+label);grip.title='拖动调整位置，方向键微调';
        node.append(grip);part.grip=grip;this.parts.push(part);
        const option=document.createElement('option');option.value=id;option.textContent=label;this.ui.driverLayoutModule.append(option);
        this.listen(grip,'pointerdown',event=>this.startDrag(part,event));
        this.listen(grip,'pointermove',event=>this.moveDrag(event));
        this.listen(grip,'pointerup',()=>this.endDrag());
        this.listen(grip,'pointercancel',()=>this.endDrag());
        this.listen(grip,'lostpointercapture',()=>this.endDrag());
        this.listen(grip,'keydown',event=>this.nudge(part,event));
        this.listen(grip,'click',event=>{event.preventDefault();this.select(id);});
        const handle=document.createElement('button');handle.type='button';handle.className='driver-layout-resize';
        handle.setAttribute('aria-label','调整'+label+'大小');handle.title='拖动调整大小；方向键调整宽高，Shift 加速';
        handle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M12 18l6-6M17 18l1-1"/></svg>';
        node.append(handle);part.resizeHandle=handle;
        this.listen(handle,'pointerdown',event=>this.startDrag(part,event,'resize'));
        this.listen(handle,'pointermove',event=>this.moveDrag(event));
        for(const event of ['pointerup','pointercancel','lostpointercapture'])this.listen(handle,event,()=>this.endDrag());
        this.listen(handle,'keydown',event=>this.nudge(part,event,'resize'));
        this.listen(handle,'click',event=>{event.preventDefault();event.stopPropagation();this.select(id);});
      }
      this.listen(this.ui.driverLayoutToggle,'click',()=>this.setEditing(!this.editing));
      this.listen(this.ui.driverLayoutDone,'click',()=>this.setEditing(false));
      this.listen(this.ui.driverLayoutCompact,'click',()=>{
        const compact=!this.ui.driverLayoutControls.hidden;this.ui.driverLayoutControls.hidden=compact;
        this.ui.driverLayoutCompact.textContent=compact?'展开':'收起';this.ui.driverLayoutCompact.setAttribute('aria-expanded',String(!compact));
      });
      this.listen(this.ui.driverLayoutModule,'change',()=>this.select(this.ui.driverLayoutModule.value));
      this.listen(this.ui.driverPartOpacity,'input',()=>{
        const part=this.part();this.entry(part.id).opacity=clamp(Number(this.ui.driverPartOpacity.value),part.min,100);
        this.save();this.refresh();this.notify();
      });
      for(const id of ['driverPartWidth','driverPartHeight'])this.listen(this.ui[id],'change',()=>{
        const part=this.part(),box=part.node.getBoundingClientRect();
        if(this.editing&&this.canResize(part)){
          const width=this.ui.driverPartWidth.valueAsNumber,height=this.ui.driverPartHeight.valueAsNumber;
          if(Number.isFinite(width)&&Number.isFinite(height)){
            this.resizePart(part,width,height,box);this.save();this.refresh();this.notify();
          }
        }
        this.renderEditor(true);
      });
      this.listen(this.ui.driverPartSizeReset,'click',()=>{
        if(!this.editing)return;
        const part=this.part(),box=part.node.getBoundingClientRect(),entry=this.entry(part.id);
        delete entry.width;delete entry.height;this.refresh();
        if(this.canMove(part)&&box.width&&box.height)this.position(part,box.left,box.top);
        this.save();this.refresh();this.notify();
      });
      this.listen(this.ui.driverLayoutFloat,'click',()=>{
        const part=this.part(),entry=this.entry(part.id);entry.floating=!entry.floating;
        delete entry.x;delete entry.y;this.save();this.refresh();this.notify();
      });
      this.listen(this.ui.driverLayoutResetPart,'click',()=>{this.endDrag();delete this.profile()[this.selected];this.save();this.refresh();this.notify();});
      this.listen(this.ui.driverLayoutResetAll,'click',()=>{
        this.endDrag();this.profiles={};this.save();this.onReset();this.refresh();this.notify();
      });
      this.listen(window,'boat-view-change',()=>{if(!this.visible())this.setEditing(false);this.refresh();});
      this.listen(window,'resize',()=>{this.endDrag();this.schedule();});
      this.listen(window,'blur',()=>this.endDrag());
      this.observer=new ResizeObserver(()=>this.schedule());
      this.observer.observe(this.root);for(const part of this.parts)this.observer.observe(part.node);
      this.refresh();
    }
    listen(node,event,handler){node.addEventListener(event,handler);this.handlers.push([node,event,handler]);}
    visible(){return window.BoatWorkspace?.current==='driving'&&!this.root.hidden;}
    key(){return (window.innerWidth<=760?'mobile':'desktop')+':'+(this.root.dataset.focus||'dock');}
    profile(){return this.profiles[this.key()]||(this.profiles[this.key()]={});}
    entry(id){return this.profile()[id]||(this.profile()[id]={});}
    part(){return this.parts.find(part=>part.id===this.selected)||this.parts[0];}
    load(){
      const profiles={};
      try{
        const text=window.localStorage.getItem(STORAGE);if(!text||text.length>30000)return profiles;
        const value=JSON.parse(text);if(value.version!==1)return profiles;
        for(const key of ['desktop:dock','desktop:video','desktop:map','mobile:dock','mobile:video','mobile:map']){
          const sourceProfile=value.profiles?.[key];
          if(!sourceProfile||typeof sourceProfile!=='object')continue;
          const profile=profiles[key]={};
          for(const [id,,,min=0,floating=false]of PARTS){
            const source=sourceProfile[id];if(!source||typeof source!=='object')continue;
            const entry=profile[id]={};
            if(typeof source.opacity==='number'&&Number.isFinite(source.opacity))entry.opacity=clamp(source.opacity,min,100);
            if(typeof source.x==='number'&&Number.isFinite(source.x)&&typeof source.y==='number'&&Number.isFinite(source.y)){
              entry.x=clamp(source.x,0,1);entry.y=clamp(source.y,0,1);
            }
            if(floating&&source.floating===true)entry.floating=true;
            if(typeof source.width==='number'&&Number.isFinite(source.width)&&source.width>0&&typeof source.height==='number'&&Number.isFinite(source.height)&&source.height>0){
              entry.width=clamp(source.width,1,SIZE_MAX);entry.height=clamp(source.height,1,SIZE_MAX);
            }
          }
        }
      }catch(_){/* 存储不可用或旧数据损坏时使用默认布局。 */}
      return profiles;
    }
    save(){
      try{window.localStorage.setItem(STORAGE,JSON.stringify({version:1,profiles:this.profiles}));this.ui.driverLayoutSaved.textContent='已保存到当前浏览器 · 桌面 / 手机、两种主画面分别保存';}
      catch(_){this.ui.driverLayoutSaved.textContent='浏览器无法保存布局，本次调整仅在当前页面有效';}
    }
    notify(){window.dispatchEvent(new CustomEvent('boat-driver-layout-change'));}
    schedule(){if(!this.frame&&!this.destroyed)this.frame=window.requestAnimationFrame(()=>{this.frame=0;this.refresh();});}
    setEditing(enabled){
      if(enabled&&!this.visible())return;
      if(enabled===this.editing)return;
      this.endDrag();this.editing=enabled;this.root.dataset.layoutEditing=String(enabled);
      this.ui.driverLayoutEditor.hidden=!enabled;this.ui.driverLayoutToggle.setAttribute('aria-expanded',String(enabled));
      this.ui.driverLayoutToggle.textContent=enabled?'完成布局':'布局编辑';
      // 明确退出驾驶后再移动控件，编辑的方向键不会变成推进命令。
      this.onEditingChange(enabled);this.refresh();this.notify();
      if(!enabled&&this.visible())this.ui.driverLayoutToggle.focus({preventScroll:true});
    }
    select(id){if(this.parts.some(part=>part.id===id))this.selected=id;this.renderEditor(true);}
    canMove(part){
      if(this.root.dataset.focus&&(part.id==='map'||part.id==='video')&&part.id===this.root.dataset.primary)return false;
      return !part.floating||this.entry(part.id).floating===true;
    }
    canResize(part){const box=part.node.getBoundingClientRect();return this.canMove(part)&&box.width>0&&box.height>0;}
    sizeLimits(part){
      const canvas=this.stage.getBoundingClientRect(),[width,height]=SIZE_MIN[part.id];
      // 控制台缩窄时改为纵向排布；自动航行多保留任务操作的高度。
      const minHeight=part.id==='console'&&this.root.dataset.navigationMode!=='manual'?250:height;
      return {minWidth:Math.min(width,canvas.width),minHeight:Math.min(minHeight,canvas.height),maxWidth:Math.min(SIZE_MAX,canvas.width),maxHeight:Math.min(SIZE_MAX,canvas.height)};
    }
    boundedSize(part,width,height){
      const limit=this.sizeLimits(part);
      return {width:clamp(Math.round(width),limit.minWidth,limit.maxWidth),height:clamp(Math.round(height),limit.minHeight,limit.maxHeight)};
    }
    clearSize(part){
      delete part.node.dataset.driverSized;
      for(const key of ['--driver-part-width','--driver-part-height'])part.node.style.removeProperty(key);
      if(part.slot){delete part.slot.dataset.sized;part.slot.style.removeProperty('height');}
    }
    syncPortals(active){
      for(const part of this.parts.filter(part=>part.floating)){
        const floating=active&&this.entry(part.id).floating===true;
        part.node.classList.toggle('driver-layout-floating',floating);
        if(floating&&part.node.parentElement!==this.stage){this.stage.append(part.node);if(part.id==='model')part.node.open=true;}
        else if(!floating&&part.node.parentNode!==part.home.parentNode){
          part.home.after(part.node);if(part.id==='model')part.node.open=false;
        }
      }
    }
    refresh(){
      if(this.destroyed)return;
      if(this.drag&&this.drag.key!==this.key())this.endDrag();
      const active=this.visible();this.syncPortals(active);
      // 先清空偏移，再按父子顺序测量；详情被移动后，其内部模块不会累积父层位移。
      for(const part of this.parts){part.node.style.removeProperty('translate');this.clearSize(part);}
      if(!active){
        for(const part of this.parts){part.node.style.removeProperty('--driver-part-opacity');delete part.node.dataset.driverPartHidden;part.node.inert=false;}
        return;
      }
      const canvas=this.stage.getBoundingClientRect();if(!canvas.width||!canvas.height)return;
      const natural=new Map(this.parts.map(part=>[part,part.node.getBoundingClientRect()]));
      for(const part of this.parts){
        const entry=this.profile()[part.id]||{},box=natural.get(part);
        if(!this.canMove(part)||!Number.isFinite(entry.width)||!Number.isFinite(entry.height))continue;
        const size=this.boundedSize(part,entry.width,entry.height);
        if(part.slot){part.slot.dataset.sized='true';part.slot.style.height=box.height+'px';}
        part.node.dataset.driverSized='true';
        part.node.style.setProperty('--driver-part-width',size.width+'px');part.node.style.setProperty('--driver-part-height',size.height+'px');
      }
      for(const overlay of this.root.querySelectorAll('[data-driver-overlay]'))overlay.inert=!this.editing&&this.root.dataset.overlayHidden==='true';
      const depth=node=>{let result=0;for(let p=node.parentElement;p;p=p.parentElement)result++;return result;};
      for(const part of [...this.parts].sort((a,b)=>depth(a.node)-depth(b.node))){
        const box=part.node.getBoundingClientRect();
        const entry=this.profile()[part.id]||{},opacity=clamp(entry.opacity??100,part.min,100);
        part.node.style.setProperty('--driver-part-opacity',String(opacity/100));
        part.node.dataset.driverPartHidden=String(opacity===0);
        part.node.inert=!this.editing&&(opacity===0||(this.root.dataset.overlayHidden==='true'&&!!part.node.closest('[data-driver-overlay]')));
        part.grip.disabled=!this.canMove(part);
        part.resizeHandle.disabled=!this.canResize(part);
        if(this.canMove(part)&&Number.isFinite(entry.x)&&Number.isFinite(entry.y)&&box.width&&box.height){
          const x=canvas.left+entry.x*Math.max(0,canvas.width-box.width),y=canvas.top+entry.y*Math.max(0,canvas.height-box.height);
          part.node.style.translate=(x-box.left).toFixed(2)+'px '+(y-box.top).toFixed(2)+'px';
        }else if(part.node.dataset.driverSized==='true'&&box.width&&box.height){
          const base=natural.get(part),x=clamp(base.left,canvas.left,canvas.right-box.width),y=clamp(base.top,canvas.top,canvas.bottom-box.height);
          part.node.style.translate=(x-box.left).toFixed(2)+'px '+(y-box.top).toFixed(2)+'px';
        }
      }
      this.renderEditor();
    }
    renderEditor(forceSize=false){
      const part=this.part();if(!part)return;
      const entry=this.profile()[part.id]||{},opacity=clamp(entry.opacity??100,part.min,100);
      this.ui.driverLayoutModule.value=part.id;this.ui.driverPartOpacity.min=String(part.min);
      this.ui.driverPartOpacity.value=String(opacity);this.ui.driverPartOpacityValue.textContent=opacity+'%';
      this.ui.driverPartOpacity.disabled=part.id==='emergency';
      const box=part.node.getBoundingClientRect(),canResize=this.canResize(part),limit=this.sizeLimits(part);
      for(const [id,dimension,min,max]of [['driverPartWidth','width',limit.minWidth,limit.maxWidth],['driverPartHeight','height',limit.minHeight,limit.maxHeight]]){
        const input=this.ui[id];input.disabled=!canResize;input.min=String(Math.ceil(min));input.max=String(Math.floor(max));
        if(forceSize||this.document.activeElement!==input)input.value=box[dimension]?String(Math.round(box[dimension])):'';
      }
      this.ui.driverPartSizeValue.textContent=box.width&&box.height?Math.round(box.width)+' × '+Math.round(box.height)+' px':'尚未显示';
      this.ui.driverPartSizeReset.disabled=!Number.isFinite(entry.width)||!this.canMove(part);
      this.ui.driverLayoutFloat.hidden=!part.floating;
      this.ui.driverLayoutFloat.textContent=entry.floating?'收回航行详情':'移出详情，独立显示';
      const main=(part.id==='map'||part.id==='video')&&!this.canMove(part);
      this.ui.driverLayoutHint.textContent=part.id==='emergency'?'急停固定 100% 不透明，最小 96 × 44 px，可移动和调整大小。':main?'主画面始终铺满屏幕；切换为小窗后可移动和调整大小。':
        part.floating&&!entry.floating?'当前位于航行详情，可移出后单独摆放。':
        !canResize?'此模块尚未显示，请先打开“显示 → 仪表”或“航行详情”。':
        part.min?'此项最低 '+part.min+'%，保留必要操作的可见度。':'0% 完全隐藏；编辑时仍显示轮廓，便于找回。';
      for(const item of this.parts)item.node.dataset.layoutSelected=String(item===part);
    }
    startDrag(part,event,kind='move'){
      if(!this.editing||this.drag||!this.canMove(part)||event.button!==0||(kind==='resize'&&!this.canResize(part)))return;
      event.preventDefault();event.stopPropagation();this.select(part.id);
      const target=kind==='resize'?part.resizeHandle:part.grip;
      this.drag={part,kind,target,key:this.key(),pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,box:part.node.getBoundingClientRect()};
      target.setPointerCapture(event.pointerId);part.node.dataset.layoutDragging='true';
    }
    moveDrag(event){
      const drag=this.drag;if(!drag||event.pointerId!==drag.pointerId)return;
      if(drag.key!==this.key()){this.endDrag();return;}
      event.preventDefault();
      if(drag.kind==='resize')this.resizePart(drag.part,drag.box.width+event.clientX-drag.startX,drag.box.height+event.clientY-drag.startY,drag.box);
      else this.position(drag.part,drag.box.left+event.clientX-drag.startX,drag.box.top+event.clientY-drag.startY);
      this.schedule();
    }
    resizePart(part,width,height,anchor){
      const size=this.boundedSize(part,width,height),canvas=this.stage.getBoundingClientRect(),entry=this.entry(part.id);
      entry.width=size.width;entry.height=size.height;
      const availableX=Math.max(0,canvas.width-size.width),availableY=Math.max(0,canvas.height-size.height);
      entry.x=availableX?clamp((anchor.left-canvas.left)/availableX,0,1):0;
      entry.y=availableY?clamp((anchor.top-canvas.top)/availableY,0,1):0;
    }
    position(part,left,top){
      const canvas=this.stage.getBoundingClientRect(),box=part.node.getBoundingClientRect(),entry=this.entry(part.id);
      const width=Math.max(0,canvas.width-box.width),height=Math.max(0,canvas.height-box.height);
      entry.x=width?clamp((left-canvas.left)/width,0,1):0;entry.y=height?clamp((top-canvas.top)/height,0,1):0;
    }
    endDrag(){
      if(!this.drag)return;
      const {part,target,pointerId}=this.drag;this.drag=null;delete part.node.dataset.layoutDragging;
      if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId);
      this.save();this.refresh();this.notify();
    }
    nudge(part,event,kind='move'){
      if(!this.editing||!this.canMove(part)||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.code)||(kind==='resize'&&!this.canResize(part)))return;
      event.preventDefault();event.stopPropagation();this.select(part.id);
      const box=part.node.getBoundingClientRect(),step=event.shiftKey?20:5;
      const dx=event.code==='ArrowLeft'?-step:event.code==='ArrowRight'?step:0,dy=event.code==='ArrowUp'?-step:event.code==='ArrowDown'?step:0;
      if(kind==='resize')this.resizePart(part,box.width+dx,box.height+dy,box);else this.position(part,box.left+dx,box.top+dy);
      this.save();this.refresh();this.notify();
    }
    destroy(){this.endDrag();this.setEditing(false);this.destroyed=true;window.cancelAnimationFrame(this.frame);this.observer.disconnect();this.syncPortals(false);for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);for(const part of this.parts){part.grip.remove();part.resizeHandle.remove();this.clearSize(part);if(part.slot){part.slot.before(part.node);part.slot.remove();}part.node.style.removeProperty('translate');part.node.style.removeProperty('--driver-part-opacity');delete part.node.dataset.driverPartHidden;part.node.inert=false;}}
  }
  window.BoatDriverLayout=BoatDriverLayout;
})();
