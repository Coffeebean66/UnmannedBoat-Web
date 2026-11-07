/* 任务曲线统一在 WGS84 局部米制平面生成，地图预览与服务器跟踪共用。
 * 控制点只决定弯曲形状，不是必须驶过的航点；采样误差上限为 0.15 米。 */
'use strict';
const N=require('./missionNavigation');
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const local=(origin,p)=>{const d=N.distance(origin,p),h=N.bearing(origin,p)*Math.PI/180;return {x:d*Math.sin(h),y:d*Math.cos(h)};};
const geographic=(origin,p)=>N.destination(origin,N.wrap(Math.atan2(p.x,p.y)*180/Math.PI),Math.hypot(p.x,p.y));
const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
function defaultControl(start,end){
  const length=N.distance(start,end),middle=N.destination(start,N.bearing(start,end),length/2);
  return N.destination(middle,N.bearing(start,end)+90,length*.4);
}
function compileSegment(start,end,definition={type:'line'}){
  const points=[start],curved=definition.type==='curve';
  if(curved){
    const control=local(start,definition.control),finish=local(start,end);
    const split=(a,c,b,depth)=>{
      const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
      const deviation=length>1e-9?Math.abs(dx*(c.y-a.y)-dy*(c.x-a.x))/length:Math.hypot(c.x-a.x,c.y-a.y);
      if(deviation<=.15){points.push(geographic(start,b));return;}
      if(depth>=12)throw Error('曲线过于复杂，请拆分为更多航点');
      const ac=midpoint(a,c),cb=midpoint(c,b),middle=midpoint(ac,cb);
      split(a,ac,middle,depth+1);split(middle,cb,b,depth+1);
    };
    split({x:0,y:0},control,finish,0);points[points.length-1]=end;
  }else points.push(end);
  const cumulative=[0];
  for(let i=1;i<points.length;i++)cumulative.push(cumulative.at(-1)+N.distance(points[i-1],points[i]));
  return {points,cumulative,lengthM:cumulative.at(-1),curved,record:definition.record!==false};
}
function compile(route){
  const points=route.points.length?[route.points[0]]:[],segments=[];let lengthM=0;
  for(let i=1;i<route.points.length;i++){
    const segment=compileSegment(route.points[i-1],route.points[i],route.segments?.[i-1]);
    segments.push(segment);points.push(...segment.points.slice(1));lengthM+=segment.lengthM;
  }
  return {points,segments,lengthM};
}
function at(segment,meters){
  const s=clamp(meters,0,segment.lengthM),{points,cumulative}=segment;
  for(let i=1;i<points.length;i++)if(cumulative[i]>=s){
    return N.destination(points[i-1],N.bearing(points[i-1],points[i]),s-cumulative[i-1]);
  }
  return points.at(-1);
}
// 投影到当前完整航段，再沿弧长前视；采样点从不触发到点停船或改变航点编号。
function guide(position,segment,lookAheadM){
  let best=null;
  for(let i=1;i<segment.points.length;i++){
    const a=segment.points[i-1],b=segment.points[i],g=N.guide(position,a,b,0);
    const along=clamp(g.alongM,0,g.lengthM),projection=N.destination(a,N.bearing(a,b),along),away=N.distance(position,projection);
    if(!best||away<best.away)best={away,crossM:g.crossM,alongM:segment.cumulative[i-1]+along,courseHeading:N.bearing(a,b)};
  }
  const aim=at(segment,best.alongM+lookAheadM),remainingM=Math.max(0,segment.lengthM-best.alongM);
  return {...best,heading:N.bearing(position,aim),distanceM:Math.hypot(remainingM,best.away),remainingM,lengthM:segment.lengthM,aim};
}
// 按记录属性合并相邻航段；保留曲线采样，所有地图共用实线/虚线含义。
function routeLines(route,style={}){
  const lines=[];
  for(const segment of compile(route).segments){
    const dashed=!segment.record,last=lines.at(-1);
    if(last&&last.dashed===dashed)last.points.push(...segment.points.slice(1));
    else lines.push({...style,points:[...segment.points],dashed});
  }
  return lines;
}
// 按执行顺序用黄金角分配颜色，任务组编辑器与驾驶地图使用同一组色值。
function routeColor(index){
  const h=(index*137.508+214)%360,s=.72,l=.59,a=s*Math.min(l,1-l);
  return '#'+[0,8,4].map(n=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');}).join('');
}
module.exports={defaultControl,compileSegment,compile,at,guide,routeLines,routeColor};
