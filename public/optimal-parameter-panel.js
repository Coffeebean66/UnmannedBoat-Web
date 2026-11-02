/* LQR配置单独保存设备确认值和草稿；与公共参数共用单在途操作和账户边界。 */
class OptimalParameterPanel {
  constructor(owner) {
    this.owner=owner;this.link=owner.link;this.config=BoatModules.optimalParameters;
    this.confirmed=null;this.localDraft=null;this.busy=false;this.supported=false;
    this.storageKey='unmanned_boat_web_lqr_presets_v1';this.slots=[null,null,null];
    try{const saved=JSON.parse(localStorage.getItem(this.storageKey));if(Array.isArray(saved))this.slots=this.slots.map((_,i)=>this.valid(saved[i]?.values)?saved[i]:null);}catch(_){}
    this.build();this.renderSlots();this.updateButtons();
  }
  valid(values){try{this.config.validate(values);return true;}catch(_){return false;}}
  build(){
    this.box=document.getElementById('optimalParameterSection');
    const fields=document.getElementById('optimalParameterFields');
    for(const group of [...new Set(this.config.fields.map(f=>f.group))]){
      const fieldset=document.createElement('fieldset');fieldset.className='parameter-group';
      const legend=document.createElement('legend');legend.textContent=group;
      const grid=document.createElement('div');grid.className='parameter-group-grid';
      for(const f of this.config.fields.filter(f=>f.group===group)){
        const row=document.createElement('label');row.className='parameter-field';
        const title=document.createElement('span');title.textContent=f.label;
        const input=document.createElement('input');input.type='number';input.dataset.optimalKey=f.key;
        input.min=f.min/f.scale;input.max=f.max/f.scale;input.step=1/f.scale;input.placeholder='未读取';input.title=f.help;
        input.addEventListener('input',()=>this.status('LQR表单已修改，点击“写入LQR参数”后才会发送','warning'));
        const hint=document.createElement('small');hint.textContent=(f.min/f.scale)+' – '+(f.max/f.scale)+' '+f.unit;
        row.append(title,input,hint);grid.append(row);
      }
      fieldset.append(legend,grid);fields.append(fieldset);
    }
    for(const [id,kind] of [['readOptimalParameters','optimalRead'],['writeOptimalParameters','optimalWrite'],['saveOptimalFlash','optimalFlash']])
      document.getElementById(id).onclick=()=>this.command(kind).catch(e=>this.owner.toast(e.message));
    document.getElementById('fillOptimalDefaults').onclick=()=>{
      if(!this.confirmed||this.owner.busy)return;
      this.fill(this.config.defaults);this.status('已填入参考初值草稿，尚未发送；请根据水测模型逐项调整','warning');
    };
    document.getElementById('copyOptimalParameters').onclick=async()=>{
      try{await navigator.clipboard.writeText(this.exportText());this.status('已复制LQR参数与初始宏定义','success');}catch(e){this.owner.toast(e.message);}
    };
    document.getElementById('exportOptimalParameters').onclick=()=>{
      try{const url=URL.createObjectURL(new Blob([this.exportText()],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');
        a.href=url;a.download='boat-lqr-parameters-'+new Date().toISOString().slice(0,10)+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }catch(e){this.owner.toast(e.message);}
    };
  }
  inputs(){return document.querySelectorAll('#optimalParameterFields input');}
  form(){
    const values={};
    this.inputs().forEach(input=>{const f=this.config.fields.find(f=>f.key===input.dataset.optimalKey),n=Number(input.value),v=n*f.scale;
      values[f.key]=input.value.trim()===''||!Number.isFinite(v)||Math.abs(v-Math.round(v))>1e-6?NaN:Math.round(v);});
    if(!this.valid(values))throw Error('请完整填写15项LQR参数，并按提示范围和小数精度输入');return values;
  }
  fill(values){this.inputs().forEach(input=>{const f=this.config.fields.find(f=>f.key===input.dataset.optimalKey);input.value=String(values[f.key]/f.scale);});}
  status(text,tone='neutral'){const el=document.getElementById('optimalParameterStatus');el.textContent=text;el.dataset.tone=tone;}
  reset(preserveDraft=false){
    if(preserveDraft&&this.confirmed){try{this.localDraft=this.form();}catch(_){this.localDraft={...this.confirmed};}}
    this.confirmed=null;
    if(!preserveDraft){this.localDraft=null;this.inputs().forEach(el=>el.value='');}
    this.status('点击“读取LQR参数”获取当前船的实际配置');this.updateButtons();
  }
  setContext(algorithm,supported){
    this.box.hidden=algorithm!==1;this.supported=!!supported;
    document.getElementById('optimalParameterUnsupported').hidden=this.supported;
    this.updateButtons();
  }
  updateButtons(){
    const busy=!!(this.owner.busy||this.link.pending),draft=!!(this.confirmed||this.localDraft);
    const ready=this.supported&&!this.box.hidden&&!this.link.readOnly&&this.link.connected;
    this.inputs().forEach(el=>el.disabled=busy||!draft);
    document.getElementById('readOptimalParameters').disabled=busy||!ready;
    for(const id of ['writeOptimalParameters','saveOptimalFlash'])document.getElementById(id).disabled=busy||!ready||!this.confirmed;
    document.getElementById('fillOptimalDefaults').disabled=busy||!ready||!this.confirmed;
    for(const id of ['copyOptimalParameters','exportOptimalParameters'])document.getElementById(id).disabled=busy||!draft;
    document.querySelectorAll('#optimalPresets button').forEach(el=>el.disabled=busy||(el.dataset.action==='save'?!draft:!ready||!this.confirmed||!this.slots[Number(el.dataset.slot)]));
  }
  async command(kind,preset){
    window.BoatAuth.assertManage();
    if(this.owner.busy||this.link.pending)throw Error('请等待当前参数操作完成');
    if(!this.supported)throw Error('请先更新支持LQR在线调参的船端固件');
    if(this.box.hidden||this.link.readOnly)throw Error(this.link.parameterReadOnlyReason||'请确认当前船正在使用新算法且在线');
    const generation=this.link.generation,deviceId=this.link.selectedId;
    let values;
    if(kind!=='optimalRead'){
      if(!this.confirmed)throw Error('请先读取当前船的LQR参数');
      values=preset||this.form();this.config.validate(values);
      if(kind==='optimalFlash'&&!this.config.fields.every(f=>values[f.key]===this.confirmed[f.key]))throw Error('LQR表单还有未生效的修改，请先写入参数，再保存到Flash');
    }
    this.busy=this.owner.busy=true;this.owner.updateButtons();
    this.status(kind==='optimalRead'?'正在读取LQR参数…':kind==='optimalFlash'?'正在保存LQR与当前通用参数到Flash…':'正在写入LQR参数并验证模型…');
    const current=()=>generation===this.link.generation&&deviceId===this.link.selectedId&&window.BoatAuth.canManage;
    try{
      const frame=await this.link.request(kind,values);
      if(!current())throw Error('设备或账户已变化，请重新读取LQR参数');
      if(this.valid(frame.parameters))this.confirmed={...frame.parameters};
      const errors={1:'LQR参数超出允许范围，原配置保留',2:'固件不支持LQR参数命令',3:'请结束任务和驾驶接管，保持零指令、两路反馈正常且停稳满1秒后重试',
        4:'Flash保存失败，当前运行配置仍有效',5:'船端LQR配置已变化，请重新读取后确认保存',6:'模型无法求得稳定增益，原配置保留，请调整模型或权重'};
      if(frame.status!==0)throw Object.assign(Error(errors[frame.status]||'设备返回未知状态'),{status:frame.status});
      if(!this.valid(frame.parameters))throw Error('设备LQR响应不完整，请重新读取');
      this.fill(frame.parameters);this.localDraft=null;
      this.status(kind==='optimalRead'?'LQR读取成功 · 已载入15项船端实际配置':kind==='optimalFlash'?'已保存到Flash，重启恢复配置；上电仍默认原PID算法':'LQR写入成功 · 船速/航向已生效，航线配置用于下次任务；尚未保存到Flash','success');
    }catch(e){
      if(current()){
        if(e.uncertain){try{this.localDraft=this.form();}catch(_){this.localDraft=this.confirmed?{...this.confirmed}:null;}this.confirmed=null;}
        this.status(e.message,e.uncertain||[3,5].includes(e.status)?'warning':'danger');
      }
      throw e;
    }finally{this.busy=this.owner.busy=false;this.owner.updateButtons();}
  }
  renderSlots(){
    const box=document.getElementById('optimalPresets');box.replaceChildren();
    this.slots.forEach((slot,i)=>{
      const row=document.createElement('article');row.className='preset '+(slot?'saved':'empty');
      const title=document.createElement('strong');title.textContent='LQR预设 '+(i+1);
      const time=document.createElement('small');time.textContent=slot?new Date(slot.at).toLocaleString():'空槽位';
      const actions=document.createElement('div');actions.className='button-row';
      for(const [action,label]of [['save','保存当前'],['use','一键使用']]){
        const b=document.createElement('button');b.type='button';b.className='small-button';b.dataset.action=action;b.dataset.slot=i;b.textContent=label;
        b.onclick=()=>this.actSlot(i,action).catch(e=>this.owner.toast(e.message));actions.append(b);
      }
      row.append(title,time,actions);box.append(row);
    });
  }
  async actSlot(index,action){
    if(this.owner.busy||this.link.pending)throw Error('请等待当前参数操作完成');
    if(action==='save'){
      if(!this.confirmed&&!this.localDraft)throw Error('请先读取LQR参数');
      const next=this.slots.slice();next[index]={at:Date.now(),values:this.form()};
      try{localStorage.setItem(this.storageKey,JSON.stringify(next));}catch(_){throw Error('本地存储不可用，预设未保存');}
      this.slots=next;this.renderSlots();this.updateButtons();this.status('已保存到本浏览器LQR预设 '+(index+1)+'；尚未写入设备或Flash','success');
    }else{
      const slot=this.slots[index];if(!this.confirmed)throw Error('请先读取当前船的LQR参数');
      if(!this.valid(slot?.values))throw Error('LQR预设为空或无效');
      await this.command('optimalWrite',slot.values);
    }
  }
  exportText(){
    if(!this.confirmed&&!this.localDraft)throw Error('请先读取LQR参数');
    const values=this.form(),active=!!this.confirmed&&this.config.fields.every(f=>values[f.key]===this.confirmed[f.key]);
    const macros=['OPTIMAL_SPEED_GAIN_MPS','OPTIMAL_SPEED_TAU_S','OPTIMAL_SPEED_Q_ERROR','OPTIMAL_SPEED_Q_INTEGRAL','OPTIMAL_SPEED_R_INPUT',
      'OPTIMAL_YAW_GAIN_RAD_S','OPTIMAL_YAW_TAU_S','OPTIMAL_YAW_Q_ANGLE','OPTIMAL_YAW_Q_RATE','OPTIMAL_YAW_R_INPUT',
      'OPTIMAL_GUIDANCE_TAU_S','OPTIMAL_GUIDANCE_Q_CROSS','OPTIMAL_GUIDANCE_Q_YAW','OPTIMAL_GUIDANCE_R_INPUT','OPTIMAL_GUIDANCE_MAX_DEG'];
    return ['无人船LQI/LQR参数 · '+(this.link.selectedId||'未连接'),new Date().toISOString(),active?'与最近设备确认值一致；是否已保存Flash请以保存响应为准':'本地草稿，尚未确认生效',
      ...this.config.fields.map(f=>f.label+' = '+values[f.key]/f.scale+' '+f.unit),'','// optimal_control_config.h 编译初值（不包含算法选择）',
      ...this.config.fields.map((f,i)=>'#define '+macros[i]+' '+(f.key==='yawGainCdegS'?values[f.key]*Math.PI/18000:values[f.key]/f.scale).toFixed(6)+'f'),''].join('\n');
  }
}
window.OptimalParameterPanel=OptimalParameterPanel;
