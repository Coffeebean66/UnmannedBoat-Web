/* LQI/LQR在线参数：协议为15个小端uint16，网页以工程单位编辑。
 * 模型参数只在停稳写入时求解，采样周期固定100ms；与原20项参数独立。 */
'use strict';
const P=require('./uart4Protocol');
const fields=Object.freeze([
  ['speedGainMmS','船速模型稳态增益',100,20000,1000,'m/s',2500,'船速 LQI','100%推进时的稳态船速初估；应以水测结果校准。'],
  ['speedTauMs','船速响应时间常数',100,10000,1000,'s',2000,'船速 LQI','固定推进阶跃后达到最终速度变化约63%的时间。'],
  ['speedQErrorX100','速度误差权重 Q',1,10000,100,'',400,'船速 LQI','增大通常使跟随更积极，过大可能振荡或频繁限幅。'],
  ['speedQIntegralX100','速度积分权重 Q',1,10000,100,'',100,'船速 LQI','增大可加强静差消除，需同时观察积分限幅与过冲。'],
  ['speedRInputX100','推进修正权重 R',1,10000,100,'',200,'船速 LQI','增大通常减小推进修正，使控制更平缓。'],
  ['yawGainCdegS','转向模型稳态角速度',100,36000,100,'°/s',9000,'航向 LQR','100%逻辑差速对应的稳态角速度初估。'],
  ['yawTauMs','转向响应时间常数',50,10000,1000,'s',700,'航向 LQR','角速度响应达到最终变化约63%的时间。'],
  ['yawQAngleX100','航向误差权重 Q',1,10000,100,'',400,'航向 LQR','增大通常使航向纠正更积极。'],
  ['yawQRateX100','角速度权重 Q',1,10000,100,'',100,'航向 LQR','增大通常加强阻尼，减少航向过冲。'],
  ['yawRInputX100','差速输出权重 R',1,10000,100,'',400,'航向 LQR','增大通常减小差速动作，转向更平缓。'],
  ['guidanceTauMs','航线内层航向时间常数',100,10000,1000,'s',1200,'航线 LQR','服务器采用的航向闭环响应估计。下次开始任务时读取应用。'],
  ['guidanceQCrossX100','横向偏差权重 Q',1,10000,100,'',25,'航线 LQR','增大通常加强向当前航段的纠偏。'],
  ['guidanceQYawX100','航线相对航向权重 Q',1,10000,100,'',200,'航线 LQR','增大通常抑制沿航线航行时的航向摆动。'],
  ['guidanceRInputX100','航线纠偏输出权重 R',1,10000,100,'',400,'航线 LQR','增大通常减小目标航向偏置。'],
  ['guidanceMaxCdeg','最大航线纠偏角',500,8000,100,'°',6000,'航线 LQR','限制相对航段方向的目标偏置，范围5—80°。']
].map(([key,label,min,max,scale,unit,value,group,help])=>Object.freeze({key,label,min,max,scale,unit,value,group,help})));
const defaults=Object.freeze(Object.fromEntries(fields.map(f=>[f.key,f.value])));
const kinds=Object.freeze({optimalRead:0x14,optimalWrite:0x15,optimalFlash:0x16});
function validate(values){
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length!==fields.length||
    fields.some(f=>!Object.hasOwn(values,f.key)||!Number.isInteger(values[f.key])||values[f.key]<f.min||values[f.key]>f.max))throw Error('LQR参数必须包含完整的15项范围内数值');
  return values;
}
function command(kind,sequence,values){
  if(!Object.hasOwn(kinds,kind))throw Error('LQR参数命令不正确');
  if(kind==='optimalRead'){if(values!==undefined)throw Error('读取LQR参数不能附带写入值');}else validate(values);
  const b=P.encodeParameterReadRequest(sequence);b[3]=kinds[kind];
  if(values)fields.forEach((f,i)=>{b[14+i*2]=values[f.key]&255;b[15+i*2]=values[f.key]>>>8;});
  const crc=P.crc16CcittFalse(b,2,52);b[54]=crc&255;b[55]=crc>>>8;return b;
}
function response(value){
  const b=Uint8Array.from(value||[]),u16=i=>b[i]|b[i+1]<<8;
  if(b.length!==56||b[0]!==0xa5||b[1]!==0x5a||b[2]!==5||b[3]!==0x92||b[4]!==56||b[5]>6||
    b.slice(46,54).some(x=>x!==0)||u16(44)<100||u16(44)>20000||P.crc16CcittFalse(b,2,52)!==u16(54))return null;
  const parameters=Object.fromEntries(fields.map((f,i)=>[f.key,u16(14+i*2)]));
  try{validate(parameters);}catch(_){return null;}
  const u32=i=>(b[i]|b[i+1]<<8|b[i+2]<<16|b[i+3]<<24)>>>0;
  return {messageType:0x92,status:b[5],requestSequence:u32(6),timestampMs:u32(10),parameters,maxTargetMmS:u16(44)};
}
function guidanceConfig(values){validate(values);return {sampleS:.1,headingTauS:values.guidanceTauMs/1000,crossWeight:values.guidanceQCrossX100/100,
  headingWeight:values.guidanceQYawX100/100,inputWeight:values.guidanceRInputX100/100,maxOffsetDeg:values.guidanceMaxCdeg/100};}
module.exports={fields,defaults,kinds,validate,command,response,guidanceConfig};
