/* 图传上的轻量 SVG HUD。共用现有数据有效期，无独立轮询或动画循环。 */
(() => {
  'use strict';
  const NS='http://www.w3.org/2000/svg';
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:
    typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value))?Number(value):null;
  class BoatDriverHud {
    constructor({document=window.document}={}) {
      this.document=document;
      this.nodes=Object.fromEntries(['driverHud','driverHudRollValue','driverHudPitchValue','driverHudAttitudeStatus','driverHudRollPointer','driverHudRoll','driverHudPitch','driverHudSpeed','driverHudTarget','driverHudHeadingValue','driverHudHeadingTicks','driverHudPosition'].map(id=>[id,document.getElementById(id)]));
      this.ticks=[];
      for(let angle=-90;angle<=90;angle+=10){
        const y=180+angle*4,major=angle===0;
        this.svg('path',{d:major?'M215 '+y+' H385':'M250 '+y+' h34 m32 0 h34',class:angle<0?'driver-hud-negative':''},this.nodes.driverHudPitch);
        if(!major)for(const x of [237,363])this.svg('text',{x,y:y+4,'text-anchor':'middle'},this.nodes.driverHudPitch,String(Math.abs(angle)));
      }
      for(let i=0;i<15;i++){
        const group=this.svg('g',{},this.nodes.driverHudHeadingTicks);
        this.svg('path',{d:'M0 12 v8'},group);
        const label=this.svg('text',{x:0,y:36,'text-anchor':'middle'},group);
        this.ticks.push({group,label});
      }
      this.setTelemetry();
    }
    svg(tag,attrs,parent,text) {
      const node=this.document.createElementNS(NS,tag);
      for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);
      if(text!==undefined)node.textContent=text;
      parent.append(node);return node;
    }
    text(id,value){const text=String(value??'--');if(this.nodes[id].textContent!==text)this.nodes[id].textContent=text;}
    attribute(node,name,value){if(node.getAttribute(name)!==value)node.setAttribute(name,value);}
    setTelemetry(value={}) {
      const imu=value.imu||{},roll=number(imu.rollDegrees),pitch=number(imu.pitchDegrees);
      const attitude=imu.eulerFresh===true&&roll!==null&&pitch!==null&&Math.abs(roll)<=180&&Math.abs(pitch)<=90;
      this.nodes.driverHud.dataset.attitudeValid=String(attitude);
      this.text('driverHudRollValue',attitude?roll.toFixed(1):'--');
      this.text('driverHudPitchValue',attitude?pitch.toFixed(1):'--');
      this.text('driverHudAttitudeStatus',attitude?'姿态实时':'姿态不可用');
      // 与三维船模、人工地平仪一致：正 roll 右倾，正 pitch 船头向下。
      this.attribute(this.nodes.driverHudRoll,'transform',attitude?'rotate('+(-roll)+' 300 180)':'');
      this.attribute(this.nodes.driverHudPitch,'transform',attitude?'translate(0 '+(-pitch*4)+')':'');
      this.attribute(this.nodes.driverHudRollPointer,'transform',attitude?'rotate('+roll+' 300 120)':'');
      for(const [id,key]of [['driverHudSpeed','actual'],['driverHudTarget','target']]){
        const speed=number(value[key]);this.text(id,speed===null?'--':speed.toFixed(2));
      }
      const rawHeading=number(value.actualHeading),heading=rawHeading===null?null:((rawHeading%360)+360)%360;
      this.nodes.driverHudHeadingTicks.hidden=heading===null;
      this.nodes.driverHudHeadingTicks.style.display=heading===null?'none':'';
      this.text('driverHudHeadingValue',heading===null?'--':heading.toFixed(1));
      // 同一份遥测会被多次刷新；只有航向变化才更新刻度，避免反复重建 SVG 文本。
      if(heading!==this.lastHeading)for(let i=0;i<this.ticks.length;i++){
        const tick=this.ticks[i],degree=heading===null?0:Math.floor(heading/10)*10+(i-7)*10,normal=((degree%360)+360)%360;
        this.attribute(tick.group,'transform','translate('+(150+(degree-(heading??0))*3)+',0)');
        const label=({0:'N',90:'E',180:'S',270:'W'})[normal]||String(normal).padStart(3,'0');
        if(tick.label.textContent!==label)tick.label.textContent=label;
      }
      this.lastHeading=heading;
      this.text('driverHudPosition',value.fixValid?'WGS84 · '+value.latitude+' / '+value.longitude:'WGS84 · 等待有效定位');
    }
  }
  window.BoatDriverHud=BoatDriverHud;
})();
