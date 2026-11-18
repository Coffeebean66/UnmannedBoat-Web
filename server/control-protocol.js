/* 网页驾驶使用独立的短时命令，不复用参数帧，也不允许客户端提交原始 MQTT 字节。 */
'use strict';
const TOKEN=/^[a-f0-9]{16}$/,ZERO='0000000000000000';
const validToken=value=>typeof value==='string'&&TOKEN.test(value);
const ACTION=Object.freeze({acquire:1,input:2,release:3,stop:4,host_enable:5,host_disable:6});
const isU32=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
function controls(value){
  if(!value||!Number.isInteger(value.mode)||value.mode<0||value.mode>2||
    !Number.isInteger(value.throttle)||Math.abs(value.throttle)>1000||
    !Number.isInteger(value.turn)||Math.abs(value.turn)>1000||
    !Number.isInteger(value.targetHeading)||value.targetHeading<0||value.targetHeading>35999||
    (value.testMode!==undefined&&typeof value.testMode!=='boolean')||(value.testMode&&value.mode!==0))
    throw Object.assign(Error('驾驶模式、运动量或目标航向超出范围'),{status:400});
  return value;
}
function command({token,uptimeMs,leaseId,sequence,action,...input}){
  controls(input);
  if(!validToken(token)||token===ZERO||!validToken(leaseId)||leaseId===ZERO||!isU32(uptimeMs)||!isU32(sequence)||!Object.hasOwn(ACTION,action))throw Error('Invalid BDC1 command');
  const packet=Buffer.alloc(40);packet.write('BDC1');Buffer.from(token,'hex').copy(packet,4);packet.writeUInt32LE(uptimeMs,12);
  Buffer.from(leaseId,'hex').copy(packet,16);packet.writeUInt32LE(sequence,24);packet[28]=ACTION[action];packet[29]=input.mode;
  packet.writeInt16LE(input.throttle,30);packet.writeInt16LE(input.turn,32);packet.writeUInt16LE(input.targetHeading,34);
  packet[36]=input.testMode?1:0;return packet;
}
function status(payload){
  if(!Buffer.isBuffer(payload)||payload.length>=448)return null;
  try{
    const value=JSON.parse(payload.toString('utf8'));
    const fields=['version','token','uptimeMs','state','leaseId','sequence','mode','reason','enabled','timeoutMs'];
    // 旧固件没有 testMode 字段；新固件显式上报该字段以声明测试场景能力。
    if(value&&Object.hasOwn(value,'testMode'))fields.push('testMode');
    if(value&&Object.hasOwn(value,'hostControl'))fields.push('hostControl');
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||
      value.version!==1||!validToken(value.token)||value.token===ZERO||!isU32(value.uptimeMs)||!Number.isInteger(value.state)||value.state<0||value.state>3||
      !validToken(value.leaseId)||!isU32(value.sequence)||!Number.isInteger(value.mode)||value.mode<0||value.mode>2||
      !Number.isInteger(value.reason)||value.reason<0||value.reason>7||value.enabled!==true||value.timeoutMs!==500||
      (Object.hasOwn(value,'testMode')&&(typeof value.testMode!=='boolean'||value.testMode&&(value.state!==1||value.mode!==0))))return null;
    const host=value.hostControl;
    if(host!==undefined){
      const keys=['enabled','valid','targetSpeedMmS','targetHeadingCdeg','ageMs','timeoutMs'];
      if(!host||typeof host!=='object'||Array.isArray(host)||Object.keys(host).length!==keys.length||Object.keys(host).some(key=>!keys.includes(key))||
        typeof host.enabled!=='boolean'||typeof host.valid!=='boolean'||host.enabled!==(value.state===3)||
        !Number.isInteger(host.targetSpeedMmS)||host.targetSpeedMmS< -32768||host.targetSpeedMmS>32767||
        !Number.isInteger(host.targetHeadingCdeg)||host.targetHeadingCdeg<0||host.targetHeadingCdeg>65535||
        !Number.isInteger(host.ageMs)||host.ageMs<0||host.ageMs>65535||host.timeoutMs!==300||
        host.valid&&(host.ageMs>=300||host.targetHeadingCdeg>=36000)||
        host.enabled&&(value.mode!==2||value.testMode===true||value.leaseId===ZERO))return null;
    }else if(value.state===3||value.reason>5)return null;
    return value;
  }catch(_){return null;}
}
module.exports={ACTION,TOKEN,ZERO,validToken,isU32,controls,command,status};
