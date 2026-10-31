/* 任务库仅保存航线定义，不保存可恢复的运动命令；重启必须由管理员重新开始。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {resolveMapConfigFile}=require('./map-config');
const {distance}=require('../public/utils/missionNavigation');
const {DEVICE}=require('./control-service');
const fault=(status,message)=>Object.assign(Error(message),{status});
const ID=/^[a-f0-9]{16}$/;
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
function normalizeRoute(input){
  const required=['name','speedMps','arrivalRadiusM','points'],keys=[...required,'loopEnabled','loopCount'];
  if(!plain(input)||required.some(k=>!Object.hasOwn(input,k))||Object.keys(input).some(k=>!keys.includes(k)))throw fault(400,'航线字段不正确');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80||/[\x00-\x1f]/.test(input.name))throw fault(400,'任务名称须为 1—80 个字符');
  if(!Number.isFinite(input.speedMps)||input.speedMps<0.1||input.speedMps>20)throw fault(400,'任务航速须为 0.1—20 m/s，且执行时不能超过船端最大速度');
  if(!Number.isFinite(input.arrivalRadiusM)||input.arrivalRadiusM<1||input.arrivalRadiusM>50)throw fault(400,'到点半径须为 1—50 米');
  // 旧航线和旧版客户端省略循环字段时，继续按单次航线执行。
  const loopEnabled=Object.hasOwn(input,'loopEnabled')?input.loopEnabled:false,loopCount=Object.hasOwn(input,'loopCount')?input.loopCount:1;
  if(typeof loopEnabled!=='boolean')throw fault(400,'循环开关须为布尔值');
  if(!Number.isSafeInteger(loopCount)||loopCount<1||loopCount>999)throw fault(400,'循环次数须为 1—999 的整数');
  if(!Array.isArray(input.points)||input.points.length<2||input.points.length>256)throw fault(400,'航线须有开始点、结束点，总数为 2—256 点');
  const points=input.points.map(p=>{
    if(!plain(p)||Object.keys(p).length!==2||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||Math.abs(p.latitude)>85||Math.abs(p.longitude)>180)throw fault(400,'航点须为有效 WGS84 经纬度（纬度 ±85° 内）');
    return {latitude:p.latitude,longitude:p.longitude};
  });
  let lengthM=0;
  for(let i=1;i<points.length;i++){const d=distance(points[i-1],points[i]);if(d<0.5||d>20000)throw fault(400,'相邻航点距离须为 0.5 米—20 千米');lengthM+=d;}
  if(loopEnabled){
    const closingM=distance(points[points.length-1],points[0]);
    if(closingM>20000)throw fault(400,'终点返回起点的直线距离不能超过 20 千米');
    lengthM+=closingM;
  }
  if(lengthM>100000)throw fault(400,'单圈航线总长（含启用循环后的返回航段）不能超过 100 千米');
  return {name:input.name.trim(),speedMps:input.speedMps,arrivalRadiusM:input.arrivalRadiusM,loopEnabled,loopCount,points};
}
class MissionStore{
  constructor({env=process.env,file,now=Date.now}={}){
    this.now=now;this.routes=new Map();this.error='';this.file='';
    try{
      const target=file||env.BOAT_MISSION_FILE;
      this.file=target?resolveMapConfigFile(env,target):path.join(path.dirname(resolveMapConfigFile({...env,BOAT_MAP_CONFIG_FILE:undefined})),'missions.json');
      const stat=fs.lstatSync(this.file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error('Invalid mission file');
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(!plain(data)||![1,2].includes(data.version)||Object.keys(data).length!==2||!Array.isArray(data.routes)||data.routes.length>128)throw Error('Invalid mission library');
      for(const r of data.routes){
        if(!plain(r)||Object.keys(r).length!==(data.version===1?8:10)||!ID.test(r.id)||!DEVICE.test(r.deviceId)||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isFinite(r.updatedAt)||this.routes.has(r.id))throw Error('Invalid mission metadata');
        const {id,deviceId,revision,updatedAt,...definition}=r;
        if(data.version===2&&(!Object.hasOwn(definition,'loopEnabled')||!Object.hasOwn(definition,'loopCount')))throw Error('Missing mission loop settings');
        this.routes.set(id,{id,deviceId,revision,updatedAt,...normalizeRoute(definition)});
      }
    }catch(error){if(error.code!=='ENOENT')this.error='航线文件读取失败，已禁止保存与执行，请检查 BOAT_MISSION_FILE 和文件内容';}
  }
  list(deviceId){return [...this.routes.values()].filter(r=>r.deviceId===deviceId).map(r=>structuredClone(r));}
  get(deviceId,id){const r=this.routes.get(id);if(!r||r.deviceId!==deviceId)throw fault(404,'未找到当前无人船的航线');return structuredClone(r);}
  commit(next,authorize=()=>{}){
    if(this.error||!this.file)throw fault(503,this.error||'航线存储路径不可用');
    const dir=path.dirname(this.file),tmp=path.join(dir,'.missions-'+crypto.randomBytes(12).toString('hex')+'.tmp');let fd;
    try{
      fs.mkdirSync(dir,{recursive:true,mode:0o700});fd=fs.openSync(tmp,'wx',0o640);fs.fchmodSync(fd,0o640);
      fs.writeFileSync(fd,JSON.stringify({version:2,routes:[...next.values()]})+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      authorize();fs.renameSync(tmp,this.file);this.routes=next;
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(_){/* rename 后无需删除。 */}}
  }
  save(deviceId,input,id,revision,authorize){
    if(!DEVICE.test(deviceId||''))throw fault(400,'无人船标识不正确');
    const value=normalizeRoute(input),next=new Map(this.routes);let old;
    if(id!==undefined){old=this.get(deviceId,id);if(revision!==old.revision)throw fault(409,'航线已被其他管理员修改，请重新载入');}
    else{if(revision!==undefined)throw fault(400,'新航线不能指定版本');if(next.size>=128)throw fault(409,'最多保存 128 条航线，请先删除不用的航线');id=crypto.randomBytes(8).toString('hex');}
    const route={id,deviceId,revision:(old?.revision||0)+1,updatedAt:this.now(),...value};next.set(id,route);this.commit(next,authorize);return structuredClone(route);
  }
  delete(deviceId,id,revision,authorize){const route=this.get(deviceId,id);if(route.revision!==revision)throw fault(409,'航线版本已变化，请重新载入');const next=new Map(this.routes);next.delete(id);this.commit(next,authorize);}
}
module.exports={MissionStore,normalizeRoute,fault,ID};
