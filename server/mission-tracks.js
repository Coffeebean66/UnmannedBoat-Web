/* 任务专用实测轨迹：仅采样启用记录的航段，独立于持续保存的全量遥测历史。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fault,ID}=require('./mission-store');
const DEVICE=/^[A-Za-z0-9_-]{1,64}$/,STATUSES=['preparing','running','paused','completed','stopped','failed','interrupted'];
const MAX_TRACKS=128,MAX_POINTS=10000,MAX_TOTAL=20000,MAX_BYTES=8*1024*1024;
const clone=value=>structuredClone(value);
class MissionTracks{
  constructor({file='',now=Date.now,writeIntervalMs=5000}={}){
    this.file=file;this.now=now;this.writeIntervalMs=writeIntervalMs;this.records=new Map();this.open=new Map();
    this.dirty=false;this.closed=false;this.writing=null;this.timer=null;this.error='';this.blocked=false;this.lastSavedAt=null;
    if(!file)return;
    try{
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('Invalid track file');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1||!Array.isArray(data.tracks)||data.tracks.length>MAX_TRACKS)throw Error('Invalid tracks');
      let total=0;
      for(const record of data.tracks){
        if(!ID.test(record?.id||'')||!DEVICE.test(record.deviceId||'')||this.records.has(record.id)||typeof record.name!=='string'||record.name.length>80||!ID.test(record.routeId||'')||!STATUSES.includes(record.status)||!Number.isSafeInteger(record.revision)||record.revision<1||!Number.isFinite(record.startedAt)||record.finishedAt!==null&&!Number.isFinite(record.finishedAt)||!Array.isArray(record.chunks)||record.chunks.length>MAX_POINTS)throw Error('Invalid track');
        let count=0;
        for(const chunk of record.chunks){
          if(!Array.isArray(chunk.points)||!chunk.points.length||!Number.isInteger(chunk.segmentIndex)||chunk.segmentIndex<0||!ID.test(chunk.routeId||''))throw Error('Invalid track segment');
          let previous=-Infinity;
          for(const p of chunk.points){
            if(!Number.isFinite(p.latitude)||Math.abs(p.latitude)>85||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180||!Number.isFinite(p.receivedAt)||p.receivedAt<previous||!Number.isFinite(p.speedMps)||p.speedMps<0)throw Error('Invalid track point');
            previous=p.receivedAt;count++;
          }
        }
        total+=count;if(count>MAX_POINTS||total>MAX_TOTAL)throw Error('Too many track points');
        record.pointCount=count;record.recording=false;
        // 重启后只恢复已保存的轨迹，不恢复航行或采样任务。
        if(['preparing','running','paused'].includes(record.status)){record.status='interrupted';record.finishedAt=now();record.revision++;this.dirty=true;}
        this.records.set(record.id,record);
      }
      this.lastSavedAt=Number.isFinite(data.savedAt)?data.savedAt:null;this.schedule();
    }catch(error){if(error.code!=='ENOENT'){this.records.clear();this.error='任务轨迹文件读取失败，请检查 mission-tracks.json 和存储权限';this.blocked=true;}}
  }
  summary(record){const {chunks,...summary}=record;return clone(summary);}
  list(deviceId){return [...this.records.values()].filter(r=>r.deviceId===deviceId).sort((a,b)=>b.startedAt-a.startedAt).map(r=>this.summary(r));}
  get(deviceId,id){const record=this.records.get(id);if(!record||record.deviceId!==deviceId)throw fault(404,'未找到当前无人船的任务轨迹');return clone(record);}
  status(){return {persistent:!!this.file,storageError:this.error||null,lastSavedAt:this.lastSavedAt,sampleMs:1000,maxPoints:MAX_POINTS,maxTotalPoints:MAX_TOTAL,maxTracks:MAX_TRACKS};}
  start(job){
    if(this.closed||this.blocked||this.error)throw fault(503,this.error||'任务轨迹存储不可用');
    if(job.trackId){
      const record=this.records.get(job.trackId);
      if(!record||record.deviceId!==job.id)throw fault(409,'暂停任务的轨迹已不存在，请重新开始任务');
      this.open.delete(record.id);record.status='preparing';record.finishedAt=null;record.recording=false;this.touch(record);return;
    }
    // 最近记录有界保留，运行或暂停中的记录不会被淘汰。
    if(this.records.size>=MAX_TRACKS){
      const oldest=[...this.records.values()].find(r=>!['preparing','running','paused'].includes(r.status));
      if(!oldest)throw fault(409,'任务轨迹已满，请先结束已有任务');
      this.records.delete(oldest.id);
    }
    const id=crypto.randomBytes(8).toString('hex');
    const record={id,deviceId:job.id,routeId:job.route.id,name:job.queue?.definition.name||job.route.name,startedAt:this.now(),finishedAt:null,status:'preparing',recording:false,revision:1,pointCount:0,truncated:false,chunks:[]};
    job.trackId=id;this.records.set(id,record);this.touch(record);
  }
  touch(record){record.revision++;this.dirty=true;this.schedule();}
  state(job,status){
    const record=this.records.get(job.trackId);if(!record)return;
    this.open.delete(record.id);record.recording=false;record.status=status;
    record.finishedAt=['preparing','running','paused'].includes(status)?null:this.now();this.touch(record);
  }
  break(job){
    const record=this.records.get(job.trackId);if(!record)return;
    this.open.delete(record.id);if(record.recording){record.recording=false;this.touch(record);}
  }
  sample(job,p,{boundary=false}={}){
    const record=this.records.get(job.trackId);if(!record||record.status!=='running')return;
    const enabled=job.status==='running'&&job.action==='start'&&job.phase==='route'&&job.index>0&&job.route.segments?.[job.index-1]?.record!==false;
    if(!enabled){this.break(job);return;}
    const now=this.now(),key=[job.queue?.completedLoops||0,job.queue?.index||0,job.completedLoops,job.index].join(':');
    let open=this.open.get(record.id);
    if(open&&now-open.lastAt>=1000&&!boundary&&p.sourceTick===open.lastTick){this.break(job);return;}
    if(open&&open.key===key&&(p.sourceTick===open.lastTick||!boundary&&now-open.lastAt<1000))return;
    // 即使跳过段很短、起终点重合，也按航段/轮次另起折线，绝不跨虚线续接。
    if(!open||open.key!==key||now<open.lastAt||now-open.lastAt>1500){
      const chunk={routeId:job.route.id,segmentIndex:job.index-1,queueIndex:job.queue?.index||0,loop:job.completedLoops+1,queueLoop:(job.queue?.completedLoops||0)+1,points:[]};
      record.chunks.push(chunk);open={key,chunk,lastAt:-Infinity,lastTick:null};this.open.set(record.id,open);
    }
    open.chunk.points.push({latitude:p.latitude,longitude:p.longitude,receivedAt:now,speedMps:p.speedMps});
    open.lastAt=now;open.lastTick=p.sourceTick;record.pointCount++;record.recording=true;
    while(record.pointCount>MAX_POINTS)this.trim(record);
    let total=[...this.records.values()].reduce((sum,r)=>sum+r.pointCount,0);
    for(const candidate of this.records.values()){
      while(total>MAX_TOTAL&&candidate.pointCount){this.trim(candidate);total--;if(candidate!==record)this.touch(candidate);}
      if(total<=MAX_TOTAL)break;
    }
    this.touch(record);
  }
  trim(record){
    record.chunks[0].points.shift();record.pointCount--;record.truncated=true;
    if(!record.chunks[0].points.length){const removed=record.chunks.shift();if(this.open.get(record.id)?.chunk===removed)this.open.delete(record.id);}
  }
  schedule(){if(!this.file||!this.dirty||this.closed||this.blocked||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.flush();},this.writeIntervalMs);this.timer.unref?.();}
  flush(){
    if(this.writing)return this.writing;if(!this.file||!this.dirty||this.blocked)return Promise.resolve();
    this.dirty=false;const savedAt=this.now(),raw=JSON.stringify({version:1,savedAt,tracks:[...this.records.values()]})+'\n',temporary=this.file+'.tmp-'+crypto.randomUUID();
    this.writing=(async()=>{
      try{
        if(Buffer.byteLength(raw)>MAX_BYTES)throw Error('Oversize track file');
        await fs.promises.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
        await fs.promises.writeFile(temporary,raw,{flag:'wx',mode:0o600});await fs.promises.rename(temporary,this.file);this.lastSavedAt=savedAt;this.error='';
      }catch(_){this.dirty=true;this.error='任务轨迹尚未保存到磁盘，请检查服务器存储空间和写入权限';await fs.promises.unlink(temporary).catch(()=>{});}
    })().finally(()=>{this.writing=null;this.schedule();});return this.writing;
  }
  async close(){this.closed=true;clearTimeout(this.timer);this.timer=null;if(this.writing)await this.writing;if(this.dirty)await this.flush();}
}
module.exports={MissionTracks};
