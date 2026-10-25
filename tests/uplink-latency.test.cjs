'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {CloudBridge,validateTelemetry}=require('../server/cloud');
const {UplinkClock,unwrapTelemetry,isSyncResponse}=require('../server/latency-protocol');
const P=require('../public/utils/uart4Protocol'),PP=require('../server/parameter-protocol');
const SESSION='0123456789abcdef',OTHER='fedcba9876543210';
const ENV={BOAT_CLOUD_ENABLED:'1',BOAT_MQTT_URL:'mqtt://broker.test:1883'};
function rawTelemetry(){
  const result=Buffer.alloc(176);
  for(const [offset,length,version,type]of [[0,64,1,1],[64,40,2,2],[104,36,2,3],[140,36,1,4]]){
    const frame=result.subarray(offset,offset+length);frame.set([0xa5,0x5a,version,type,length]);
    frame.writeUInt16LE(P.crc16CcittFalse(frame,2,length-4),length-2);
  }
  return result;
}
function timedTelemetry(tick,session=SESSION){const result=Buffer.alloc(192);result.write('BTL1');Buffer.from(session,'hex').copy(result,4);result.writeUInt32LE(tick,12);rawTelemetry().copy(result,16);return result;}
function response(probe,rx,tx){const result=Buffer.alloc(28);(probe.payload||probe).copy(result,0,0,20);result.writeUInt32LE(rx,20);result.writeUInt32LE(tx,24);return result;}
function clockFixture(){const clock=new UplinkClock();clock.observe(SESSION);return clock;}
class FakeMQTT extends EventEmitter {
  constructor(){super();this.connected=true;this.sent=[];}
  subscribe(topics,options,callback){callback(null);}
  publish(topic,payload,options,callback){const request={topic,payload:Buffer.from(payload),options,callback};this.sent.push(request);if(this.publishError)callback?.(this.publishError);}
  end(){}
}
function fixture(t){
  let mono=1000,wall=10000;const client=new FakeMQTT(),events=[];
  const bridge=new CloudBridge({env:ENV,connect:()=>client,now:()=>wall,monotonicNow:()=>mono,tickMs:60000});
  bridge.on('telemetry',value=>events.push(value));bridge.start();client.emit('connect');t.after(()=>bridge.stop());
  return {client,bridge,events,setMono:value=>{mono=value;},setWall:value=>{wall=value;},
    telemetry:(tick,id='boat-01',session=SESSION,packet={})=>bridge.acceptMessage('boats/'+id+'/telemetry',timedTelemetry(tick,session),packet),
    reply:(probe,rx,tx,id='boat-01',packet={})=>bridge.acceptMessage('boats/'+id+'/parameter-response',response(probe,rx,tx),packet)};
}

test('BTL1 unwrap requires exact length, magic and nonzero session while the raw UART layout remains strict',()=>{
  const raw=rawTelemetry(),timed=timedTelemetry(0xffffffff);
  assert.equal(validateTelemetry(raw),true);assert.equal(validateTelemetry(timed),false);
  assert.deepEqual(unwrapTelemetry(raw),{payload:raw,session:null,tick:null});
  assert.deepEqual(unwrapTelemetry(timed),{payload:raw,session:SESSION,tick:0xffffffff});
  for(const bad of [timed.subarray(1),Buffer.concat([timed,Buffer.alloc(1)]),Buffer.alloc(192),Buffer.alloc(20)])assert.equal(unwrapTelemetry(bad),null);
  const high=Buffer.from(timed);high[0]|=0x80;assert.equal(unwrapTelemetry(high),null);
  const zero=Buffer.from(timed);zero.fill(0,4,12);assert.equal(unwrapTelemetry(zero),null);
  assert.equal(isSyncResponse(response(Buffer.alloc(20),1,2)),false);
});

