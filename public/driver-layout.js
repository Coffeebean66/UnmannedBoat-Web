/* 只保存显示偏好，不保存船只接管凭据；共享仪表离开驾驶页后恢复原样。 */
(() => {
  'use strict';
  // 常规 / 图传主画面 / 地图主画面分别保存位置；急停始终保持完全可见。
  const STORAGE='boat-driver-platform-layout-v1';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
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
      this.ui=Object.fromEntries(['driverLayoutToggle','driverLayoutEditor','driverLayoutDone','driverLayoutModule','driverPartOpacity','driverPartOpacityValue','driverLayoutHint','driverLayoutFloat','driverLayoutResetPart','driverLayoutResetAll'].map(id=>[id,document.getElementById(id)]));
      this.profiles=this.load();
      for(const [id,label,selector,min=0,floating=false]of PARTS){
        const node=document.querySelector(selector);if(!node)continue;
        const part={id,label,node,min,floating};
        node.dataset.driverLayoutModule=id;
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
      }
      this.listen(this.ui.driverLayoutToggle,'click',()=>this.setEditing(!this.editing));
      this.listen(this.ui.driverLayoutDone,'click',()=>this.setEditing(false));
      this.listen(this.ui.driverLayoutModule,'change',()=>this.select(this.ui.driverLayoutModule.value));
      this.listen(this.ui.driverPartOpacity,'input',()=>{
        const part=this.part();this.entry(part.id).opacity=clamp(Number(this.ui.driverPartOpacity.value),part.min,100);
        this.save();this.refresh();this.notify();
      });
      this.listen(this.ui.driverLayoutFloat,'click',()=>{
        const part=this.part(),entry=this.entry(part.id);entry.floating=!entry.floating;
        delete entry.x;delete entry.y;this.save();this.refresh();this.notify();
      });
      this.listen(this.ui.driverLayoutResetPart,'click',()=>{delete this.profile()[this.selected];this.save();this.refresh();this.notify();});
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
          }
        }
      }catch(_){/* 存储不可用或旧数据损坏时使用默认布局。 */}
      return profiles;
    }
    save(){try{window.localStorage.setItem(STORAGE,JSON.stringify({version:1,profiles:this.profiles}));}catch(_){} }
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
    select(id){if(this.parts.some(part=>part.id===id))this.selected=id;this.renderEditor();}
    canMove(part){
      if(this.root.dataset.focus&&(part.id==='map'||part.id==='video')&&part.id===this.root.dataset.primary)return false;
      return !part.floating||this.entry(part.id).floating===true;
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
      const active=this.visible();this.syncPortals(active);
      // 先清空偏移，再按父子顺序测量；详情被移动后，其内部模块不会累积父层位移。
      for(const part of this.parts)part.node.style.removeProperty('translate');
      if(!active){
        for(const part of this.parts){part.node.style.removeProperty('--driver-part-opacity');delete part.node.dataset.driverPartHidden;part.node.inert=false;}
        return;
      }
      const canvas=this.stage.getBoundingClientRect();if(!canvas.width||!canvas.height)return;
      for(const overlay of this.root.querySelectorAll('[data-driver-overlay]'))overlay.inert=!this.editing&&this.root.dataset.overlayHidden==='true';
      const depth=node=>{let result=0;for(let p=node.parentElement;p;p=p.parentElement)result++;return result;};
      for(const part of [...this.parts].sort((a,b)=>depth(a.node)-depth(b.node))){
        const box=part.node.getBoundingClientRect();
        const entry=this.profile()[part.id]||{},opacity=clamp(entry.opacity??100,part.min,100);
        part.node.style.setProperty('--driver-part-opacity',String(opacity/100));
        part.node.dataset.driverPartHidden=String(opacity===0);
        part.node.inert=!this.editing&&(opacity===0||(this.root.dataset.overlayHidden==='true'&&!!part.node.closest('[data-driver-overlay]')));
        part.grip.disabled=!this.canMove(part);
        if(this.canMove(part)&&Number.isFinite(entry.x)&&Number.isFinite(entry.y)&&box.width&&box.height){
          const x=canvas.left+entry.x*Math.max(0,canvas.width-box.width),y=canvas.top+entry.y*Math.max(0,canvas.height-box.height);
          part.node.style.translate=(x-box.left).toFixed(2)+'px '+(y-box.top).toFixed(2)+'px';
        }
      }
      this.renderEditor();
    }
    renderEditor(){
      const part=this.part();if(!part)return;
      const entry=this.profile()[part.id]||{},opacity=clamp(entry.opacity??100,part.min,100);
      this.ui.driverLayoutModule.value=part.id;this.ui.driverPartOpacity.min=String(part.min);
      this.ui.driverPartOpacity.value=String(opacity);this.ui.driverPartOpacityValue.textContent=opacity+'%';
      this.ui.driverPartOpacity.disabled=part.id==='emergency';
      this.ui.driverLayoutFloat.hidden=!part.floating;
      this.ui.driverLayoutFloat.textContent=entry.floating?'收回航行详情':'移出详情，独立显示';
      const main=(part.id==='map'||part.id==='video')&&!this.canMove(part);
      this.ui.driverLayoutHint.textContent=part.id==='emergency'?'急停始终保持 100% 不透明，可以调整位置，不受 HUD 或布局透明度影响。':main?'放大的主画面保持铺满；还原布局或作为小窗时可以拖动。':
        part.floating&&!entry.floating?'当前位于航行详情，可移出后单独摆放。':
        part.min?'此项最低 '+part.min+'%，保留必要操作的可见度。':'0% 完全隐藏；编辑时仍显示轮廓，便于找回。';
      for(const item of this.parts)item.node.dataset.layoutSelected=String(item===part);
    }
    startDrag(part,event){
      if(!this.editing||!this.canMove(part)||event.button!==0)return;
      event.preventDefault();event.stopPropagation();this.select(part.id);
      this.drag={part,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,box:part.node.getBoundingClientRect()};
      part.grip.setPointerCapture(event.pointerId);part.node.dataset.layoutDragging='true';
    }
    moveDrag(event){
      const drag=this.drag;if(!drag||event.pointerId!==drag.pointerId)return;
      event.preventDefault();this.position(drag.part,drag.box.left+event.clientX-drag.startX,drag.box.top+event.clientY-drag.startY);this.schedule();
    }
    position(part,left,top){
      const canvas=this.stage.getBoundingClientRect(),box=part.node.getBoundingClientRect(),entry=this.entry(part.id);
      const width=Math.max(0,canvas.width-box.width),height=Math.max(0,canvas.height-box.height);
      entry.x=width?clamp((left-canvas.left)/width,0,1):0;entry.y=height?clamp((top-canvas.top)/height,0,1):0;
    }
    endDrag(){
      if(!this.drag)return;
      const {part,pointerId}=this.drag;this.drag=null;delete part.node.dataset.layoutDragging;
      if(part.grip.hasPointerCapture(pointerId))part.grip.releasePointerCapture(pointerId);
      this.save();this.refresh();
    }
    nudge(part,event){
      if(!this.editing||!this.canMove(part)||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.code))return;
      event.preventDefault();event.stopPropagation();this.select(part.id);
      const box=part.node.getBoundingClientRect(),step=event.shiftKey?20:5;
      this.position(part,box.left+(event.code==='ArrowLeft'?-step:event.code==='ArrowRight'?step:0),box.top+(event.code==='ArrowUp'?-step:event.code==='ArrowDown'?step:0));
      this.save();this.refresh();
    }
    destroy(){this.endDrag();this.setEditing(false);this.destroyed=true;window.cancelAnimationFrame(this.frame);this.observer.disconnect();this.syncPortals(false);for(const [node,event,handler]of this.handlers)node.removeEventListener(event,handler);for(const part of this.parts){part.grip.remove();part.node.style.removeProperty('translate');part.node.style.removeProperty('--driver-part-opacity');delete part.node.dataset.driverPartHidden;part.node.inert=false;}}
  }
  window.BoatDriverLayout=BoatDriverLayout;
})();
