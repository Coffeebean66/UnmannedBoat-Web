/* 新参数协议、工程单位与真实界面事务；不连接船端或写真实Flash。 */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const O=require('../public/utils/optimalParameters'),P=require('../public/utils/uart4Protocol'),PP=require('../server/parameter-protocol');
function reply(values=O.defaults,status=0){const b=Buffer.from(O.command('optimalWrite',123,values));b[3]=0x92;b[5]=status;b.writeUInt16LE(2500,44);b.writeUInt16LE(P.crc16CcittFalse(b,2,52),54);return b;}
test('LQR wire round trips 15 typed values and rejects CRC, padding, extra fields, wrong response and invalid capability',()=>{
  assert.equal(O.fields.length,15);assert.equal(O.response(reply()).maxTargetMmS,2500);assert.deepEqual(O.response(reply()).parameters,O.defaults);
  for(const f of O.fields){for(const value of [f.min-1,f.max+1,NaN,'1',1.2])assert.throws(()=>O.validate({...O.defaults,[f.key]:value}));}
  for(const values of [{...O.defaults,extra:1},{},[],null])assert.throws(()=>O.validate(values));
  for(const kind of Object.keys(O.kinds)){
    const b=PP.commandFrame(kind,0x12345678,kind==='optimalRead'?undefined:O.defaults);
    assert.equal(b.length,56);assert.equal(b[3],O.kinds[kind]);assert.equal(b.readUInt32LE(6),0x12345678);
    assert.ok(b.subarray(44,54).every(x=>!x));assert.equal(O.response(b),null);
  }
  for(const at of [0,2,3,4,14,44,46,54]){const b=reply();b[at]^=1;assert.equal(O.response(b),null);}
  const bad=reply();bad[46]=1;bad.writeUInt16LE(P.crc16CcittFalse(bad,2,52),54);assert.equal(O.response(bad),null);
  assert.throws(()=>O.command('optimalRead',1,O.defaults));
  const capability={version:1,token:'0123456789abcdef',uptimeMs:1,algorithm:0,lqr:true,optimalParameters:1};
  assert.equal(PP.capability(Buffer.from(JSON.stringify(capability))).optimalParameters,1);
  for(const value of [0,2,true,'1'])assert.equal(PP.capability(Buffer.from(JSON.stringify({...capability,optimalParameters:value}))),null);
  assert.deepEqual(O.guidanceConfig(O.defaults),{sampleS:.1,headingTauS:1.2,crossWeight:.25,headingWeight:2,inputWeight:4,maxOffsetDeg:60});
});
function panel(){
  const inputs=O.fields.map(f=>({dataset:{optimalKey:f.key},value:String(f.value/f.scale)})),ids={},storage=new Map();
  const auth={canManage:true,assertManage(){if(!this.canManage)throw Error('访客只读');}};
  const context={window:{BoatAuth:auth},BoatModules:{optimalParameters:O},Date,localStorage:{setItem:(k,v)=>storage.set(k,v)},
    document:{getElementById:id=>ids[id]||(ids[id]={dataset:{}}),querySelectorAll:s=>s.includes('Fields')?inputs:[]}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/optimal-parameter-panel.js'),'utf8'),context);
  const link={selectedId:'boat-01',generation:1,connected:true,readOnly:false,request:async()=>O.response(reply())};
  const owner={link,busy:false,toast(){}},p=Object.create(context.window.OptimalParameterPanel.prototype);
  Object.assign(p,{owner,link,config:O,box:{hidden:false},confirmed:{...O.defaults},localDraft:null,slots:[null,null,null],supported:true,storageKey:'lqr-presets',renderSlots(){}});
  owner.updateButtons=()=>p.updateButtons();return {p,owner,link,inputs,ids,auth,storage};
}
test('LQR panel accepts engineering units, validates precision and waits for real write/Flash confirmation',async()=>{
  const h=panel();assert.deepEqual({...h.p.form()},O.defaults);
  h.inputs[0].value='2.345';assert.equal(h.p.form().speedGainMmS,2345);h.inputs[0].value='2.3456';assert.throws(()=>h.p.form(),/精度/);h.p.fill(O.defaults);
  const calls=[];h.link.request=async(kind,values)=>{calls.push({kind,values});return O.response(reply(values||O.defaults));};
  for(const kind of ['optimalRead','optimalWrite','optimalFlash']){await h.p.command(kind);assert.equal(h.ids.optimalParameterStatus.dataset.tone,'success');}
  assert.deepEqual(calls.map(c=>c.kind),['optimalRead','optimalWrite','optimalFlash']);assert.equal(calls[0].values,undefined);
  h.inputs[0].value='3';await assert.rejects(h.p.command('optimalFlash'),/先写入/);assert.equal(calls.length,3);
  h.link.request=async()=>O.response(reply(O.defaults,6));await assert.rejects(h.p.command('optimalWrite'),/稳定增益/);
  assert.equal(h.ids.optimalParameterStatus.dataset.tone,'danger');
});
test('LQR unknown writes invalidate confirmations, preserve drafts and forbid Flash until read again',async()=>{
  const h=panel();h.inputs[0].value='3.5';h.link.request=async()=>{throw Object.assign(Error('写入可能生效，请读取确认'),{uncertain:true});};
  await assert.rejects(h.p.command('optimalWrite'),/读取/);assert.equal(h.p.confirmed,null);assert.equal(h.p.localDraft.speedGainMmS,3500);
  assert.equal(h.ids.saveOptimalFlash.disabled,true);await assert.rejects(h.p.command('optimalFlash'),/先读取/);
  h.link.request=async()=>O.response(reply({...O.defaults,speedGainMmS:3500}));await h.p.command('optimalRead');assert.equal(h.p.confirmed.speedGainMmS,3500);
});
test('LQR old boat or role replies cannot overwrite the newly selected boat; old firmware and concurrent commands are blocked',async()=>{
  for(const cause of ['boat','role']){
    const h=panel();let release;h.link.request=()=>new Promise(resolve=>{release=resolve;});const pending=h.p.command('optimalRead');
    if(cause==='boat'){h.link.generation++;h.link.selectedId='boat-02';h.p.reset(false);}else h.auth.canManage=false;
    h.ids.optimalParameterStatus.textContent='新界面';release(O.response(reply()));await assert.rejects(pending,/设备或账户/);
    assert.equal(h.ids.optimalParameterStatus.textContent,'新界面');
  }
  const h=panel();h.p.supported=false;await assert.rejects(h.p.command('optimalRead'),/更新/);h.p.supported=true;h.owner.busy=true;await assert.rejects(h.p.command('optimalRead'),/等待/);
});
test('LQR presets are separate, never auto-send on save, and export correctly converted firmware macros',async()=>{
  const h=panel(),calls=[];h.link.request=async(kind,values)=>{calls.push(kind);return O.response(reply(values));};
  await h.p.actSlot(0,'save');assert.equal(calls.length,0);assert.equal(JSON.parse(h.storage.get('lqr-presets')).length,3);
  h.inputs[0].value='4';await h.p.actSlot(0,'use');assert.deepEqual(calls,['optimalWrite']);assert.equal(h.p.confirmed.speedGainMmS,2500);
  const text=h.p.exportText();assert.match(text,/#define OPTIMAL_SPEED_GAIN_MPS 2.500000f/);assert.match(text,/#define OPTIMAL_YAW_GAIN_RAD_S 1.570796f/);
  assert.match(text,/#define OPTIMAL_GUIDANCE_Q_CROSS 0.250000f/);assert.equal((text.match(/#define /g)||[]).length,15);
});
