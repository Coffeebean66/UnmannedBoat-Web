/* MQTT 只传递每艘船的视频地址；媒体内容由浏览器直接向授权的视频服务读取。 */
'use strict';
const {TextDecoder}=require('node:util');
const utf8=new TextDecoder('utf-8',{fatal:true});
const FORMATS=new Set(['auto','hls','flv','native']);
const CONTROL=/[\u0000-\u001f\u007f]/;

function webUrl(value){
  if(typeof value!=='string'||value.length===0||value.length>2048||value!==value.trim()||CONTROL.test(value)||value.includes('#')||value.includes('\\')||!/^https?:\/\//i.test(value))return null;
  try{
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||value.split('/')[2].includes('@')||!url.hostname||url.hostname.includes('*'))return null;
    return url;
  }catch(_){return null;}
}

function decodeVideoDescriptor(payload){
  if(!Buffer.isBuffer(payload)||payload.length===0||payload.length>4096)return null;
  let value;
  try{value=JSON.parse(utf8.decode(payload));}catch(_){return null;}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||
    Object.keys(value).some(key=>!['version','url','format','title','enabled'].includes(key)))return null;
  if(value.enabled===false)return Object.keys(value).every(key=>['version','enabled'].includes(key))?{version:1,enabled:false}:null;
  if(Object.hasOwn(value,'enabled')&&value.enabled!==true)return null;
  if(!webUrl(value.url))return null;
  const format=value.format===undefined?'auto':value.format,title=value.title===undefined?'':value.title;
  if(!FORMATS.has(format)||typeof title!=='string'||Array.from(title).length>64||CONTROL.test(title))return null;
  return {version:1,url:value.url,format,title};
}

function readVideoConfig(env=process.env){
  const raw=env.BOAT_VIDEO_ALLOWED_ORIGINS;
  if(raw===undefined||raw==='')return {allowedOrigins:[]};
  if(typeof raw!=='string'||raw.length>4096)throw Error('Invalid BOAT_VIDEO_ALLOWED_ORIGINS');
  const entries=raw.trim().split(/[\s,]+/).filter(Boolean);
  if(entries.length>16)throw Error('BOAT_VIDEO_ALLOWED_ORIGINS supports at most 16 origins');
  const allowedOrigins=[];
  for(const entry of entries){
    const url=webUrl(entry);
    // 精确来源仅包括协议、主机及端口，不能注入 CSP 标记或带入路径/密钥。
    if(!url||url.pathname!=='/'||url.search||url.hash||entry!==url.origin&&entry!==url.origin+'/'||/[\s;'"<>]/.test(url.origin))throw Error('Invalid BOAT_VIDEO_ALLOWED_ORIGINS');
    if(!allowedOrigins.includes(url.origin))allowedOrigins.push(url.origin);
  }
  return {allowedOrigins};
}

function getVideoContentSecurityPolicy(basePolicy,env=process.env){
  const {allowedOrigins}=readVideoConfig(env),directives=String(basePolicy).split(';').map(value=>value.trim()).filter(Boolean);
  let hasConnect=false;
  const policy=directives.filter(value=>!/^media-src(?:\s|$)/.test(value)).map(value=>{
    if(!/^connect-src(?:\s|$)/.test(value))return value;
    hasConnect=true;
    return [...new Set([...value.split(/\s+/),...allowedOrigins])].join(' ');
  });
  if(!hasConnect)policy.push(['connect-src',"'self'",...allowedOrigins].join(' '));
  policy.push(['media-src',"'self'",'blob:',...allowedOrigins].join(' '));
  return policy.join('; ');
}

module.exports={decodeVideoDescriptor,readVideoConfig,getVideoContentSecurityPolicy};
