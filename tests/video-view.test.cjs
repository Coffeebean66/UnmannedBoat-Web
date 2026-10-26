/* 用媒体桩验证连接生命周期，避免遥测刷新重复拉流或旧船回调干扰当前画面。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup({origin='https://boat.test',nativeHls=false}={}){
  const nodes={},hls=[],flv=[];
  class Node extends EventTarget{
    constructor(){super();this.textContent='';this.dataset={};this.hidden=false;this.disabled=false;}
    click(){this.dispatchEvent(new Event('click'));}
  }
  const video=new Node();Object.assign(video,{src:'',error:null,loads:0,pauses:0,plays:0,
    load(){this.loads++;},pause(){this.pauses++;},play(){this.plays++;return this.playResult||Promise.resolve();},
    canPlayType(){return nativeHls?'probably':'';},removeAttribute(name){if(name==='src')this.src='';},closest(){return null;}});
  nodes.boatVideo=video;
  class Player{
    constructor(){this.handlers=new Map();this.destroyed=0;}
    on(name,handler){this.handlers.set(name,handler);}
    emit(name,...args){this.handlers.get(name)?.(...args);}
    destroy(){this.destroyed++;}
  }
  class Hls extends Player{
    static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};
    static isSupported(){return true;}
    constructor(){super();hls.push(this);}
    attachMedia(value){this.video=value;}
    loadSource(url){this.url=url;}
  }
  const mpegts={Events:{ERROR:'error'},isSupported:()=>true,createPlayer(config){
    const player=new Player();Object.assign(player,{config,loads:0,attachMediaElement(value){this.video=value;},load(){this.loads++;}});flv.push(player);return player;
  }};
  const document={getElementById:id=>nodes[id]||(nodes[id]=new Node())},location=new URL(origin);
  const context={window:{document,location,Hls,mpegts},URL,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/video-view.js'),'utf8'),context);
  const view=new context.window.BoatVideoView();
  const source=(format='native',url)=>({deviceId:'boat-a',descriptor:{version:1,url:url||origin+'/live/boat-a.'+(format==='hls'?'m3u8':format==='flv'?'flv':'mp4'),format,receivedAt:100000},authenticated:true,streaming:true});
  return {view,video,nodes,hls,flv,source,show(value){view.update(value||source());view.setVisible(true);},
    current(format){return format==='hls'?hls.at(-1):format==='flv'?flv.at(-1):null;}};
}

test('HTTPS页面拒绝HTTP视频，精确同源或授权来源才能建立媒体连接',t=>{
  for(const [url,allowedOrigins,active,reason]of [
    ['http://video.test/live.mp4',['http://video.test'],false,/HTTPS/],
    ['https://boat.test/live.mp4',[],true],
    ['https://video.test/live.mp4',[],false,/尚未授权/],
    ['https://video.test/live.mp4',['https://video.test'],true],
    ['https://video.test:8443/live.mp4',['https://video.test'],false,/尚未授权/],
    ['https://video.test.evil/live.mp4',['https://video.test'],false,/尚未授权/]
  ]){
    const h=setup();t.after(()=>h.view.destroy());h.show({...h.source('native',url),allowedOrigins});
    assert.equal(h.view.state().active,active,url);assert.equal(h.video.loads,active?1:0,url);
    if(reason)assert.match(h.view.state().status,reason,url);
  }
});

test('重复发布同一签名地址只更新说明，不重建native、HLS或FLV连接',t=>{
  for(const format of ['native','hls','flv']){
    const h=setup();t.after(()=>h.view.destroy());const value=h.source(format);value.descriptor.url+='?token=signed%2Bvalue&part=1';h.show(value);
    const player=h.current(format),loads=h.video.loads,plays=h.video.plays;
    for(let i=0;i<10;i++)h.view.update({...value,descriptor:{...value.descriptor,title:'摄像头 '+i,receivedAt:100000+i}});
    assert.equal(h.view.state().active,true,format);assert.equal(h.video.loads,loads,format);assert.equal(h.video.plays,plays,format);
    assert.equal(h.current(format),player,format);if(player)assert.equal(player.destroyed,0,format);
    const loaded=format==='native'?h.video.src:format==='hls'?player.url:player.config.url;
    assert.equal(loaded,value.descriptor.url,'签名查询必须完整保留');
    assert.equal(h.hls.length,format==='hls'?1:0);assert.equal(h.flv.length,format==='flv'?1:0);
  }
});

test('隐藏、退出与销毁释放媒体资源，隐藏后重复更新不会在后台拉流',t=>{
  for(const format of ['native','hls','flv']){
    const h=setup();t.after(()=>h.view.destroy());const value=h.source(format);h.show(value);const first=h.current(format);
    h.view.setVisible(false);assert.equal(h.view.state().active,false);assert.equal(h.video.pauses,1);if(first)assert.equal(first.destroyed,1);
    const loads=h.video.loads;h.view.setVisible(false);h.view.update(value);assert.equal(h.video.loads,loads);assert.equal(h.video.src,'');
    h.view.setVisible(true);assert.equal(h.view.state().active,true);const second=h.current(format);if(first)assert.notEqual(second,first);
    h.view.update({...value,authenticated:false});assert.equal(h.view.state().active,false);assert.equal(h.video.pauses,2);if(second)assert.equal(second.destroyed,1);
    const total=h.hls.length+h.flv.length;h.view.destroy();h.nodes.videoPlay.click();h.view.update(value);h.view.setVisible(true);
    assert.equal(h.view.state().active,false);assert.equal(h.hls.length+h.flv.length,total);
  }
});

test('HLS失败保留地址签名，遥测更新不自动重试，播放和重新连接可显式恢复',t=>{
  const h=setup();t.after(()=>h.view.destroy());const value=h.source('hls');h.show(value);
  const first=h.hls[0];first.emit('error','error',{fatal:true});const failure=h.view.state().status;
  assert.equal(h.view.state().active,false);assert.equal(first.destroyed,1);assert.match(failure,/连接中断/);
  const failedLoads=h.video.loads;
  for(let i=0;i<5;i++)h.view.update({...value,descriptor:{...value.descriptor,receivedAt:100001+i}});
  assert.equal(h.hls.length,1);assert.equal(h.video.loads,failedLoads);assert.equal(h.view.state().status,failure);
  h.nodes.videoPlay.click();assert.equal(h.hls.length,2);assert.equal(h.view.state().active,true);
  h.hls[1].emit('error','error',{fatal:true});h.nodes.videoRetry.click();assert.equal(h.hls.length,3);assert.equal(h.view.state().active,true);
});

test('停止按钮阻止同船自动恢复，播放或换船后重新建立连接',t=>{
  const h=setup();t.after(()=>h.view.destroy());const value=h.source('flv');h.show(value);h.nodes.videoStop.click();
  assert.equal(h.flv[0].destroyed,1);assert.equal(h.view.state().active,false);h.view.update(value);assert.equal(h.flv.length,1);
  h.nodes.videoPlay.click();assert.equal(h.flv.length,2);assert.equal(h.view.state().active,true);
  h.nodes.videoStop.click();h.view.update({...value,deviceId:'boat-b'});assert.equal(h.flv.length,3);assert.equal(h.view.state().deviceId,'boat-b');
});

test('切船后旧HLS/FLV播放器异步回调不能播放、失败或销毁新船连接',t=>{
  for(const format of ['hls','flv']){
    const h=setup();t.after(()=>h.view.destroy());h.show(h.source(format));const previous=h.current(format);
    h.view.update({...h.source(format),deviceId:'boat-b'});const current=h.current(format),state=h.view.state(),plays=h.video.plays;
    previous.emit('error','error',{fatal:true});previous.emit('manifest');
    assert.equal(h.view.state().deviceId,'boat-b');assert.equal(h.view.state().active,true);assert.equal(h.view.state().status,state.status);
    assert.equal(h.video.plays,plays);assert.equal(current.destroyed,0);assert.equal(previous.destroyed,1);
  }
});

test('切船后旧自动播放Promise拒绝不能覆盖新船状态',async t=>{
  const h=setup();t.after(()=>h.view.destroy());let reject;
  h.video.playResult=new Promise((resolve,bad)=>reject=bad);h.show(h.source());
  h.video.playResult=Promise.resolve();h.view.update({...h.source(),deviceId:'boat-b'});const status=h.view.state().status;
  reject(Object.assign(Error('old play blocked'),{name:'NotAllowedError'}));await flush();
  assert.equal(h.view.state().deviceId,'boat-b');assert.equal(h.view.state().active,true);assert.equal(h.view.state().status,status);
});

test('切船后旧播放按钮Promise拒绝不能覆盖新船状态',async t=>{
  const h=setup();t.after(()=>h.view.destroy());h.show(h.source());let reject;
  h.video.playResult=new Promise((resolve,bad)=>reject=bad);h.nodes.videoPlay.click();
  h.video.playResult=Promise.resolve();h.view.update({...h.source(),deviceId:'boat-b'});const status=h.view.state().status;
  reject(Object.assign(Error('old manual play blocked'),{name:'NotAllowedError'}));await flush();
  assert.equal(h.view.state().deviceId,'boat-b');assert.equal(h.view.state().active,true);assert.equal(h.view.state().status,status);
});
