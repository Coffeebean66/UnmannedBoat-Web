'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {BoatOnlineUsersPanel}=require('../public/online-users');
const snapshot=()=>({serverTime:100000,onlineWindowMs:90000,userCount:2,sessionCount:3,users:[
  {id:'a'.repeat(32),username:'captain',role:'admin',sessionCount:1,loginAt:10000,lastSeenAt:100000},
  {id:'b'.repeat(32),username:'pilot',role:'driver',sessionCount:2,loginAt:20000,lastSeenAt:95000}
]});
function setup(role='admin'){
  class Node{constructor(){this.listeners=new Map();this.children=[];this.dataset={};this.attributes={};}addEventListener(e,f){this.listeners.set(e,f);}removeEventListener(e){this.listeners.delete(e);}setAttribute(k,v){this.attributes[k]=v;}replaceChildren(...items){this.children=items;}append(...items){this.children.push(...items);}}
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const document={hidden:false,getElementById:node,createElement:()=>new Node()};
  const auth=new EventTarget();Object.assign(auth,{generation:1,enabled:true,ready:true,user:role?{username:'captain',role}:null});
  auth.change=role=>{auth.user=role?{username:'captain',role}:null;auth.generation++;auth.dispatchEvent(new Event('change'));};auth.expire=()=>auth.change(null);auth.initialize=async()=>{};
  const calls=[],timers=new Map();let id=0,next;
  const panel=new BoatOnlineUsersPanel({document,auth,AbortController,
    fetch:async(url,options)=>{calls.push({url,options});if(next)return next();return{ok:true,status:200,json:async()=>snapshot()};},
    setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  return{panel,node,document,auth,calls,timers,next:fn=>next=fn};
}
test('only an administrator opens online users; rows show merged session counts and periodically refresh without credentials',async()=>{
  for(const role of ['driver','guest',null]){const h=setup(role);assert.equal(await h.panel.open(),false);assert.equal(h.calls.length,0);assert.equal(h.node('onlineUsers').hidden,true);h.panel.destroy();}
  const h=setup();assert.equal(await h.panel.open(),true);assert.equal(h.node('onlineUsersList').children.length,2);
  assert.equal(h.node('onlineUsersCount').textContent,'2 位用户在线 · 3 个会话');
  const row=h.node('onlineUsersList').children[1];assert.equal(row.children[0].children[1].children[0].textContent,'驾驶员');
  assert.match(row.children[0].children[1].children[1].textContent,/2 个在线会话/);
  assert.equal(h.calls[0].url,'/api/auth/online');assert.equal(h.calls[0].options.credentials,'same-origin');
  const [pollId,poll]=[...h.timers].find(([,timer])=>timer.ms===15000);assert.ok(poll);h.timers.delete(pollId);poll.fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,2);
  h.panel.close();assert.equal(h.timers.size,0);assert.equal(h.node('onlineUsersList').children.length,0);h.panel.destroy();
});
test('a late online response cannot reveal users after switching to driver or closing the dialog',async()=>{
  for(const action of ['role','close']){
    const h=setup();let release;h.next(()=>new Promise(resolve=>release=resolve));const pending=h.panel.open();
    await new Promise(resolve=>setImmediate(resolve));
    if(action==='role')h.auth.change('driver');else h.panel.close();
    release({ok:true,status:200,json:async()=>snapshot()});assert.equal(await pending,false);
    assert.equal(h.node('onlineUsersList').children.length,0);assert.equal(h.timers.size,0);h.panel.destroy();
  }
});
test('server rejection or malformed rows clear cached online details instead of showing stale users',async()=>{
  const h=setup();await h.panel.open();
  h.next(async()=>({ok:true,status:200,json:async()=>({...snapshot(),users:[{...snapshot().users[0],username:'<script>'},snapshot().users[1]]})}));
  assert.equal(await h.panel.read(),false);assert.equal(h.node('onlineUsersList').children.length,0);assert.match(h.node('onlineUsersStatus').textContent,/无效/);
  h.next(async()=>({ok:false,status:403,json:async()=>({error:'仅管理员可查看'})}));
  assert.equal(await h.panel.read(),false);assert.equal(h.node('onlineUsers').hidden,true);assert.equal(h.timers.size,0);h.panel.destroy();
});
