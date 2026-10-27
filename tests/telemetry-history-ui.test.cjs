'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepareHistory,historyFrame}=require('../public/utils/boatHistory');
const {createBoatChartSample,prepareBoatChart}=require('../public/utils/boatChart');
const {BoatTrack,TRACK_MAX_POINTS,TRACK_MAX_SEGMENTS}=require('../public/utils/boatTrack');

const wall=1_000_000,mono=100_000;
function velocity(overrides={}){
  return {received:true,fresh:true,ageMs:20,hasNavigation:true,fixValid:true,velocityValid:true,
    headingValid:true,headingDegrees:45,latitude:31.1,longitude:121.1,xMps:1.2,yMps:1.6,...overrides};
}
function boat(overrides={}){
  return {received:true,feedbackValid:true,headingValid:true,ageMs:20,speedLoop:true,controlMode:2,
    sbusValid:true,motorsValid:true,targetMps:2.5,actualMps:2.2,requestedMps:2.5,
    commonPercent:30,turnPercent:1,targetHeading:45,actualHeading:45,headingError:0,...overrides};
}
function sample(receivedAt,overrides={}){
  return {deviceId:'alpha',receivedAt,summary:{velocity:velocity(),boat:boat()},...overrides};
}
function result(samples,latest=samples.at(-1)){
  return {deviceId:'alpha',samples,latest,recording:{sampleMs:1000,persistent:true,lastSavedAt:wall-500}};
}
const projection=(latitude,longitude)=>({latitude,longitude});

test('历史按船隔离并排序，以服务器时钟转换为本页单调时钟；不生成实时权限',()=>{
  const records=[sample(wall-1000),sample(wall-3000),sample(wall-2000),sample(wall-1000,{deviceId:'beta'})];
  const history=prepareHistory(result(records,records[0]),'alpha',wall,mono);
  assert.deepEqual(history.chart.map(point=>point.timestamp),[mono-3000,mono-2000,mono-1000]);
  assert.equal(history.latest.ageMs,1000);
  assert.equal(history.receivedAt,wall-1000);
  assert.equal(history.last.speedMps,2.2);
  assert.equal(history.last.headingDegrees,45);
  assert.deepEqual(history.last.fix,{latitude:31.1,longitude:121.1});
  assert.equal('connected' in history,false);
  assert.equal('parametersReady' in history,false);
  assert.throws(()=>prepareHistory(result(records),'beta',wall,mono));
  assert.equal(prepareHistory(result([],sample(wall,{deviceId:'beta'})),'alpha',wall,mono).latest,null);
});

test('最后记录只显示采集当时有效的反馈，缺有效位、过期源与非法坐标不能伪装为有效读数',()=>{
  for(const invalid of [{received:false},{fresh:false},{ageMs:1000},{ageMs:-1},{ageMs:null}]){
    const latest=sample(wall-500,{summary:{velocity:velocity(invalid)}});
    const history=prepareHistory(result([],latest),'alpha',wall,mono);
    assert.deepEqual(history.last,{speedMps:null,headingDegrees:null,fix:null});
  }
  const invalid=sample(wall-500,{summary:{boat:boat({ageMs:1000}),
    velocity:velocity({velocityValid:undefined,headingValid:false,latitude:91})}});
  assert.deepEqual(prepareHistory(result([],invalid),'alpha',wall,mono).last,
    {speedMps:null,headingDegrees:null,fix:null});
  const fallback=sample(wall-500,{summary:{boat:boat({feedbackValid:false}),velocity:velocity()}});
  assert.equal(prepareHistory(result([],fallback),'alpha',wall,mono).last.speedMps,2);
});

test('完整状态帧保留电机和序号，畸形历史记录忽略且不影响其余数据',()=>{
  const status={sequence:123,timestampMs:456,motors:[{rpm:1200},{rpm:1300}],sbusValid:true};
  assert.deepEqual(historyFrame({status,velocity:velocity()}),{...status,velocity:velocity()});
  const records=[sample(wall-1000,{summary:{boat:{received:true}}}),sample(NaN),sample(wall+2000),
    sample(wall-500,{summary:{status,velocity:velocity(),boat:boat()}})];
  const history=prepareHistory(result(records),'alpha',wall,mono);
  assert.equal(history.chart.length,1);
  assert.equal(history.latest.frame.sequence,123);
  assert.deepEqual(history.latest.frame.motors,status.motors);
});

test('每秒历史样本形成连续速度与航向曲线，359°→1°正确展开，实时1秒断流规则保留',()=>{
  const records=[359,1,3].map((angle,index)=>sample(wall-3000+index*1000,
    {summary:{boat:boat({actualHeading:angle,targetHeading:angle})}}));
  const history=prepareHistory(result(records),'alpha',wall,mono);
  const chart=prepareBoatChart(history.chart,'heading');
  assert.deepEqual(chart.samples.map(point=>point.actual),[359,361,363]);
  assert.ok(chart.samples.every(point=>point.gapMs>1000));
  const first=createBoatChartSample({boat:boat({actualHeading:359,targetHeading:359})},0,0,true);
  const afterGap=createBoatChartSample({boat:boat({actualHeading:1,targetHeading:1})},1000,1000,true,first);
  assert.equal(afterGap.headingActualPlot,1);
  assert.equal(afterGap.gapMs,1000);
});

test('每秒定位历史恢复成彩色路径，遇无效定位和长空窗断开，不启动实时采集',()=>{
  const track=new BoatTrack(projection);
  const points=[0,1000,2000].map((timestamp,index)=>({timestamp,velocity:velocity({latitude:31+index*.00002,xMps:index<2?.2:2.8,yMps:0})}));
  track.restore(points);
  assert.equal(track.active,false);
  assert.equal(track.pointCount,3);
  assert.equal(track.segments.length,1);
  assert.deepEqual(track.polylines().map(line=>line.color),['#2563eb','#dc2626']);
  track.start();
  track.restore([...points,{timestamp:3000,velocity:velocity({fixValid:false})},
    {timestamp:4000,velocity:velocity()},{timestamp:5000,velocity:velocity()},
    {timestamp:11000,velocity:velocity()},{timestamp:12000,velocity:velocity()}]);
  assert.equal(track.active,true);
  assert.deepEqual(track.segments.map(segment=>segment.length),[3,2,2]);
  assert.equal(track.polylines().length,4);
});

test('历史路径恢复遵守点数和分段上限，重复时间不跨段连接',()=>{
  const track=new BoatTrack(projection);
  track.restore(Array.from({length:1100},(_,index)=>({timestamp:index*1000,velocity:velocity()})));
  assert.equal(track.pointCount,TRACK_MAX_POINTS);
  assert.equal(track.truncated,true);
  track.restore(Array.from({length:100},(_,index)=>({timestamp:index*6000,velocity:velocity()})));
  assert.equal(track.segments.length,TRACK_MAX_SEGMENTS);
  assert.equal(track.pointCount,TRACK_MAX_SEGMENTS);
  assert.equal(track.truncated,true);
  track.restore([{timestamp:0,velocity:velocity()},{timestamp:0,velocity:velocity()}]);
  assert.equal(track.segments.length,2);
  assert.equal(track.polylines().length,0);
});