test('four timestamps subtract device scheduling and derive a per-packet one-way uplink estimate',()=>{
  const clock=clockFixture(),probe=clock.probe(1000);
  assert.equal(probe.payload.length,20);assert.equal(probe.payload.toString('ascii',0,4),'BTS1');assert.equal(probe.payload.subarray(4,12).toString('hex'),SESSION);
  assert.equal(clock.estimate(100,1050),null);
  assert.equal(clock.accept(response(probe,100,120),1120),true); // 120ms total - 20ms firmware wait = 100ms RTT.
  const timing=clock.estimate(200,1180);assert.equal(timing.uplinkRttMs,100);assert.equal(timing.uplinkDelayMs,30);assert.ok(timing.uplinkUncertaintyMs>=52);
  assert.equal(clock.estimate(231,1180).uplinkDelayMs,0); // Small tick calibration error is bounded, then clamped.
  assert.equal(clock.estimate(20000,1180),null);assert.equal(clock.estimate(0,10000),null);
  assert.equal(clock.accept(response(probe,100,120),1121),false);
});

test('clock calibration and telemetry tick differences survive uint32 HAL tick wrap',()=>{
  const clock=clockFixture(),probe=clock.probe(1000);
  assert.equal(clock.accept(response(probe,0xfffffff0,0x10),1132),true);
  assert.equal(clock.estimate(0x20,1148).uplinkDelayMs,50);assert.equal(clock.estimate(0x20,1148).uplinkRttMs,100);
});

test('probes are limited to once per five seconds and stale samples/pending responses become unknown',()=>{
  const clock=clockFixture(),probe=clock.probe(1000);assert.equal(clock.probe(1100),null);
  assert.equal(clock.accept(response(probe,100,120),1120),true);assert.equal(clock.probe(5999),null);
  const second=clock.probe(6000);assert.ok(second);assert.equal(clock.probe(7000),null);
  assert.equal(clock.accept(response(second,5000,5000),11000),false); // Pending timeout cannot accept a late reply.
  assert.equal(clock.estimate(30100,31120),null);assert.equal(clock.samples.length,0);
  clock.observe(OTHER);assert.equal(clock.probe(10999),null);assert.ok(clock.probe(11000)); // Session churn cannot bypass rate limit.
});

test('lowest recent RTT is used and expired or physically invalid calibration never claims a delay',()=>{
  const clock=clockFixture();let probe=clock.probe(1000);assert.equal(clock.accept(response(probe,100,100),1200),true);
  probe=clock.probe(6000);assert.equal(clock.accept(response(probe,5000,5000),6040),true);
  probe=clock.probe(11000);assert.equal(clock.accept(response(probe,10000,10000),11100),true);
  assert.equal(clock.estimate(10100,11170).uplinkDelayMs,50);assert.equal(clock.estimate(10100,11170).uplinkRttMs,40);
  clock.reset();clock.observe(SESSION);probe=clock.probe(16000);assert.equal(clock.accept(response(probe,100,400),16100),false);assert.equal(clock.estimate(500,16200),null);
  probe=clock.probe(21000);assert.equal(clock.accept(response(probe,400,100),21100),false);
});

test('wrong device/session/challenge, retained and duplicate synchronization replies cannot calibrate',t=>{
  const f=fixture(t);assert.equal(f.telemetry(100),true);const probe=f.client.sent[0];
  assert.equal(probe.topic,'boats/boat-01/parameter-command');assert.deepEqual(probe.options,{qos:0,retain:false});
  assert.equal(f.events[0].uplinkDelayMs,undefined);assert.equal(Buffer.from(f.events[0].payload,'base64').length,176);
  f.setMono(1120);assert.equal(f.reply(probe,100,120,'other'),false);assert.equal(f.reply(probe,100,120,'boat-01',{retain:true}),false);
  const bad=response(probe,100,120);bad[12]^=1;assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',bad),false);
  const wrong=response(probe,100,120);Buffer.from(OTHER,'hex').copy(wrong,4);assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',wrong),false);
  assert.equal(f.reply(probe,100,120),true);assert.equal(f.reply(probe,100,120),false);
  assert.equal(f.events.length,1);assert.equal(f.bridge.get('boat-01').lastReceivedAt,10000);
  f.setMono(1180);f.telemetry(200);assert.equal(f.events[1].uplinkDelayMs,30);assert.equal(f.events[1].uplinkRttMs,100);assert.deepEqual(Buffer.from(f.events[1].payload,'base64'),rawTelemetry());
});

