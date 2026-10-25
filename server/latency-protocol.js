/* MQTT 双向校时仅估计单向上行耗时；使用单调时钟，独立于参数令牌和系统日期。 */
'use strict';
const crypto=require('node:crypto');
const TELEMETRY_MAGIC=Buffer.from('BTL1'),SYNC_MAGIC=Buffer.from('BTS1');
const PROBE_INTERVAL_MS=5000,PROBE_TIMEOUT_MS=5000,SAMPLE_TTL_MS=30000,MAX_DELAY_MS=5000;

function unwrapTelemetry(payload){
  if(!Buffer.isBuffer(payload))return null;
  if(payload.length===176)return {payload,session:null,tick:null};
  if(payload.length!==192||!payload.subarray(0,4).equals(TELEMETRY_MAGIC)||!payload.subarray(4,12).some(byte=>byte!==0))return null;
  return {payload:payload.subarray(16),session:payload.subarray(4,12).toString('hex'),tick:payload.readUInt32LE(12)};
}

function isSyncResponse(payload){return Buffer.isBuffer(payload)&&payload.length===28&&payload.subarray(0,4).equals(SYNC_MAGIC);}

class UplinkClock {
  constructor(){this.session=null;this.pending=null;this.samples=[];this.lastProbeAt=-Infinity;}
  reset(){this.session=null;this.pending=null;this.samples=[];}
  observe(session){
    if(this.session!==session){this.reset();this.session=session;}
  }
  expire(now){
    if(!Number.isFinite(now)){this.reset();return;}
    if(this.pending&&(now<this.pending.started||now-this.pending.started>=PROBE_TIMEOUT_MS))this.pending=null;
    this.samples=this.samples.filter(sample=>now>=sample.receivedAt&&now-sample.receivedAt<SAMPLE_TTL_MS);
  }
  probe(now){
    this.expire(now);
    if(!this.session||this.pending||!Number.isFinite(now)||now-this.lastProbeAt<PROBE_INTERVAL_MS)return null;
    const payload=Buffer.alloc(20);SYNC_MAGIC.copy(payload);Buffer.from(this.session,'hex').copy(payload,4);crypto.randomBytes(8).copy(payload,12);
    const pending={payload,started:now,session:this.session};
    this.pending=pending;this.lastProbeAt=now;return pending;
  }
  cancel(pending){if(this.pending===pending)this.pending=null;}
  accept(payload,now){
    this.expire(now);const pending=this.pending;
    if(!pending||!isSyncResponse(payload)||pending.session!==this.session||!payload.subarray(0,20).equals(pending.payload))return false;
    // 收到完整匹配的回应后消费挑战；重复回应不得再次校时。
    this.pending=null;
    const receivedTick=payload.readUInt32LE(20),sentTick=payload.readUInt32LE(24);
    const processing=(sentTick-receivedTick)>>>0,total=now-pending.started,rtt=total-processing;
    if(processing>PROBE_TIMEOUT_MS||!Number.isFinite(total)||total<0||rtt<0||rtt>MAX_DELAY_MS)return false;
    this.samples.push({tick:sentTick,serverAt:now-rtt/2,receivedAt:now,rtt});
    if(this.samples.length>8)this.samples.shift();return true;
  }
  estimate(tick,now){
    this.expire(now);
    if(!this.session||!Number.isInteger(tick)||tick<0||tick>0xffffffff||!this.samples.length)return null;
    // 最近30秒内采用最小网络RTT，降低校时包排队导致的偏移；HAL tick差值可跨回绕。
    const sample=this.samples.reduce((best,value)=>value.rtt<best.rtt?value:best);
    const elapsedTick=(tick-sample.tick)|0,delay=now-sample.serverAt-elapsedTick;
    const uncertainty=sample.rtt/2+2+(now-sample.receivedAt)*0.0001;
    if(!Number.isFinite(delay)||delay< -uncertainty||delay>MAX_DELAY_MS)return null;
    return {uplinkDelayMs:Math.max(0,delay),uplinkRttMs:sample.rtt,uplinkUncertaintyMs:uncertainty};
  }
}

module.exports={unwrapTelemetry,isSyncResponse,UplinkClock,PROBE_INTERVAL_MS,PROBE_TIMEOUT_MS,SAMPLE_TTL_MS,MAX_DELAY_MS};
