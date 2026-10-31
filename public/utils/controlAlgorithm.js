/* MQTT 管理命令扩展，复用原56字节信封；不改变20项PID参数和Flash格式。 */
'use strict';
const P=require('./uart4Protocol');
const names=['原算法（PID＋前视航线）','最优控制（LQR/LQI＋LQR航线）'];
function command(sequence,algorithm){
  if(!Number.isInteger(algorithm)||algorithm<0||algorithm>1)throw Error('控制算法只能选择原算法或LQR');
  const frame=P.encodeParameterReadRequest(sequence);frame[3]=0x13;frame[14]=algorithm;
  const crc=P.crc16CcittFalse(frame,2,52);frame[54]=crc&255;frame[55]=crc>>>8;return frame;
}
function response(value){
  const b=Uint8Array.from(value||[]);
  if(b.length!==56||b[0]!==0xa5||b[1]!==0x5a||b[2]!==5||b[3]!==0x91||b[4]!==56||b[14]>1||b[15]!==0||
    b.slice(16,54).some(x=>x!==0)||P.crc16CcittFalse(b,2,52)!==(b[54]|b[55]<<8))return null;
  const u32=i=>(b[i]|b[i+1]<<8|b[i+2]<<16|b[i+3]<<24)>>>0;
  return {messageType:0x91,status:b[5],requestSequence:u32(6),timestampMs:u32(10),algorithm:b[14]};
}
module.exports={names,command,response};