test('legacy telemetry remains monitorable without probes and malformed BTL1 cannot renew a device',t=>{
  const f=fixture(t);assert.equal(f.bridge.acceptMessage('boats/legacy/telemetry',rawTelemetry()),true);assert.equal(f.client.sent.length,0);assert.equal(f.events[0].uplinkDelayMs,undefined);
  assert.equal(f.telemetry(100,'boat-01',SESSION,{retain:true}),false);assert.equal(f.bridge.get('boat-01'),null);
  const bad=timedTelemetry(100);bad[30]^=1;assert.equal(f.bridge.acceptMessage('boats/boat-01/telemetry',bad),false);assert.equal(f.client.sent.length,0);
  f.telemetry(100);assert.equal(f.client.sent.length,1);assert.equal(f.events.at(-1).ageMs,0);
});

test('clock estimates ignore wall-clock adjustments and clear on offline, reconnect or changed session',t=>{
  const f=fixture(t);f.telemetry(100);let probe=f.client.sent.at(-1);f.setMono(1120);f.reply(probe,100,120);
  f.setWall(9000);f.setMono(1180);f.telemetry(200);assert.equal(f.events.at(-1).uplinkDelayMs,30);assert.equal(f.events.at(-1).receivedAt,9000);
  f.bridge.acceptMessage('boats/boat-01/status',Buffer.from('offline'));f.setMono(1200);assert.equal(f.reply(probe,100,120),false);f.telemetry(210);assert.equal(f.events.at(-1).uplinkDelayMs,undefined);
  f.setMono(6000);f.telemetry(300);probe=f.client.sent.at(-1);f.client.emit('close');f.client.emit('connect');f.setMono(6120);assert.equal(f.reply(probe,300,320),false);
  f.telemetry(400);assert.equal(f.events.at(-1).uplinkDelayMs,undefined);
  f.setMono(11000);f.telemetry(500);probe=f.client.sent.at(-1);f.setMono(11120);f.reply(probe,500,520);
  f.setMono(11180);f.telemetry(600,'boat-01',OTHER);assert.equal(f.events.at(-1).uplinkDelayMs,undefined);assert.equal(f.bridge.devices.get('boat-01').uplinkClock.samples.length,0);
});

test('offline freshness and stale publication callbacks cannot carry clock state into a later probe',t=>{
  const f=fixture(t);f.telemetry(100);const old=f.client.sent[0];f.setMono(1120);f.reply(old,100,120);
  f.setWall(14000);f.bridge.refresh();assert.equal(f.bridge.devices.get('boat-01').uplinkClock.samples.length,0);
  f.setMono(6000);f.telemetry(1000);const current=f.client.sent.at(-1);old.callback(Error('late failure'));
  f.setMono(6120);assert.equal(f.reply(current,1000,1020),true);f.setMono(6180);f.telemetry(1100);assert.equal(f.events.at(-1).uplinkDelayMs,30);
});

test('timing replies are independent from BPC1 parameter responses and do not consume a parameter token',async t=>{
  const f=fixture(t);f.telemetry(100);const probe=f.client.sent[0];
  const token='1111111111111111';f.bridge.acceptMessage('boats/boat-01/parameter-capability',Buffer.from(JSON.stringify({version:1,token,uptimeMs:100})));
  assert.equal(f.bridge.get('boat-01').parametersReady,true);const command=f.bridge.requestParameters('boat-01','read');const packet=f.client.sent.at(-1).payload;
  assert.equal(packet.toString('ascii',0,4),'BPC1');assert.equal(f.bridge.pendingParameters.size,1);
  f.setMono(1120);assert.equal(f.reply(probe,100,120),true);assert.equal(f.bridge.pendingParameters.size,1);
  const values=Object.fromEntries(Object.entries(PP.RANGES).map(([key,[minimum]])=>[key,minimum]));
  const frame=Buffer.from(P.encodeParameterWriteRequest(packet.readUInt32LE(22),values));frame[3]=0x90;frame.writeUInt16LE(P.crc16CcittFalse(frame,2,52),54);
  const reply=Buffer.from(packet);frame.copy(reply,16);assert.equal(f.bridge.acceptMessage('boats/boat-01/parameter-response',reply),true);assert.deepEqual(await command,frame);
  assert.equal(f.bridge.get('boat-01').parametersReady,false);
});
