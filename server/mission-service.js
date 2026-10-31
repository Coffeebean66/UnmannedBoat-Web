/* 服务器航线执行器：每轮校验定位/船速/航向和租约后重新计算目标，不依赖网页心跳。 */
'use strict';
const crypto=require('node:crypto');
const nav=require('../public/utils/missionNavigation');
const {decodeParameterFrame}=require('../public/utils/uart4Protocol');
const {fault}=require('./mission-store');
const ACTIVE=new Set(['preparing','acquiring','running','stopping']);
function feedback(bridge,id,now){
  if(!bridge?.brokerConnected||!bridge.get?.(id)?.online)throw fault(503,'船端已离线，任务停止');
  const sample=bridge.navigationSnapshot?.(id),elapsed=sample?now-sample.receivedAt:Infinity;
  const v=sample?.velocity?.velocity,b=sample?.boat?.boat;
  if(elapsed<0||elapsed>=1000||!v?.received||!v.fresh||v.ageMs===null||v.ageMs+elapsed>=1000||!v.hasNavigation||!v.fixValid)throw fault(503,'实时定位失效或超过 1 秒，任务停止');
  if(!Number.isFinite(v.latitude)||!Number.isFinite(v.longitude)||Math.abs(v.latitude)>85||Math.abs(v.longitude)>180)throw fault(503,'船位坐标无效，任务停止');
  if(v.velocityValid===false||!b?.received||!b.feedbackValid||!b.motorsValid||b.ageMs===null||b.ageMs+elapsed>=1000)throw fault(503,'船速或电调反馈失效，任务停止');
  const heading=b.headingValid?b.actualHeading:v.headingValid?v.headingDegrees:null;
  if(!Number.isFinite(heading)||heading<0||heading>=360||!b.headingValid)throw fault(503,'船端航向反馈无效，任务停止');
  if(!Number.isInteger(v.receivedMs))throw fault(503,'定位样本时间戳无效，任务停止');
  return {latitude:v.latitude,longitude:v.longitude,heading,speedMps:Math.hypot(v.xMps,v.yMps),sourceTick:v.receivedMs,mode:b.controlMode,enabled:b.controlEnabled};
}
class MissionService{
  constructor({bridge,control,store,now=Date.now,pollMs=100,progressTimeoutMs=120000}={}){
    this.bridge=bridge;this.control=control;this.store=store;this.now=now;this.progressTimeoutMs=progressTimeoutMs;this.jobs=new Map();this.closed=false;
    this.timer=setInterval(()=>this.refresh(),pollMs);this.timer.unref?.();
  }
  active(id){return ACTIVE.has(this.jobs.get(id)?.status);}
  snapshot(job,includeRoute=true){
    if(typeof job==='string')job=this.jobs.get(job);
    if(!job)return null;
    return {deviceId:job.id,runId:job.runId,routeId:job.route.id,routeName:job.route.name,...(includeRoute?{route:structuredClone(job.route)}:{}),action:job.action,
      status:job.status,message:job.message,active:ACTIVE.has(job.status),targetIndex:job.index,pointCount:job.route.points.length,
      loopEnabled:job.loopEnabled,loopCount:job.loopCount,completedLoops:job.completedLoops,
      currentLoop:job.action==='start'?Math.min(job.completedLoops+1,job.loopCount):null,phase:job.phase,
      distanceM:job.distanceM??null,crossTrackM:job.crossTrackM??null,targetHeading:job.heading??null,commandSpeedMps:job.commandSpeedMps??0,
      position:job.position||null,startedAt:job.startedAt,finishedAt:job.finishedAt||null,stopConfirmed:job.stopConfirmed===true};
  }
  list(){return [...this.jobs.values()].map(job=>this.snapshot(job,false));}
  start(id,routeId,action,revision){
    if(this.closed||this.store.error)throw fault(503,this.store.error||'任务服务正在关闭');
    if(!['goto','start'].includes(action))throw fault(400,'任务操作不正确');
    if(this.active(id))throw fault(409,'这艘船已有任务，请先停止当前任务');
    const route=this.store.get(id,routeId);
    if(revision!==undefined&&revision!==route.revision)throw fault(409,'航线已被修改，请重新载入核对后再执行');
    const position=feedback(this.bridge,id,this.now());
    if(action==='start'&&nav.distance(position,route.points[0])>route.arrivalRadiusM)throw fault(409,'船不在开始点范围内，请先前往任务开始点');
    if(!this.control.snapshot(id).ready)throw fault(409,'船端尚未就绪或正被手动驾驶、调参、OTA 占用');
    const runId=crypto.randomBytes(8).toString('hex'),job={id,route,action,runId,owner:'mission:'+runId,clientId:crypto.randomBytes(8).toString('hex'),
      status:'preparing',message:'正在读取船端最大速度参数',startedAt:this.now(),index:0,sequence:0,arrivalCount:0,controller:new AbortController(),
      loopEnabled:action==='start'&&route.loopEnabled,loopCount:action==='start'&&route.loopEnabled?route.loopCount:1,completedLoops:0,phase:action==='goto'?'goto':'route'};
    this.jobs.set(id,job);
    // 限制仅在内存保留最近 128 艘船的结束状态，活动任务不会被驱逐。
    if(this.jobs.size>128)for(const [key,value]of this.jobs)if(!this.active(key)){this.jobs.delete(key);break;}
    this.prepare(job).catch(error=>this.stopJob(job,'failed',error.status?error.message:'任务启动失败，请检查船端参数与控制通道'));
    return this.snapshot(job);
  }
  current(job){return !this.closed&&this.jobs.get(job.id)===job&&ACTIVE.has(job.status)&&job.status!=='stopping';}
  async prepare(job){
    // 只在点击执行时读取一次参数，在申请控制锁之前完成，不猜测满杆速度。
    const packet=await this.bridge.requestParameters(job.id,'read',undefined,{signal:job.controller.signal});
    if(!this.current(job))return;
    const frame=decodeParameterFrame(packet),maximum=frame?.parameters?.maxTargetMmS;
    if(frame?.status!==0||!Number.isInteger(maximum)||maximum<100||maximum>20000)throw fault(503,'读取船端最大速度失败，未接管');
    if(job.route.speedMps*1000>maximum)throw fault(409,'任务航速超过船端最大目标速度，请降低任务航速或先调参');
    const position=feedback(this.bridge,job.id,this.now());
    if(job.action==='start'&&nav.distance(position,job.route.points[0])>job.route.arrivalRadiusM)throw fault(409,'船位已离开开始点范围，请重新前往开始点');
    job.maximum=maximum;job.input={mode:2,throttle:0,turn:0,targetHeading:Math.round(position.heading*100)%36000,testMode:false};
    job.status='acquiring';job.message='等待单片机确认任务接管';
    const pending=this.control.acquire(job.id,job.owner,job.clientId,job.input,{source:'mission'});
    job.controlJob=this.control.jobs.get(job.id);
    const lease=await pending;
    if(!this.current(job))return;
    if(lease.mode!==2||lease.testMode)throw fault(409,'船端未确认正常航向闭环模式，任务停止');
    job.leaseId=lease.leaseId;job.status='running';job.message=job.action==='goto'?'正在前往任务开始点':'正在执行航线';job.armedAt=this.now();
    job.lastProgressAt=this.now();job.bestDistance=Infinity;this.step(job);
  }
  finish(job,status,message,confirmed=false){job.status=status;job.message=message;job.finishedAt=this.now();job.stopConfirmed=confirmed;job.commandSpeedMps=0;}
  stop(id){const job=this.jobs.get(id);if(!job)throw fault(404,'当前无人船没有任务');this.stopJob(job,'stopped','管理员已停止任务');return this.snapshot(job);}
  stopJob(job,result,message){
    if(this.jobs.get(job.id)!==job||!ACTIVE.has(job.status)||job.status==='stopping')return;
    job.controller.abort();job.result=result;job.message=message;job.commandSpeedMps=0;
    const controlJob=job.controlJob;
    if(controlJob&&this.control.jobs.get(job.id)===controlJob){job.status='stopping';job.message=message+'；等待船端停止确认';this.control.stopJob(controlJob,'stop');}
    else if(controlJob){this.finish(job,'failed',message+'；控制租约已丢失，请确认船已停止');}
    else this.finish(job,result,message+'（未进入运动控制）',true);
  }
  arrived(job,now){
    if(job.action==='goto'){this.stopJob(job,'completed','已到达任务开始点');return;}
    if(job.phase==='returning'){
      // 只有返回起点并取得两份新定位后才完成一圈；最后一圈同样回到起点。
      job.completedLoops++;
      if(job.completedLoops>=job.loopCount){this.stopJob(job,'completed','已完成 '+job.loopCount+' 圈并返回开始点');return;}
      job.phase='route';job.index=1;
    }else if(job.index===job.route.points.length-1){
      if(!job.loopEnabled){job.completedLoops=1;this.stopJob(job,'completed','全部航点已完成');return;}
      job.phase='returning';job.index=0;
    }else job.index++;
    job.arrivalCount=0;job.bestDistance=Infinity;job.lastProgressAt=now;
  }
  step(job){
    const now=this.now(),p=feedback(this.bridge,job.id,now),cj=job.controlJob,cap=this.control.cap(job.id);
    if(this.control.jobs.get(job.id)!==cj||cj.status!=='active'||!cap||cap.mode!==2||cap.testMode)throw fault(409,cj?.lastError?.message||'任务控制租约已失效');
    if(now-job.armedAt>1000&&(p.mode!==2||p.enabled===false))throw fault(409,'船端未保持航向闭环控制，任务停止');
    const isNew=job.lastSourceTick!==p.sourceTick;
    if(isNew){
      if(job.lastSourceTick!==undefined&&((p.sourceTick-job.lastSourceTick)>>>0)>0x7fffffff)throw fault(409,'定位样本时间回退，任务停止');
      job.lastSourceTick=p.sourceTick;job.lastSourceAt=now;
    }else if(now-job.lastSourceAt>=1000)throw fault(503,'定位样本超过 1 秒未更新，任务停止');
    const end=job.route.points[job.index],d=nav.distance(p,end),radius=job.route.arrivalRadiusM;
    job.position={latitude:p.latitude,longitude:p.longitude};job.distanceM=d;
    // 连续两份不同 RTK 样本确认到点；同一个定位不能连续跨过多个相邻航点。
    if(isNew){job.arrivalCount=d<=radius?job.arrivalCount+1:0;}
    if(job.arrivalCount>=2){
      this.arrived(job,now);if(job.status!=='running')return;
    }
    const target=job.route.points[job.index];
    // 返回航段沿“终点 → 起点”引导，也接受原有横向偏差/进度保护。
    const from=job.phase==='returning'?job.route.points[job.route.points.length-1]:job.index>0?job.route.points[job.index-1]:null;
    const g=from?nav.guide(p,from,target,Math.max(5,radius*2,job.route.speedMps*4)):{heading:nav.bearing(p,target),distanceM:nav.distance(p,target),crossM:0};
    job.distanceM=g.distanceM;job.crossTrackM=g.crossM;job.heading=g.distanceM<0.2?p.heading:g.heading;
    if(Math.abs(g.crossM)>Math.max(30,radius*5))throw fault(409,'船位偏离航线过远，任务停止');
    if(g.distanceM<job.bestDistance-0.5){job.bestDistance=g.distanceM;job.lastProgressAt=now;}
    if(now-job.lastProgressAt>=this.progressTimeoutMs)throw fault(504,'连续 '+Math.round(this.progressTimeoutMs/1000)+' 秒未接近目标航点，任务停止');
    const error=Math.abs(nav.angleError(job.heading,p.heading));
    const slow=Math.min(job.route.speedMps,Math.max(0.2,Math.sqrt(Math.max(0,g.distanceM-radius)*0.6)));
    // 大角度先原地转向；到点等待第二个定位样本时只保持零推力。
    job.commandSpeedMps=g.distanceM<=radius||error>70?0:slow*Math.max(0,Math.cos(error*Math.PI/180));
    const input={...job.input,throttle:Math.min(1000,Math.round(job.commandSpeedMps*1000000/job.maximum)),targetHeading:Math.round(job.heading*100)%36000};
    this.control.command(job.id,job.owner,job.clientId,job.leaseId,++job.sequence,'input',input);
    job.message=(job.action==='goto'?'前往开始点':job.loopEnabled?'第 '+(job.completedLoops+1)+' / '+job.loopCount+' 圈 · '+(job.phase==='returning'?'终点返回起点':'沿线航行'):'航线执行')+' · 航点 '+(job.index+1)+' / '+job.route.points.length;
  }
  refresh(){
    if(this.closed)return;
    for(const job of this.jobs.values()){
      if(job.status==='stopping'){
        if(this.control.jobs.get(job.id)===job.controlJob)continue;
        const confirmed=job.controlJob.stopConfirmed===true;
        this.finish(job,confirmed?job.result:'failed',confirmed?job.message.replace('；等待船端停止确认','')+'；船端已确认停止':job.message.replace('；等待船端停止确认','')+'；未收到停止确认，请检查船端（失联看门狗将撤销控制）',confirmed);continue;
      }
      if(job.status==='running'){try{this.step(job);}catch(error){this.stopJob(job,'failed',error.status?error.message:'任务计算异常，已请求停船');}}
      else if(job.status==='acquiring'){try{feedback(this.bridge,job.id,this.now());}catch(error){this.stopJob(job,'failed',error.message);}}
    }
  }
  close(){if(this.closed)return;for(const job of this.jobs.values())this.stopJob(job,'stopped','服务器正在停止，任务不会自动恢复');this.closed=true;clearInterval(this.timer);}
}
module.exports={MissionService,feedback,ACTIVE};
