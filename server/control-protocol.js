/* 网页驾驶使用独立的短时命令，不复用参数帧，也不允许客户端提交原始 MQTT 字节。 */
'use strict';
const TOKEN=/^[a-f0-9]{16}$/,ZERO='0000000000000000';
const validToken=value=>typeof value==='string'&&TOKEN.test(value);
const ACTION=Object.freeze({acquire:1,input:2,release:3,stop:4});
const isU32=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
function controls(value){
  if(!value||!Number.isInteger(value.mode)||value.mode<0||value.mode>2||
    !Number.isInteger(value.throttle)||Math.abs(value.throttle)>1000||
    !Number.isInteger(value.turn)||Math.abs(value.turn)>1000||
    !Number.isInteger(value.targetHeading)||value.targetHeading<0||value.targetHeading>35999)
    throw Object.assign(Error('驾驶模式、运动量或目标航向超出范围'),{status:400});
  return value;
}
function command({token,uptimeMs,leaseId,sequence,action,...input}){
  controls(input);
  if(!validToken(token)||token===ZERO||!validToken(leaseId)||leaseId===ZERO||!isU32(uptimeMs)||!isU32(sequence)||!Object.hasOwn(ACTION,action))throw Error('Invalid BDC1 command');
  const packet=Buffer.alloc(40);packet.write('BDC1');Buffer.from(token,'hex').copy(packet,4);packet.writeUInt32LE(uptimeMs,12);
  Buffer.from(leaseId,'hex').copy(packet,16);packet.writeUInt32LE(sequence,24);packet[28]=ACTION[action];packet[29]=input.mode;
  packet.writeInt16LE(input.throttle,30);packet.writeInt16LE(input.turn,32);packet.writeUInt16LE(input.targetHeading,34);return packet;
}
function status(payload){
  if(!Buffer.isBuffer(payload)||payload.length>256)return null;
  try{
    const value=JSON.parse(payload.toString('utf8'));
    const fields=['version','token','uptimeMs','state','leaseId','sequence','mode','reason','enabled','timeoutMs'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||
      value.version!==1||!validToken(value.token)||value.token===ZERO||!isU32(value.uptimeMs)||!Number.isInteger(value.state)||value.state<0||value.state>2||
      !validToken(value.leaseId)||!isU32(value.sequence)||!Number.isInteger(value.mode)||value.mode<0||value.mode>2||
      !Number.isInteger(value.reason)||value.reason<0||value.reason>5||value.enabled!==true||value.timeoutMs!==500)return null;
    return value;
  }catch(_){return null;}
}
module.exports={ACTION,TOKEN,ZERO,validToken,isU32,controls,command,status};
