/* 仅本地驾驶界面测试：真实登录/遥测，模拟单片机的独占接管确认与故障。 */
'use strict';
const {createFixtureServer,fixtureScript}=require('./mqtt-browser-fixture.cjs');
const fs=require('node:fs');
function createDriverFixture(options={}) {
  const server=createFixtureServer(options),fixture={calls:[],active:false,hold:false,owner:'',leaseId:'aabbccddeeff0011',leaseCounter:0,ackDelay:150,failInputs:false,testSupported:true,testMode:false,lastBrowserSequence:0,inputResponseDelay:0,inputProcessingDelay:0};
  const originalList=server.boatCloud.list,originalState=server.boatCloud.state,updatedAt=Date.now();
  const descriptor=()=>({version:1,enabled:true,url:'http://127.0.0.1:'+server.address()?.port+'/__test/driver-video.mp4',format:'native',updatedAt});
  if(options.mediaPath){
    server.boatCloud.list=()=>{const value=originalList();return {...value,devices:value.devices.map(device=>({...device,video:descriptor()}))};};
    server.boatCloud.state=()=>{const value=originalState();return {...value,device:{...value.device,video:descriptor()}};};
  }
  const original=server.listeners('request')[0];server.removeListener('request',original);
  function snapshot(clientId){const owned=fixture.active&&fixture.owner===clientId;return {supported:true,ready:!fixture.active,active:fixture.active,owned,testSupported:fixture.testSupported,testMode:fixture.active&&fixture.testMode,state:fixture.active?1:fixture.hold?2:0,status:fixture.active?'active':fixture.hold?'hold':'idle',reason:fixture.hold?2:0,mode:server.mqttFixture.overrides.mode??1,sequence:fixture.lastBrowserSequence,clientSequence:fixture.lastBrowserSequence,...(owned?{leaseId:fixture.leaseId}:{}),message:fixture.active?'单片机已确认接管':'船端已就绪，可接管'};}
  server.on('request',(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__test/driver-video.mp4'&&options.mediaPath){
      const size=fs.statSync(options.mediaPath).size,match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
      const start=match?Number(match[1]):0,end=match?.[2]?Math.min(Number(match[2]),size-1):size-1;
      if(start>=size){res.writeHead(416,{'Content-Range':'bytes */'+size});return res.end();}
      res.writeHead(match?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(match?{'Content-Range':'bytes '+start+'-'+end+'/'+size}:{})});
      const stream=fs.createReadStream(options.mediaPath,{start,end});res.on('close',()=>stream.destroy());return stream.pipe(res);
    }
    if(url.pathname!=='/api/cloud/control')return original(req,res);
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const session=server.boatAccounts.sessionFor(req);
    if(!session)return json(401,{error:'请先登录'});
    if(session.value.role!=='admin')return json(403,{error:'仅管理员可操控'});
    if(req.method==='GET')return json(200,snapshot(url.searchParams.get('clientId')));
    if(!server.boatAccounts.sameOrigin(req))return json(403,{error:'Same-origin required'});
    let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{
      let input;try{input=JSON.parse(text);}catch(_){return json(400,{error:'bad request'});}
      fixture.calls.push(input);
      if(input.action==='acquire'){
        if(fixture.active)return json(409,{error:'已有驾驶员'});
        if(input.testMode&&(!fixture.testSupported||input.mode!==0))return json(409,{error:'测试场景不可用'});
        const timer=setTimeout(()=>{if(res.destroyed)return;fixture.leaseId=(++fixture.leaseCounter).toString(16).padStart(16,'0');fixture.lastBrowserSequence=0;fixture.active=true;fixture.hold=false;fixture.testMode=!!input.testMode;fixture.owner=input.clientId;server.mqttFixture.overrides.mode=input.mode;json(200,snapshot(input.clientId));},fixture.ackDelay);
        res.once('close',()=>clearTimeout(timer));return;
      }
      if(input.clientId!==fixture.owner||input.leaseId!==fixture.leaseId)return json(409,{error:'不是当前驾驶员'});
      if(input.action==='input'){
        const apply=()=>{
          if(!fixture.active||input.leaseId!==fixture.leaseId)return json(409,{error:'租约已失效'});
          if(input.sequence<=fixture.lastBrowserSequence)return json(409,{error:'驾驶输入序号已过期，拒绝重放旧指令',code:'STALE_CONTROL_SEQUENCE'});
          if(!!input.testMode!==fixture.testMode)return json(409,{error:'场景不匹配'});
          if(fixture.failInputs){fixture.active=false;fixture.hold=true;return json(503,{error:'模拟链路中断'});}
          fixture.lastBrowserSequence=input.sequence;
          server.mqttFixture.overrides.mode=input.mode;
          const value={accepted:true,...snapshot(input.clientId)};
          if(fixture.inputResponseDelay)return setTimeout(()=>json(202,value),fixture.inputResponseDelay).unref();
          return json(202,value);
        };
        const delay=typeof fixture.inputProcessingDelay==='function'?fixture.inputProcessingDelay(input):fixture.inputProcessingDelay;
        if(delay)return setTimeout(apply,delay).unref();
        return apply();
      }
      fixture.active=false;fixture.hold=true;return json(200,snapshot(input.clientId));
    });
  });
  server.driverFixture=fixture;return server;
}
module.exports={createDriverFixture,fixtureScript};
