/* 本地草稿、设备确认值、Flash 状态分别管理；遥测更新不重绘表单。 */
class ParameterPanel {
  constructor(link, toast) {
    this.link=link;this.toast=toast;this.confirmed=null;this.localDraft=null;this.busy=false;
    this.config=window.BoatParameters;
    this.keys=Object.keys(this.config.ranges);
    this.storageKey='unmanned_boat_web_presets_v1';
    this.slots=[null,null,null];
    this.build();
    try {
      const saved=JSON.parse(localStorage.getItem(this.storageKey));
      if(Array.isArray(saved))this.slots=this.slots.map((_,i)=>saved[i]&&this.valid(saved[i].values)?saved[i]:null);
    } catch(_) { /* 存储损坏时保留三个空槽。 */ }
    this.renderSlots();this.updateButtons();
  }
  valid(values) {
    return !!values&&this.keys.every(k=>Number.isInteger(values[k])&&values[k]>=this.config.ranges[k][0]&&values[k]<=this.config.ranges[k][1]);
  }
  build() {
    const box=document.getElementById('parameterFields');
    const groups=[
      {title:'速度闭环',note:'前馈、PID、船速限制与输出变化',keys:['feedforwardX2PerMps','kpX2PerMps','kiX2PerMpsS','kdX2PerMps2','integralLimitX2','correctionLimitX2','outputLimitX2','outputSlewStepX2','maxTargetMmS','targetSlewStepMmS']},
      {title:'航向控制',note:'航向 PID、误差死区与自动转向上限',keys:['headingKpX100','headingKiX100','headingKdX100','headingIntegralLimitX2','headingOutputLimitX2','headingDeadbandCdeg','headingReversed']},
      {title:'其他参数',note:'人工差速比例与左右电机安装方向',keys:['turnAtFullSpeedPercent','motor1Reversed','motor2Reversed']}
    ];
    const assigned=new Set(groups.flatMap(group=>group.keys));
    const ungrouped=this.keys.filter(key=>!assigned.has(key));
    if(ungrouped.length)groups.push({title:'其他参数',note:'设备支持的其他控制参数',keys:ungrouped});
    for(const group of groups) {
      const keys=group.keys.filter(key=>this.keys.includes(key));
      if(!keys.length)continue;
      const fieldset=document.createElement('fieldset');fieldset.className='parameter-group';
      const legend=document.createElement('legend');legend.append(document.createTextNode(group.title));
      const count=document.createElement('span');count.textContent=keys.length+' 项';legend.append(count);
      const grid=document.createElement('div');grid.className='parameter-group-grid';
      for(const key of keys) {
        const help=this.config.help.find(x=>x.key===key), range=this.config.ranges[key];
        const row=document.createElement('label');row.className='parameter-field';
        const name=document.createElement('span');name.textContent=this.config.labels[key];row.append(name);
        const input=document.createElement(range[1]===1?'select':'input');input.dataset.key=key;
        if(input.tagName==='SELECT') {
          for(const [value,label] of [['','未读取'],['0','正向 / 正常'],['1','反向']])input.add(new Option(label,value));
        } else {input.type='number';input.min=range[0];input.max=range[1];input.step='1';input.placeholder='未读取';}
        input.title=help?help.unit+'；'+help.description:'';
        input.addEventListener('input',()=>this.status('表单已修改，点击“写入参数”后才会发送','warning'));
        row.append(input);
        const hint=document.createElement('small');hint.textContent=help?help.range+' · '+help.unit:range.join(' – ');
        row.append(hint);grid.append(row);
      }
      const note=document.createElement('p');note.className='parameter-group-note';note.textContent=group.note;
      fieldset.append(legend,note,grid);box.append(fieldset);
    }
    const helpBox=document.getElementById('parameterHelp');
    for(const step of this.config.steps) {
      const section=document.createElement('p'), title=document.createElement('strong');
      title.textContent=step.title;section.append(title,document.createElement('br'),step.text.replaceAll('手机预设','浏览器预设').replaceAll('小程序','网页'));helpBox.append(section);
    }
    for(const item of this.config.help) {
      const section=document.createElement('details'),title=document.createElement('summary'),body=document.createElement('p');
      title.textContent=item.name;body.textContent=item.description+' '+item.advice;
      section.append(title,body);helpBox.append(section);
    }
  }
  status(text,tone='neutral') {
    const element=document.getElementById('parameterStatus');
    element.textContent=text;element.dataset.tone=tone;
  }
  inputs() {return document.querySelectorAll('#parameterFields input, #parameterFields select');}
  form() {
    const values={};
    this.inputs().forEach(el=>{values[el.dataset.key]=el.value.trim()===''?NaN:Number(el.value);});
    if(!this.valid(values))throw Error('请完整填写20项范围内的整数参数');
    return values;
  }
  fill(values) {this.inputs().forEach(el=>el.value=String(values[el.dataset.key]));}
  matches(values) {return this.confirmed&&this.keys.every(k=>values[k]===this.confirmed[k]);}
  reset(preserveDraft=false) {
    if(preserveDraft&&this.confirmed){try{this.localDraft=this.form();}catch(_){this.localDraft={...this.confirmed};this.fill(this.localDraft);}}
    this.confirmed=null;
    if(!preserveDraft){this.localDraft=null;this.inputs().forEach(el=>el.value='');}
    this.updateButtons();
    this.status(this.link.readOnly?(this.link.parameterReadOnlyReason||'当前设备只读；本地草稿可保存或导出'):'云端调参已就绪 · 点击“读取参数”获取设备确认值','neutral');
  }
  updateButtons() {
    const hasDraft=!!(this.confirmed||this.localDraft),readOnly=!!this.link.readOnly;
    this.inputs().forEach(el=>el.disabled=this.busy||!hasDraft);
    for(const id of ['writeParameters','saveFlash'])document.getElementById(id).disabled=readOnly||this.busy||!this.confirmed||!this.link.connected;
    for(const id of ['exportParameters','copyParameters'])document.getElementById(id).disabled=this.busy||!hasDraft;
    document.getElementById('fillTuning').disabled=readOnly||this.busy||!this.confirmed;
    document.getElementById('readParameters').disabled=readOnly||this.busy||!this.link.connected;
    document.querySelectorAll('#presets button').forEach(el=>el.disabled=this.busy||
      (el.dataset.action==='save'?!hasDraft:readOnly||!this.link.connected||!this.slots[Number(el.dataset.slot)]));
  }
  async command(kind, preset) {
    window.BoatAuth?.assertManage();
    if(this.link.readOnly)throw Error(this.link.parameterReadOnlyReason||'当前设备只读，请检查管理员权限与设备状态');
    if(this.busy)throw Error('请等待当前操作完成');
    const generation=this.link.generation;
    let values;
    if(kind!=='read') {
      if(!this.confirmed)throw Error('请先读取当前设备参数');
      values=preset||this.form();
      if(!this.valid(values))throw Error('预设参数无效');
      if(kind==='flash'&&!this.matches(values))throw Error('还有未生效的修改，请先写入参数并等待成功，再写入 Flash');
    }
    this.busy=true;this.updateButtons();
    this.status(kind==='read'?'正在读取参数…':kind==='flash'?'正在写入 Flash，请保持供电…':'正在写入参数，等待 STM32 确认…',kind==='flash'?'warning':'neutral');
    try {
      const frame=await this.link.request(kind,values);
      // 云端单次令牌在下发时已消费；等待下个令牌不影响本次真实设备确认。
      if(generation!==this.link.generation||(window.BoatAuth&&!window.BoatAuth.canManage))throw Error('连接已切换，请重新读取设备参数');
      const valid=this.valid(frame.parameters);
      if(valid&&[0,1,3,4,5].includes(frame.status))this.confirmed={...frame.parameters};
      const errors={
        1:'参数被拒绝：超出设备安全范围',2:'设备不支持当前参数命令，请核对固件',
        3:'请将 CH6 切到低档，等待两路停止且反馈正常满1秒后重试',
        4:'Flash 保存失败，当前运行参数仍有效',
        5:'设备参数已变化，Flash 未保存，请重新读取并确认'
      };
      if(frame.status!==0)throw Object.assign(Error(errors[frame.status]||'设备返回未知状态'),{status:frame.status});
      if(!valid)throw Error('设备响应参数不完整或超出范围');
      this.fill(frame.parameters);
      this.status(kind==='flash'?'已保存到 Flash，下次上电自动恢复':kind==='read'?'读取成功 · 已载入20项设备参数':'写入成功 · 已在设备运行中生效，尚未写入 Flash','success');
    } catch(error) {
      // 旧船请求被取消后的迟到异常不能从新船表单恢复出旧草稿。
      if(error.uncertain&&generation===this.link.generation){
        try{this.localDraft=this.form();}catch(_){if(this.confirmed)this.localDraft={...this.confirmed};}
        this.confirmed=null;
      }
      const tone=error.uncertain||[3,5].includes(error.status)?'warning':'danger';
      if(generation===this.link.generation&&(!window.BoatAuth||window.BoatAuth.canManage))this.status(error.message,tone);throw error;
    }
    finally {this.busy=false;this.updateButtons();}
  }
  tune() {
    window.BoatAuth?.assertManage();
    if(this.link.readOnly)throw Error(this.link.parameterReadOnlyReason||'当前设备只读，请检查管理员权限与设备状态');
    if(!this.confirmed)throw Error('请先读取设备参数');
    // 建议只调整速度环，保留方向、差速、航向参数。
    this.fill({...this.form(),...this.config.tuning});
    this.status('已填入2.5 m/s建议草稿；方向和航向参数保留，点击“写入参数”生效','warning');
  }
  renderSlots() {
    const box=document.getElementById('presets');box.replaceChildren();
    this.slots.forEach((slot,i)=>{
      const row=document.createElement('article');row.className='preset '+(slot?'saved':'empty');row.dataset.slot=i;
      const heading=document.createElement('div');heading.className='preset-heading-line';
      const label=document.createElement('span');label.textContent='预设 '+String(i+1).padStart(2,'0');
      const badge=document.createElement('span');badge.className='preset-badge';badge.textContent=slot?'已保存':'空槽位';heading.append(label,badge);row.append(heading);
      const timestamp=document.createElement('small');timestamp.textContent=slot?'保存于 '+new Date(slot.at).toLocaleString():'保存当前参数到此槽位';row.append(timestamp);
      const actions=document.createElement('div');actions.className='button-row';
      for(const [action,title] of [['save','保存当前'],['use','一键使用']]) {
        const button=document.createElement('button');button.type='button';button.textContent=title;button.className='small-button '+(action==='use'?'primary':'');button.dataset.slot=i;button.dataset.action=action;
        button.setAttribute('aria-label','预设 '+(i+1)+'：'+title);
        button.onclick=()=>this.actSlot(i,action).catch(e=>this.toast(e.message));actions.append(button);
      }
      row.append(actions);box.append(row);
    });
  }
  async actSlot(i,action) {
    if(this.busy)throw Error('请等待当前参数操作完成');
    if(action==='save') {
      if(!this.confirmed&&!this.localDraft)throw Error('请先读取设备参数');
      const values=this.form(),next=this.slots.slice();next[i]={at:Date.now(),values};
      try{localStorage.setItem(this.storageKey,JSON.stringify(next));}catch(_){throw Error('浏览器本地存储不可用，预设未保存');}
      this.slots=next;this.renderSlots();this.updateButtons();this.status('已保存到浏览器预设 '+(i+1)+'；不代表已写入设备或 Flash','success');
    } else {
      window.BoatAuth?.assertManage();
      if(this.link.readOnly)throw Error(this.link.parameterReadOnlyReason||'当前设备只读，暂不能使用预设');
      const slot=this.slots[i];if(!slot||!this.valid(slot.values))throw Error('预设为空或无效');
      if(!this.confirmed)await this.command('read');
      this.fill(slot.values);await this.command('write',slot.values);
    }
  }
  exportText() {
    if(!this.confirmed&&!this.localDraft)throw Error('请先读取设备参数');
    const values=this.form();
    return BoatModules.parameterExport.formatParameterExport(values,!!this.matches(values)).replaceAll('小程序','网页');
  }
}
window.ParameterPanel=ParameterPanel;
