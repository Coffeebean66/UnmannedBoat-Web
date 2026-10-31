/* 只让3D区域执行绘制：离屏、后台、关闭动画或数据过期时停止 GPU 循环。 */
class AttitudeView {
  constructor(canvas) {
    this.canvas=canvas;this.visible=true;this.pose=null;this.fresh=false;this.yawOffset=0;
    this.current=[0,0,0,1];this.target=this.current.slice();this.phase=0;
    this.settings={animation:true,water:true,quality:'medium'};
    try{const saved=JSON.parse(localStorage.getItem('boat_web_view_v1'));if(saved){
      for(const key of ['animation','water'])if(typeof saved[key]==='boolean')this.settings[key]=saved[key];
      if(['low','medium','high'].includes(saved.quality))this.settings.quality=saved.quality;
    }}catch(_){}
    new ResizeObserver(()=>this.resize()).observe(canvas);
    if(window.IntersectionObserver)new IntersectionObserver(entries=>{
      this.visible=entries[0].isIntersecting;if(this.visible){this.catchUp();this.schedule(true);}else this.stop();
    }).observe(canvas);
    document.addEventListener('visibilitychange',()=>{this.stop();if(!document.hidden){this.catchUp();this.schedule(true);}});
    canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);this.pointer=[e.clientX,e.clientY];});
    canvas.addEventListener('pointermove',e=>{
      if(!this.pointer||!this.renderer)return;
      this.renderer.orbit(e.clientX-this.pointer[0],e.clientY-this.pointer[1]);this.pointer=[e.clientX,e.clientY];this.schedule(true);
    });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>this.pointer=null);
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.stop();this.error='3D上下文丢失，请点击重新加载';this.status();});
    this.load();
  }
  status() {
    document.getElementById('modelStatus').textContent=this.error||
      (!this.settings.animation?'动画已关闭 · ':!this.fresh?'姿态已暂停 · ':'IMU 实时姿态 · ')+(this.sourceStatus||'等待有效姿态');
  }
  profile(){return {low:{ratio:1,interval:50,water:125},medium:{ratio:1.5,interval:34,water:84},high:{ratio:2,interval:16,water:50}}[this.settings.quality];}
  async load() {
    const token=this.loadToken=(this.loadToken||0)+1;
    this.stop();this.renderer?.dispose();this.renderer=null;this.error='正在加载船体模型…';this.status();
    try {
      const response=await fetch('assets/boat_jnu_motors_v6.glb');if(!response.ok)throw Error('模型文件 HTTP '+response.status);
      const data=await response.arrayBuffer();if(token!==this.loadToken)return;
      this.renderer=new BoatModules.boatRenderer.BoatRenderer(this.canvas,BoatModules.glbModel.parseGlb(data));
      this.error=null;this.resize();this.status();this.schedule(true);
    } catch(error){if(token===this.loadToken){this.error='3D不可用：'+error.message+'；仍可查看姿态数值';this.status();}}
  }
  setTelemetry(display) {
    this.sourceStatus=display.status;
    const pose=BoatModules.boatAttitude.poseFromDisplay(display);this.fresh=!!pose;
    if(pose) {
      const first=!this.pose;this.pose=pose;
      const target=BoatModules.boatAttitude.renderQuaternion(pose,this.yawOffset);
      if(BoatModules.boatAttitude.rotationDistance(target,this.target)>1e-12||first) {
        this.target=target;
        if(first||!this.visible||document.hidden){if(this.settings.animation)this.catchUp();}
        else if(this.settings.animation){
          this.transition={from:this.current.slice(),at:performance.now()};
          clearTimeout(this.timer);this.timer=null; // 新姿态不等待低频水面定时器。
        }
        this.schedule();
      }
      this.schedule();
    } else {this.stop();this.transition=null;}
    this.status();
  }
  reset() {
    this.stop();this.pose=null;this.fresh=false;this.yawOffset=0;this.relative=false;
    this.current=[0,0,0,1];this.target=this.current.slice();this.transition=null;this.phase=0;this.schedule(true);
    document.getElementById('yawZero').textContent='偏航归零';
  }
  catchUp(){if(this.settings.animation){this.current=this.target.slice();this.transition=null;}}
  resize(){
    const rect=this.canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,this.profile().ratio);
    if(!rect.width)return;
    const width=Math.max(1,Math.round(rect.width*ratio)),height=Math.max(1,Math.round(rect.height*ratio));
    if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;
    this.schedule(true);
  }
  configure(key,value) {
    this.stop();this.settings[key]=value;
    if(key==='animation'&&value)this.catchUp();
    if(key==='quality')this.resize();else this.schedule(true);
    this.status();
    try{localStorage.setItem('boat_web_view_v1',JSON.stringify(this.settings));}catch(_){}
  }
  yawZero() {
    if(!this.fresh||!this.pose||!this.settings.animation)return;
    this.relative=!this.relative;this.yawOffset=this.relative?this.pose.yaw:0;
    this.target=BoatModules.boatAttitude.renderQuaternion(this.pose,this.yawOffset);this.catchUp();this.schedule(true);
    document.getElementById('yawZero').textContent=this.relative?'恢复原始偏航':'偏航归零';
  }
  stop(){clearTimeout(this.timer);cancelAnimationFrame(this.raf);this.timer=null;this.raf=null;this.lastTick=null;}
  schedule(force=false) {
    // 驾驶页的三维预览收起时不绘制；details 内元素仍可能保留非零布局尺寸。
    if(!this.renderer||document.hidden||!this.visible||this.canvas.closest('details:not([open])')||(!force&&(!this.settings.animation||!this.fresh)))return;
    if(force){clearTimeout(this.timer);this.timer=null;}
    if(this.timer!=null||this.raf!=null)return;
    const delay=force?0:this.transition?this.profile().interval:this.profile().water;
    if(!force&&!this.transition&&!this.settings.water)return;
    this.timer=setTimeout(()=>{this.timer=null;this.raf=requestAnimationFrame(now=>this.draw(now));},delay);
  }
  draw(now) {
    this.raf=null;
    if(this.transition&&this.fresh&&this.settings.animation) {
      const t=Math.min(1,(now-this.transition.at)/45);
      this.current=BoatModules.boatAttitude.slerp(this.transition.from,this.target,t);
      if(t>=1)this.transition=null;
    }
    if(this.settings.animation&&this.fresh&&this.settings.water){
      if(this.lastTick!=null)this.phase+=Math.min(250,now-this.lastTick)/1000;
      this.lastTick=now;
    }
    try{this.renderer.draw(this.current,{waterEnabled:this.settings.water,time:this.phase});}
    catch(error){this.error=error.message;this.stop();this.status();return;}
    this.schedule();
  }
}
window.AttitudeView=AttitudeView;
