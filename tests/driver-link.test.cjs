/* 用可控时钟/传输验证真正的浏览器驾驶实现，不依赖网络和定时器运气。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(){
  let now=0;const window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/driver-control.js'),'utf8'),{window,AbortController,performance:{now:()=>now}});
  const driver=Object.create(window.BoatDriverControl.prototype),requests=[],stops=[];
  const leaseId='0011223344556677';
  Object.assign(driver,{active:true,generation:1,sequence:0,clientId:'1122334455667788',leaseId,context:{deviceId:'boat-01'},inputRequests:new Map(),lastInputSentAt:-Infinity,lastInputSignature:'',lastInputResponseAt:0,lastAcceptedSequence:0,remote:{sequence:0},testMode:true,destroyed:false,lastPulse:0,nodes:{driverMode:{value:'0'}},input:{mode:0,throttle:200,turn:0,targetHeading:0,testMode:true}});
  driver.inputs=()=>({...driver.input});driver.permitted=()=>true;driver.visible=()=>false;driver.renderKeys=driver.render=()=>{};
  driver.stop=message=>{stops.push(message);driver.active=false;};
  driver.api=(payload,{controller})=>new Promise((resolve,reject)=>{
    requests.push({payload,resolve,reject});
    controller.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});
  });
  const reply=request=>request.resolve({active:true,owned:true,state:1,status:'active',leaseId,testMode:true,sequence:request.payload.sequence,clientSequence:request.payload.sequence});
  return {driver,requests,stops,reply,setTime:value=>{now=value;}};
}
test('slow HTTP replies do not serialize heartbeats and releasing keys supersedes the oldest request without queuing throttle',async()=>{
  const f=fixture(),tasks=[];
  for(const time of [0,100,200,300]){f.setTime(time);tasks.push(f.driver.sendInput());}
  assert.equal(f.requests.length,4);assert.equal(f.driver.inputRequests.size,4);
  f.setTime(400);await f.driver.sendInput();assert.equal(f.requests.length,4,'Bounded heartbeat concurrency');
  f.driver.input.throttle=0;tasks.push(f.driver.sendInput());
  assert.equal(f.requests.length,5);assert.equal(f.requests[4].payload.throttle,0);assert.equal(f.driver.inputRequests.size,4);
  await Promise.resolve();assert.equal(f.stops.length,0,'Superseding a slow request is not a connection failure');
  f.setTime(450);for(const request of f.requests.slice(1))f.reply(request);
  await Promise.all(tasks);assert.equal(f.driver.inputRequests.size,0);assert.equal(f.driver.lastAcceptedSequence,5);assert.equal(f.stops.length,0);
});
test('out-of-order replies and explicit stale-sequence rejection cannot overwrite a newer acknowledgement or stop the lease',async()=>{
  const f=fixture();const old=f.driver.sendInput();f.setTime(100);const next=f.driver.sendInput();
  f.setTime(200);f.reply(f.requests[1]);await next;
  f.requests[0].resolve({active:false,owned:false,state:2,status:'hold'});await old;
  assert.equal(f.driver.remote.sequence,2);assert.equal(f.stops.length,0);
  f.setTime(300);const stale=f.driver.sendInput();
  f.requests[2].reject(Object.assign(Error('old sequence'),{status:409,code:'STALE_CONTROL_SEQUENCE'}));await stale;
  assert.equal(f.driver.lastInputResponseAt,200,'A rejected request does not renew the response deadline');
  assert.equal(f.stops.length,0);
});
test('one lost response permits fresh heartbeats but a continuous outage still stops at the response deadline',async()=>{
  const f=fixture();const lost=f.driver.sendInput();f.setTime(100);f.requests[0].reject(TypeError('network'));await lost;
  assert.equal(f.stops.length,0);const fresh=f.driver.sendInput();f.setTime(200);f.reply(f.requests[1]);await fresh;
  f.setTime(799);f.driver.pulse();assert.equal(f.stops.length,0);
  f.setTime(800);f.driver.pulse();assert.equal(f.stops.length,1);assert.match(f.stops[0],/持续无响应/);
  assert.equal(f.driver.active,false);
});
test('explicit permission or lease rejection still stops immediately',async()=>{
  for(const status of [401,403,409,503]){
    const f=fixture(),task=f.driver.sendInput();f.requests[0].reject(Object.assign(Error('rejected'),{status}));await task;
    assert.equal(f.stops.length,1);assert.equal(f.driver.active,false);
  }
});
test('a retired lease response cannot delete a request with the same browser sequence in a new generation',async()=>{
  const f=fixture(),old=f.driver.sendInput();
  f.driver.generation++;f.driver.sequence=0;f.driver.inputRequests.clear();f.driver.lastInputSignature='';
  f.setTime(100);const next=f.driver.sendInput(),current=f.driver.inputRequests.get(1);
  f.reply(f.requests[0]);await old;
  assert.equal(f.driver.inputRequests.get(1),current);assert.equal(f.driver.lastAcceptedSequence,0);
  f.reply(f.requests[1]);await next;assert.equal(f.driver.inputRequests.size,0);assert.equal(f.stops.length,0);
});
