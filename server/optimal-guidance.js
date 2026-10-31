/* 二状态航线 LQR。单位：横向偏差m、相对航向rad、输入为目标航向偏置rad。
 * 模型 y'=v*psi，psi'=(-psi+u)/tau；假设内环近似一阶，仅是初始辨识值。
 * 每个任务启动时求解一次，100ms调度只用固定次数的乘加。 */
'use strict';
const nav=require('../public/utils/missionNavigation');
const CONFIG=Object.freeze({sampleS:.1,headingTauS:1.2,crossWeight:.25,headingWeight:2,inputWeight:4,maxOffsetDeg:60});
function solve(a,b,q,r){
  if(a?.length!==4||b?.length!==2||q?.length!==2||![...a,...b,...q,r].every(Number.isFinite)||q.some(x=>x<=0)||r<=0)throw Error('LQR模型参数无效');
  let p=[q[0],0,0,q[1]],gain,converged=false;
  for(let iteration=0;iteration<4096;iteration++){
    const pb=[p[0]*b[0]+p[1]*b[1],p[2]*b[0]+p[3]*b[1]],den=r+b[0]*pb[0]+b[1]*pb[1];
    if(!Number.isFinite(den)||den<=0)throw Error('LQR模型不可解');
    const f=[pb[0]*a[0]+pb[1]*a[2],pb[0]*a[1]+pb[1]*a[3]];gain=f.map(x=>x/den);
    const next=[];let diff=0,scale=1;
    for(let i=0;i<2;i++)for(let j=0;j<2;j++){
      let value=i===j?q[i]:0;
      for(let m=0;m<2;m++)for(let n=0;n<2;n++)value+=a[m*2+i]*p[m*2+n]*a[n*2+j];
      value-=f[i]*f[j]/den;if(!Number.isFinite(value))throw Error('LQR模型数值无效');
      next[i*2+j]=value;diff=Math.max(diff,Math.abs(value-p[i*2+j]));scale=Math.max(scale,Math.abs(value));
    }
    p=next;if(diff<1e-9*scale){converged=true;break;}
  }
  const pb=[p[0]*b[0]+p[1]*b[1],p[2]*b[0]+p[3]*b[1]],den=r+b[0]*pb[0]+b[1]*pb[1];
  gain=[(pb[0]*a[0]+pb[1]*a[2])/den,(pb[0]*a[1]+pb[1]*a[3])/den];
  const c=a.map((x,i)=>x-b[Math.floor(i/2)]*gain[i%2]),tr=c[0]+c[3],det=c[0]*c[3]-c[1]*c[2];
  if(!converged||!Number.isFinite(tr)||!Number.isFinite(det)||1-det<=0||1-tr+det<=0||1+tr+det<=0)throw Error('LQR模型未收敛或不稳定');
  return gain;
}
function create(speedMps,config=CONFIG){
  if(!Number.isFinite(speedMps)||speedMps<.1||speedMps>20||
    Object.values(config).some(x=>!Number.isFinite(x)||x<=0)||config.maxOffsetDeg>80)throw Error('LQR航线模型参数无效');
  const dt=config.sampleS,tau=config.headingTauS,decay=Math.exp(-dt/tau),v=Math.max(.2,speedMps);
  const gain=solve([1,v*tau*(1-decay),0,decay],[v*(dt-tau*(1-decay)),1-decay],
    [config.crossWeight,config.headingWeight],config.inputWeight);
  return {guide(position,start,end,radius){
    const geometry=nav.guide(position,start,end,Math.max(5,radius*2)),course=nav.bearing(start,end);
    // 终端捕获仍需驶向真正的航点，不能沿无限直线驶过终点后继续平行航行。
    if(geometry.lengthM<.5||geometry.alongM>=geometry.lengthM-Math.max(3,radius*2))
      return {...geometry,heading:nav.bearing(position,end)};
    const error=nav.angleError(position.heading,course)*Math.PI/180;
    const offset=Math.max(-config.maxOffsetDeg,Math.min(config.maxOffsetDeg,
      (-gain[0]*geometry.crossM-gain[1]*error)*180/Math.PI));
    return {...geometry,heading:nav.wrap(course+offset)};
  },gain:[...gain]};
}
module.exports={CONFIG,solve,create};
