/* 地图门面负责船位投影与锚定；SVG 使用屏幕长度表达速度，两支箭头共用比例。 */
class MapVelocityView {
  constructor(map) {
    this.map=map;
    this.marker=null;
    this.lastView=null;
    this.visible=true;
    try{this.visible=localStorage.getItem('boat_web_velocity_vectors_v1')!=='hidden';}catch(_){}
    this.map?.on('resize',()=>this.render(this.lastView));
    this.syncButton();
  }
  syncButton() {
    const button=document.getElementById('mapVectorsToggle');
    button.textContent=this.visible?'隐藏速度箭头':'显示速度箭头';
    button.setAttribute('aria-pressed',String(this.visible));
    document.getElementById('mapVectorReadouts').hidden=!this.visible;
  }
  toggle() {
    this.visible=!this.visible;
    try{localStorage.setItem('boat_web_velocity_vectors_v1',this.visible?'visible':'hidden');}catch(_){}
    this.syncButton();this.render(this.lastView);
  }
  clear() {
    if(this.marker){this.marker.remove();this.marker=null;}
  }
  readout(vector) {
    if(!vector)return '--';
    return vector.speedMps.toFixed(3)+' m/s · '+(vector.bearingDegrees==null?'静止':vector.bearingDegrees.toFixed(1)+'°');
  }
  createMarker(fix) {
    const vector=kind=>'<g class="map-vector '+kind+'" data-vector="'+kind+'" hidden><title></title><path class="vector-halo"/><path class="vector-shaft"/><path class="vector-head-halo"/><path class="vector-head"/><circle class="vector-zero" cx="0" cy="0" r="'+(kind==='target'?7:4)+'" hidden/></g>';
    const svg='<svg class="map-velocity-vectors" width="264" height="264" viewBox="-132 -132 264 264" role="img" aria-label="目标与实际对地速度箭头">'+vector('target')+vector('actual')+'</svg>';
    this.marker=this.map.createMarker(fix,{
      className:'map-velocity-anchor',html:svg,iconSize:[0,0],iconAnchor:[0,0],
      interactive:false,keyboard:false,zIndexOffset:200
    });
  }
  drawVector(group,vector,pixelsPerMps) {
    group.toggleAttribute('hidden',!vector);
    group.style.display=vector?'':'none';
    if(!vector)return;
    group.dataset.speed=String(vector.speedMps);
    group.dataset.bearing=vector.bearingDegrees==null?'':String(vector.bearingDegrees);
    const length=vector.speedMps*pixelsPerMps;
    group.dataset.length=String(length);
    group.querySelector('title').textContent=(group.dataset.vector==='target'?'目标 ':'实际 ')+this.readout(vector);
    const moving=length>0&&vector.bearingDegrees!=null;
    group.setAttribute('transform','rotate('+(vector.bearingDegrees||0)+')');
    const head=Math.min(9,length*.45),halfWidth=head*.6;
    const shaft='M 0 0 L 0 '+(-length);
    const tip='M '+(-halfWidth)+' '+(-length+head)+' L 0 '+(-length)+' L '+halfWidth+' '+(-length+head);
    for(const path of group.querySelectorAll('path')) {
      path.setAttribute('d',path.classList.contains('vector-head')||path.classList.contains('vector-head-halo')?tip:shaft);
      path.style.display=moving?'':'none';
    }
    group.querySelector('circle').toggleAttribute('hidden',moving);
    group.querySelector('circle').style.display=moving?'none':'';
  }
  render(view) {
    this.lastView=view;
    document.getElementById('mapVectorTarget').textContent=this.readout(view?.target);
    document.getElementById('mapVectorActual').textContent=this.readout(view?.actual);
    const status=!this.visible?'速度箭头已隐藏':!view?.closedLoop?'仅在速度 / 角度闭环显示':!view.fix?'等待有效定位':!view.target&&!view.actual?'等待有效速度或方向':'北 0° · 顺时针 · 箭头越长速度越大';
    document.getElementById('mapVectorStatus').textContent=status;
    if(!this.map?.ready||!this.visible||!view?.closedLoop||!view.fix||(!view.target&&!view.actual)){this.clear();return;}
    if(!this.marker)this.createMarker(view.fix);
    this.marker.setPosition(view.fix);
    // 常用 0–3 m/s 对应 0–84px；更高速度或窄地图时，两支箭头按同一比例缩小。
    const maxLength=Math.max(1,Math.min(120,Math.min(this.map.getSize().x,this.map.getSize().y)/2-18));
    const maxSpeed=Math.max(view.target?.speedMps||0,view.actual?.speedMps||0);
    const pixelsPerMps=maxSpeed>0?Math.min(28,maxLength/maxSpeed):28;
    const element=this.marker.getElement();
    for(const kind of ['target','actual'])this.drawVector(element.querySelector('[data-vector="'+kind+'"]'),view[kind],pixelsPerMps);
  }
}
window.MapVelocityView=MapVelocityView;
