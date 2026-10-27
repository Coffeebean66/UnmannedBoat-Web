/* 完整 WHEP offer/answer 与 ICE 桩验证；不访问公网或生产媒体服务。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const config={enabled:true,format:'webrtc',playbackBase:'/api/video/media/boats/',ingest:{protocol:'srt',host:'video.test',port:8890}};
const response=(status,data,headers={})=>({status,ok:status>=200&&status<300,json:async()=>data,text:async()=>String(data),headers:{get:name=>Object.entries(headers).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1]||null}});
const answer=(id='boat-a',session='session-one')=>response(201,'v=0\r\na=answer\r\n',{'Content-Type':'application/sdp','Location':'/api/video/media/boats/'+id+'/whep/'+session});

function setup({autoIce=true,handler}={}){
  const nodes={},peers=[],calls=[],timers=new Map();let serial=0;
  class Node extends EventTarget{
    constructor(){super();this.textContent='';this.dataset={};this.hidden=false;this.disabled=false;}
    click(){this.dispatchEvent(new Event('click'));}
  }
  const video=new Node();Object.assign(video,{src:'',srcObject:null,error:null,loads:0,plays:0,pauses:0,
    load(){this.loads++;},play(){this.plays++;return Promise.resolve();},pause(){this.pauses++;},canPlayType(){return '';},removeAttribute(name){if(name==='src')this.src='';},closest(){return null;}});
  nodes.boatVideo=video;
  class RTC extends EventTarget{
    constructor(options){super();this.options=options;this.closed=false;this.transceivers=[];this.iceGatheringState='new';this.connectionState='new';this.remoteDescriptions=[];peers.push(this);}
    addTransceiver(kind,options){this.transceivers.push({kind,...options});}
    async createOffer(){return {type:'offer',sdp:'v=0\r\na=initial-offer\r\n'};}
    async setLocalDescription(value){this.localDescription=value;this.iceGatheringState='gathering';if(autoIce)this.finishIce();}
    finishIce(){this.localDescription={type:'offer',sdp:'v=0\r\na=complete-ice-offer\r\na=candidate:full\r\n'};this.iceGatheringState='complete';this.dispatchEvent(new Event('icegatheringstatechange'));}
    async setRemoteDescription(value){this.remoteDescriptions.push(value);}
    connect(state='connected'){this.connectionState=state;this.onconnectionstatechange?.();}
    close(){this.closed=true;this.connectionState='closed';}
  }
  class Stream{constructor(){this.tracks=[];}addTrack(track){this.tracks.push(track);}getTracks(){return this.tracks;}}
  const fetch=async(url,options={})=>{
    const call={url:String(url),...options};calls.push(call);
    if(handler){const custom=handler(call);if(custom!==undefined)return custom;}
    if(call.url==='/api/video/media/config')return response(200,config);
    if(call.method==='POST')return answer(call.url.split('/')[5]);
    return response(204,'');
  };
  const document={getElementById:id=>nodes[id]||(nodes[id]=new Node())};
  const window={document,location:new URL('https://boat.test'),fetch,RTCPeerConnection:RTC,MediaStream:Stream,AbortController,
    setTimeout(callback,delay){const id=++serial;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/video-view.js'),'utf8'),{window,URL,Date});
  const view=new window.BoatVideoView(),state=(extra={})=>({deviceId:'boat-a',descriptor:null,authenticated:true,streaming:true,...extra});
  return {view,nodes,video,peers,calls,timers,state,show(extra){view.update(state(extra));view.setVisible(true);},
    posts:()=>calls.filter(call=>call.method==='POST'),deletes:()=>calls.filter(call=>call.method==='DELETE'),
    fire(delay){for(const [id,timer]of [...timers])if(timer.delay===delay){timers.delete(id);timer.callback();}}};
}

test('低延迟服务无需MQTT地址，等待完整ICE后发送同源SDP并接收answer，不重复协商',async t=>{
  const h=setup({autoIce:false});t.after(()=>h.view.destroy());h.show();await flush();
  assert.equal(h.peers.length,1);assert.equal(h.posts().length,0);
  const pc=h.peers[0];assert.deepEqual(pc.transceivers.map(value=>[value.kind,value.direction]),[['video','recvonly'],['audio','recvonly']]);
  pc.finishIce();await flush();assert.equal(h.posts().length,1);
  const post=h.posts()[0];assert.equal(post.url,'/api/video/media/boats/boat-a/whep');assert.equal(post.credentials,'same-origin');assert.equal(post.redirect,'error');
  assert.equal(post.headers['Content-Type'],'application/sdp');assert.match(post.body,/complete-ice-offer/);assert.match(post.body,/candidate:full/);
  assert.equal(pc.remoteDescriptions[0].type,'answer');assert.equal(pc.remoteDescriptions[0].sdp,'v=0\r\na=answer\r\n');
  assert.equal(h.view.state().format,'webrtc');assert.match(h.nodes.videoFormat.textContent,/低延迟/);assert.equal(h.video.src,'');
  for(let i=0;i<5;i++)h.view.update(h.state({descriptor:{url:'https://boat.test/ignored.mp4',format:'native',receivedAt:i}}));
  await flush();assert.equal(h.peers.length,1);assert.equal(h.posts().length,1);assert.equal(h.calls.filter(call=>call.url==='/api/video/media/config').length,1);
});

test('服务停用或旧服务没有配置入口时保持HTTP播放，服务启用后不加载原HTTP地址',async t=>{
  for(const mode of ['disabled','legacy','enabled']){
    const h=setup({handler:call=>call.url==='/api/video/media/config'?mode==='legacy'?response(404,''):response(200,mode==='disabled'?{enabled:false}:config):undefined});
    t.after(()=>h.view.destroy());h.show({descriptor:{url:'https://boat.test/live.mp4',format:'native'}});await flush();
    assert.equal(h.peers.length,mode==='enabled'?1:0);assert.equal(h.video.src,mode==='enabled'?'':'https://boat.test/live.mp4');
  }
});

test('未显示页面不读取配置，隐藏时取消配置等待，迟到响应不能启动媒体',async t=>{
  const gate=deferred(),h=setup({handler:call=>call.url==='/api/video/media/config'?gate.promise:undefined});t.after(()=>h.view.destroy());
  h.view.update(h.state());await flush();assert.equal(h.calls.length,0);
  h.view.setVisible(true);await flush();const request=h.calls[0];assert.equal(request.url,'/api/video/media/config');
  h.view.setVisible(false);assert.equal(request.signal.aborted,true);gate.resolve(response(200,config));await flush();
  assert.equal(h.peers.length,0);assert.equal(h.view.state().active,false);
  h.view.setVisible(true);await flush();assert.equal(h.peers.length,1);
});

test('停止、隐藏、退出、切船和销毁会关闭轨道与peer并DELETE属于旧船的会话',async t=>{
  for(const action of ['stop','hide','logout','switch','destroy']){
    const h=setup();t.after(()=>h.view.destroy());h.show();await flush();const pc=h.peers[0];
    const track={stopped:0,stop(){this.stopped++;}},stream={getTracks:()=>[track]};pc.ontrack({track,streams:[stream]});assert.equal(h.video.srcObject,stream);
    if(action==='stop')h.nodes.videoStop.click();else if(action==='hide')h.view.setVisible(false);else if(action==='logout')h.view.update(h.state({authenticated:false}));
    else if(action==='switch')h.view.update(h.state({deviceId:'boat-b'}));else h.view.destroy();
    await flush();assert.equal(pc.closed,true,action);assert.equal(track.stopped,1,action);assert.notEqual(h.video.srcObject,stream,action);
    assert.equal(h.deletes().filter(call=>call.url==='/api/video/media/boats/boat-a/whep/session-one').length,1,action);
    if(action!=='switch')assert.equal(h.view.state().active,false,action);else assert.equal(h.peers.length,2);
  }
});

test('换船或隐藏期间迟到的POST响应只回收旧session，不干扰新船连接',async t=>{
  for(const action of ['switch','hide']){
    const gate=deferred(),h=setup({handler:call=>call.method==='POST'&&call.url.includes('/boat-a/')?gate.promise:undefined});t.after(()=>h.view.destroy());
    h.show();await flush();const previous=h.peers[0],request=h.posts()[0];
    if(action==='switch')h.view.update(h.state({deviceId:'boat-b'}));else h.view.setVisible(false);await flush();
    const status=h.view.state().status;assert.equal(request.signal.aborted,true);
    gate.resolve(answer('boat-a','late-session'));await flush();
    assert.equal(previous.remoteDescriptions.length,0);assert.equal(h.view.state().status,status);
    assert.equal(h.deletes().filter(call=>call.url.endsWith('/boat-a/whep/late-session')).length,1);
    if(action==='switch')assert.equal(h.peers.at(-1).closed,false);
  }
});

test('拒绝外站或错误船只的Location，不向任意地址发凭据或DELETE',async t=>{
  for(const location of ['https://attacker.test/resource','/api/video/media/boats/boat-b/whep/stolen','/api/video/media/boats/boat-a/whep/x?token=secret','/api/video/media/boats/boat-a/whep/../other']){
    const h=setup({handler:call=>call.method==='POST'?response(201,'v=0\r\n',{'Content-Type':'application/sdp',Location:location}):undefined});t.after(()=>h.view.destroy());h.show();await flush();
    assert.equal(h.view.state().active,false);assert.match(h.view.state().status,/无法建立/);assert.equal(h.deletes().length,0);assert.equal(h.peers[0].closed,true);
  }
});

test('已启用服务信令失败不会降级HTTP或随遥测无限重试，显式重连才能重试',async t=>{
  let ready=false;const h=setup({handler:call=>call.method==='POST'&&!ready?response(404,'missing'):undefined});t.after(()=>h.view.destroy());
  const value={descriptor:{url:'https://boat.test/old.mp4',format:'native'}};h.show(value);await flush();assert.equal(h.video.src,'');assert.equal(h.view.state().active,false);assert.match(h.view.state().status,/尚未发布/);
  for(let i=0;i<10;i++)h.view.update(h.state(value));await flush();assert.equal(h.posts().length,1);
  ready=true;h.nodes.videoRetry.click();await flush();assert.equal(h.posts().length,2);assert.equal(h.view.state().active,true);
});

test('配置读取失败与超时可显式重试，忽略已取消的旧配置',async t=>{
  const gate=deferred();let hang=true;
  const h=setup({handler:call=>call.url==='/api/video/media/config'&&hang?gate.promise:undefined});t.after(()=>h.view.destroy());h.show();await flush();
  h.fire(10000);assert.equal(h.view.state().active,false);assert.match(h.view.state().status,/配置读取超时/);assert.equal(h.nodes.videoRetry.disabled,false);
  hang=false;h.nodes.videoRetry.click();await flush();assert.equal(h.peers.length,1);gate.resolve(response(200,{enabled:false}));await flush();
  assert.equal(h.view.state().format,'webrtc');assert.equal(h.peers.length,1);
});

test('ICE收集与响应体等待有连接期限，超时释放peer和已创建的session',async t=>{
  const gather=setup({autoIce:false});t.after(()=>gather.view.destroy());gather.show();await flush();gather.fire(20000);await flush();
  assert.equal(gather.peers[0].closed,true);assert.equal(gather.posts().length,0);assert.match(gather.view.state().status,/连接超时/);
  const gate=deferred(),body=setup({handler:call=>call.method==='POST'?{...answer(),text:()=>gate.promise}:undefined});t.after(()=>body.view.destroy());
  body.show();await flush();body.fire(20000);await flush();assert.equal(body.peers[0].closed,true);assert.equal(body.deletes().length,1);
  gate.resolve('v=0\r\na=late-answer\r\n');await flush();assert.equal(body.peers[0].remoteDescriptions.length,0);assert.equal(body.deletes().length,1);
});

test('短暂断流可恢复，持续断流关闭会话；旧轨道和旧状态事件不能覆盖新船',async t=>{
  const h=setup();t.after(()=>h.view.destroy());h.show();await flush();const pc=h.peers[0],oldTrack=pc.ontrack,oldState=pc.onconnectionstatechange;
  pc.connect();assert.equal([...h.timers.values()].some(timer=>timer.delay===20000),false);
  pc.connect('disconnected');assert.equal([...h.timers.values()].some(timer=>timer.delay===4000),true);
  pc.connect();assert.equal([...h.timers.values()].some(timer=>timer.delay===4000),false);
  h.view.update(h.state({deviceId:'boat-b'}));await flush();const status=h.view.state().status,track={stopped:0,stop(){this.stopped++;}};
  oldTrack({track,streams:[]});pc.connectionState='failed';oldState();assert.equal(track.stopped,1);assert.equal(h.view.state().status,status);assert.equal(h.peers.at(-1).closed,false);
  h.peers.at(-1).connect('disconnected');h.fire(4000);await flush();assert.equal(h.view.state().active,false);assert.match(h.view.state().status,/连接中断/);
});

test('销毁或停止发生在配置fetch派发前时不再发送旧请求',async()=>{
  for(const action of ['destroy','stop']){
    const h=setup();h.show();if(action==='destroy')h.view.destroy();else h.nodes.videoStop.click();await flush();
    assert.equal(h.calls.length,0);assert.equal(h.peers.length,0);h.view.destroy();
  }
});
