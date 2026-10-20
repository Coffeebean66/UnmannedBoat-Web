/* 云端参数信封只允许完整 v5 参数帧，不接受浏览器提供的原始 MQTT 数据。 */
'use strict';
const P=require('../public/utils/uart4Protocol');
const {HEADING_PARAMETER_RANGES}=require('../public/utils/headingParameters');
const RANGES=Object.freeze({feedforwardX2PerMps:[0,200],kpX2PerMps:[0,1000],kiX2PerMpsS:[0,1000],kdX2PerMps2:[0,1000],
  integralLimitX2:[0,200],correctionLimitX2:[0,200],outputLimitX2:[1,200],outputSlewStepX2:[1,200],turnAtFullSpeedPercent:[0,100],
  motor1Reversed:[0,1],motor2Reversed:[0,1],maxTargetMmS:[100,20000],targetSlewStepMmS:[1,400],...HEADING_PARAMETER_RANGES});
const KINDS=new Set(['read','write','flash']);
function validateValues(values){
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length!==20||Object.keys(values).some(key=>!Object.hasOwn(RANGES,key)))throw Error('参数必须包含完整的20项字段');
  for(const [key,[min,max]]of Object.entries(RANGES))if(typeof values[key]!=='number'||!Number.isInteger(values[key])||values[key]<min||values[key]>max)throw Error('参数 '+key+' 超出允许范围');
  return values;
}
function validateOperation(kind,values){if(!KINDS.has(kind))throw Error('参数操作类型不正确');if(kind==='read'){if(values!==undefined)throw Error('读取参数不能附带写入值');}else validateValues(values);}
function capability(payload){
  if(!Buffer.isBuffer(payload)||payload.length>256)return null;
  try{const value=JSON.parse(payload.toString('utf8'));if(!value||value.version!==1||typeof value.token!=='string'||!(/^[0-9a-f]{16}$/).test(value.token)||!Number.isInteger(value.uptimeMs)||value.uptimeMs<0||value.uptimeMs>0xffffffff||Object.keys(value).some(key=>!['version','token','uptimeMs'].includes(key)))return null;return {token:value.token,uptimeMs:value.uptimeMs};}catch(_){return null;}
}
function commandFrame(kind,sequence,values){validateOperation(kind,values);return Buffer.from(kind==='read'?P.encodeParameterReadRequest(sequence):kind==='flash'?P.encodeParameterSaveRequest(sequence,values):P.encodeParameterWriteRequest(sequence,values));}
function envelope(token,uptimeMs,frame){const result=Buffer.alloc(72);result.write('BPC1',0,'ascii');Buffer.from(token,'hex').copy(result,4);result.writeUInt32LE(uptimeMs,12);frame.copy(result,16);return result;}
function response(payload){
  if(!Buffer.isBuffer(payload)||payload.length!==72||payload.toString('ascii',0,4)!=='BPC1')return null;
  const frame=payload.subarray(16),decoded=P.decodeParameterFrame(frame);if(!decoded)return null;
  // 错误响应也必须带合法当前参数；状态交给调用方显示，不伪装成写入成功。
  try{validateValues(decoded.parameters);}catch(_){return null;}
  return {token:payload.subarray(4,12).toString('hex'),uptimeMs:payload.readUInt32LE(12),sequence:decoded.requestSequence,frame:Buffer.from(frame),status:decoded.status};
}
module.exports={RANGES,validateValues,validateOperation,capability,commandFrame,envelope,response};
