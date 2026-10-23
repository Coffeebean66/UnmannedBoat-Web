/* 监控页面只在固定频率更新文本；姿态直接接收 IMU，参数界面独立维护。 */
(() => {
  'use strict';
  const M=BoatModules, $=id=>document.getElementById(id);
  const link=new BoatSourceLink(),cloud=link.cloud;
  let toastTimer;
  function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
  const params=new ParameterPanel(link,toast), viewer=new AttitudeView($('boatCanvas'));
  const horizon=new BoatArtificialHorizon($('imuHorizon'));
  const mapSettings=new BoatMapSettingsPanel();
  const wgs=(latitude,longitude)=>Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180?{latitude,longitude}:null;
  const track=new M.boatTrack.BoatTrack(wgs);
  const state={latest:{},history:[],chartMode:'speed',lastReceived:null,deviceId:null,source:'bluetooth'};
  let map,marker,mapVectors,trackRevision=-1,lastLocation,hadFix=false;
  let chartPalette;
  const set=(id,value)=>{const text=value==null?'--':String(value);if($(id).textContent!==text)$(id).textContent=text;};
  function readChartPalette() {
    const style=getComputedStyle(document.documentElement);
    chartPalette={
      background:style.getPropertyValue('--chart-bg').trim(),grid:style.getPropertyValue('--chart-grid').trim(),
      text:style.getPropertyValue('--chart-text').trim(),target:style.getPropertyValue('--chart-target').trim(),
      actual:style.getPropertyValue('--chart-actual').trim()
    };
  }
  function updateMapAvailability(fixFresh) {
    if(fixFresh==null) {
      const latest=state.latest.velocity;
      fixFresh=M.velocityDisplay.prepareVelocityDisplay(latest?.frame,latest?.at||0,performance.now(),link.connected).fixFresh;
    }
    // 底图就绪与船位有效性分别判断，等待定位时也允许浏览、平移和缩放地图。
    const ready=!!map?.ready;
    $('mapEmpty').hidden=ready;
    $('mapFixStatus').hidden=!ready||fixFresh;
    set('mapFixStatus',hadFix?'定位已失效 · 等待新定位':'等待有效定位 · 可拖动、缩放地图');
    if(!ready) {
      $('mapEmpty').querySelector('strong').textContent=map?.status?.tone==='error'?'地图加载失败':'正在加载地图';
      $('mapEmpty').querySelector('span:last-child').textContent=map?.status?.message||'正在准备底图，无需等待船位定位';
    }
  }
  for(let i=1;i<=2;i++) {
    const card=document.createElement('article');card.className='card motor';
    card.innerHTML='<div class="card-title"><div class="title-with-icon"><span class="card-icon '+(i===1?'teal':'blue')+'" data-icon="motor"></span><h3>推进器 / 电机 '+i+'</h3></div><span id="motor'+i+'State" class="state">未连接</span></div>'+
      '<div class="motor-main"><div class="motor-dial" aria-label="PWM 输出"><svg viewBox="0 0 80 80" aria-hidden="true"><circle class="dial-track" cx="40" cy="40" r="35"></circle><circle id="motor'+i+'Dial" class="dial-value" cx="40" cy="40" r="35"></circle></svg><span data-icon="motor"></span></div>'+
      '<div class="motor-rpm"><strong id="motor'+i+'Rpm">--</strong><span>RPM</span><p>机械转速反馈</p></div><div class="motor-output"><strong><span id="motor'+i+'Pwm">--</span><small>%</small></strong><p>输出 PWM</p></div></div>'+
      '<div class="motor-values">'+[['Voltage','电压','V'],['Current','电流','A'],['Temp','温度','°C'],['Power','功率','W']].map(row=>
        '<div><span>'+row[1]+'</span><b id="motor'+i+row[0]+'">--</b><small>'+row[2]+'</small></div>').join('')+'</div>'+
      '<div class="motor-extra"><span>方向 <b id="motor'+i+'Direction">--</b></span><span>电气转速 <b id="motor'+i+'ElectricalRpm">--</b> eRPM</span><span>累计容量 <b id="motor'+i+'Capacity">--</b> mAh</span><span>反馈 <b id="motor'+i+'Age">--</b> ms</span><span>序号 <b id="motor'+i+'Sequence">--</b></span></div>';
    $('motors').append(card);
    window.BoatUI?.decorate(card);
  }
  function renderMotor(frame,received,now) {
    const current=link.connected&&frame&&now-received<1000;
    for(let i=1;i<=2;i++) {
      const m=frame?.motors[i-1],age=m?.feedbackAgeMs==null?null:m.feedbackAgeMs+Math.max(0,now-received);
      const valid=!!(current&&m.received&&m.displayValid&&age!=null&&age<1000);
      const pwm=current?Number(m.appliedPwmPercent):null;
      const values={
        Rpm:valid?Math.round(m.mechanicalRpm):'--',Pwm:Number.isFinite(pwm)?pwm.toFixed(1):'--',
        Direction:current?(m.reverse?'反向':'正向'):'--',
        Voltage:valid?m.voltageV.toFixed(2):'--',Current:valid?m.currentA.toFixed(2):'--',
        Temp:valid?m.temperatureC:'--',Power:valid?(m.voltageV*m.currentA).toFixed(1):'--',
        Capacity:valid?m.capacityMah:'--',ElectricalRpm:valid?m.electricalRpm:'--',
        Age:m?.received&&age!=null?Math.round(age):'--',Sequence:frame?m.telemetrySequence:'--'
      };
      for(const [key,value] of Object.entries(values))set('motor'+i+key,value);
      $('motor'+i+'Dial').style.strokeDasharray=Number.isFinite(pwm)?(Math.min(100,Math.abs(pwm))*1.65).toFixed(1)+' 220':'0 220';
      set('motor'+i+'State',!link.connected?'未连接':!m?'等待电调数据':!current?'链路超时':!valid?'遥测无效/过期':!m.feedbackFresh||age>=100?'反馈超时':Math.abs(m.appliedPwmPercent)>=1||m.mechanicalRpm>=50?'运行中':'待机');
    }
    set('sbusStatus',!current?'遥控 --':frame.sbusFailsafe?'遥控失控保护':frame.sbusLinkValid?'遥控在线':'遥控失联');
    set('statusSequence',frame?.sequence);set('deviceUptime',current?(frame.timestampMs/1000).toFixed(1)+' s':'--');
  }
  function drawChart(now) {
    const canvas=$('chart'),ctx=canvas.getContext('2d'),width=canvas.clientWidth,height=canvas.clientHeight;
    if(!width)return;
    const ratio=Math.min(devicePixelRatio||1,2),pw=Math.round(width*ratio),ph=Math.round(height*ratio);
    if(canvas.width!==pw)canvas.width=pw;if(canvas.height!==ph)canvas.height=ph;
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle=chartPalette.background;ctx.fillRect(0,0,width,height);
    const chart=M.boatChart.prepareBoatChart(state.history,state.chartMode),heading=state.chartMode==='heading';
    const left=48,top=26,right=14,bottom=30,w=Math.max(1,width-left-right),h=height-top-bottom,span=chart.maxValue-chart.minValue||1;
    ctx.font='11px sans-serif';ctx.lineWidth=1;ctx.textAlign='right';
    for(let i=0;i<=4;i++) {
      const y=top+h*i/4,value=chart.maxValue-span*i/4;
      ctx.strokeStyle=chartPalette.grid;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();
      ctx.fillStyle=chartPalette.text;ctx.fillText(value.toFixed(heading?0:1),left-8,y+4);
    }
    ctx.textAlign='left';ctx.fillStyle=chartPalette.text;ctx.fillText(heading?'°（连续角度）':'m/s',left,15);
    for(let i=0;i<=4;i++){ctx.textAlign=i===4?'right':'left';ctx.fillStyle=chartPalette.text;ctx.fillText((12-i*3)+'秒前',left+w*i/4,height-8);}
    for(const [key,color] of [['target',chartPalette.target],['actual',chartPalette.actual]]) {
      ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();let previous=null;
      for(const point of chart.samples) {
        if(!Number.isFinite(point[key])){previous=null;continue;}
        const x=left+(point.timestamp-(now-12000))/12000*w,y=top+h-(point[key]-chart.minValue)/span*h;
        if(x<left){previous=null;continue;}
        if(!previous||point.timestamp-previous.timestamp>=1000)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        previous=point;
      }ctx.stroke();
    }
    if(!chart.hasValues){ctx.fillStyle=chartPalette.text;ctx.textAlign='center';ctx.fillText('等待有效'+(heading?'航向闭环':'船速闭环')+'数据',width/2,height/2);}
    const b=state.latest.boat;
    const live=M.boatChart.createBoatChartSample(b?.frame,b?.at||0,now,link.connected);
    const summary=M.boatChart.prepareBoatChartSummary(live,state.chartMode);
    const unit=heading?'°':' m/s';
    set('chartTarget',summary.target==='--'?'--':summary.target+unit);
    set('chartActual',summary.actual==='--'?'--':summary.actual+unit);
    set('chartError',summary.error==='--'?'--':summary.error+unit);
    set('chartSummary','目标 '+summary.target+unit+' · 实际 '+summary.actual+unit+' · 误差 '+summary.error+unit+(heading?'（目标−实际，取最短角差）':'（实际−目标）'));
  }
  function setupMap() {
    map=new BoatMapView('map');
    map.on('status',status=>{set('mapStatus',status.message);updateMapLabels();updateMapAvailability();});
    map.on('switching',()=>updateMapLabels());
    map.on('providerchange',()=>{
      updateMapLabels();
      const latest=state.latest.velocity;
      // 等待底图期间仍会收遥测；用最新船位恢复覆盖物，同时保留用户视野。
      if(latest)position(latest.frame,latest.at,performance.now(),true);
      render();
    });
    map.on('dragstart',()=>$('mapFollow').checked=false);
    // 栅格断点和遥测标签会改变容器尺寸，由地图门面更新底图与箭头锚点。
    const mapResize=new ResizeObserver(()=>map.invalidateSize());
    mapResize.observe($('map'));
    window.addEventListener('pagehide',()=>{mapResize.disconnect();map.destroy();},{once:true});
    $('trackLegend').innerHTML=M.boatTrack.TRACK_SPEED_LEGEND.map(i=>'<span><i style="background:'+i.color+'"></i>'+i.label+(i.id==='unknown'?'':' m/s')+'</span>').join('');
    map.initialize().then(()=>{
      updateMapLabels();trackRevision=-1;
      const latest=state.latest.velocity;
      if(latest)position(latest.frame,latest.at,performance.now());
      updateMapAvailability();
      render();
    }).catch(()=>{set('mapStatus','地图初始化失败，RTK 原始数据仍可查看');updateMapAvailability();});
  }
  function updateMapLabels() {
    const amap=map?.provider==='amap';
    set('mapLayerName',amap?'高德地图':map?.provider==='osm'?'OpenStreetMap':'地图加载中');
    set('mapCoordinateSystem',amap?'GCJ-02':'WGS84');
    const button=$('mapProviderToggle');
    const nextOsm=amap||!map?.ready;
    button.disabled=!map||map.switching;
    button.setAttribute('aria-busy',String(!!map?.switching));
    set('mapProviderToggle',map?.switching?'正在切换…':nextOsm?'切换至 OSM':'切换至高德');
    button.title=nextOsm?'切换为 OpenStreetMap，保留轨迹和船位':'切换为高德地图；需管理员先配置 Key 与安全密钥';
    const source=link.source==='cloud'?'云端实时监测':'本地实时监测';
    set('heroSourceLabel',source+' / '+(amap?'高德地图':map?.provider==='osm'?'OpenStreetMap':'地图加载中'));
  }
  function position(frame,at,now,preserveView=false) {
    const view=M.velocityDisplay.prepareVelocityDisplay(frame,at,now,link.connected),v=frame?.velocity;
    if(view.fixFresh) {
      lastLocation=[v.latitude,v.longitude];
      if(map?.ready) {
        // 所有地图输入仍为 WGS84；只由地图门面统一转换，避免船位和轨迹重复偏移。
        const fix={latitude:v.latitude,longitude:v.longitude};
        const firstMapFix=!marker;
        if(!marker)marker=map.createMarker(fix,{className:'boat-pin',html:'<span>▲</span>',iconSize:[30,30],iconAnchor:[15,15]});
        marker.setPosition(fix);marker.setOpacity(1);
        const arrow=marker.getElement()?.firstElementChild;if(arrow)arrow.style.transform='rotate('+(view.headingFresh?v.headingDegrees:0)+'deg)';
        if(!preserveView&&$('mapFollow').checked)map.setView(lastLocation,firstMapFix?16:map.getZoom(),{animate:false});
      }
      hadFix=true;
      track.record(v,now,true);
    } else {track.breakSegment();marker?.setOpacity(.3);}
    updateMapAvailability(view.fixFresh);
    renderTrack(view.fixFresh);
  }
  function renderTrack(fresh) {
    if(map?.ready&&trackRevision!==track.revision) {
      map.setTrackLines(track.polylines());
      trackRevision=track.revision;
    }
    set('trackStatus',(track.active?(fresh?'正在追踪':'等待有效定位'):'已停止')+' · '+track.pointCount+'点'+(track.truncated?' · 已裁剪最早轨迹':''));
    $('trackStart').textContent=track.active?'停止追踪':'开始追踪';
  }
  function render() {
    if(document.hidden)return;
    const now=performance.now(),x=state.latest;
    const b=M.boatDisplay.prepareBoatDisplay(x.boat?.frame,x.boat?.at||0,now,link.connected);
    for(const [id,key] of Object.entries({boatStatus:'status',boatActual:'actual',boatTarget:'target',boatRequested:'requested',boatDirection:'direction',boatMode:'modeText',boatHeading:'actualHeading',boatTargetHeading:'targetHeading',boatHeadingError:'headingError',boatCommon:'common',boatTurn:'turn'}))set(id,b[key]);
    $('boatMeter').style.width=(Number.isFinite(Number(b.common))?Math.min(100,Math.abs(Number(b.common))):0)+'%';
    const v=M.velocityDisplay.prepareVelocityDisplay(x.velocity?.frame,x.velocity?.at||0,now,link.connected);
    for(const [id,key] of Object.entries({velocityStatus:'status',velocityPlanar:'planar',velocityX:'x',velocityY:'y',latitude:'latitude',longitude:'longitude',rtkHeading:'heading',velocityAge:'ageText',velocitySequence:'sequence',rtkAlignment:'alignmentText',fixStatus:'fixStatus'}))set(id,v[key]);
    set('mapCoordinate',v.fixFresh?v.latitude+', '+v.longitude:'--（无有效定位）');
    if(!v.fixFresh){track.breakSegment();marker?.setOpacity(.3);}
    updateMapAvailability(v.fixFresh);
    renderTrack(v.fixFresh);
    mapVectors.render(M.mapVelocity.prepareMapVelocity(x.boat?.frame,x.boat?.at||0,x.velocity?.frame,x.velocity?.at||0,now,link.connected));
    const imu=M.imuDisplay.prepareImuDisplay(x.imu?.frame,x.imu?.at||0,now,link.connected);
    for(const key of ['roll','pitch','yaw','gyroX','gyroY','gyroZ'])set(key,imu[key]);
    for(const [id,key] of Object.entries({imuStatus:'status',imuSequence:'sequence',imuAge:'ageText',imuAlignment:'alignmentText',imuHeadingUpdate:'headingUpdateText'}))set(id,imu[key]);
    viewer.setTelemetry(imu);
    horizon.setTelemetry(imu);
    renderMotor(x.status?.frame,x.status?.at||0,now);
    const stats=link.parser.getStats();
    for(const [id,key] of Object.entries({frameCount:'framesReceived',parsedFrames:'framesReceived',crcErrors:'crcErrors',bufferedBytes:'bufferedBytes',bytesReceived:'bytesReceived'}))set(id,stats[key]);
    set('linkAge',state.lastReceived==null?'--':Math.round(now-state.lastReceived)+' ms');
    state.history=state.history.filter(s=>now-s.timestamp<=12000);
    drawChart(now);
  }
  link.addEventListener('frame',({detail:frame})=>{
    const now=performance.now(),at=Number.isFinite(frame.receivedAtMonotonic)?frame.receivedAtMonotonic:now;
    if(now-at>=1000)return;
    state.lastReceived=at;
    if(frame.motors)state.latest.status={frame,at};
    if(frame.boat) {
      state.latest.boat={frame,at};
      state.history.push(M.boatChart.createBoatChartSample(frame,at,now,link.connected,state.history.at(-1)));
      if(state.history.length>240)state.history.shift();
    }
    if(frame.velocity){state.latest.velocity={frame,at};position(frame,at,now);}
    if(frame.imu){
      state.latest.imu={frame,at};
      const imu=M.imuDisplay.prepareImuDisplay(frame,at,now,link.connected);
      viewer.setTelemetry(imu);horizon.setTelemetry(imu);
    }
  });
  function updateConnectionButtons() {
    const waiting=link.source==='cloud'&&cloud.wanted;
    $('connectButton').disabled=link.connected||link.busy||waiting||!!(window.BoatAuth&&!window.BoatAuth.canMonitor);
    $('disconnectButton').disabled=!link.connected&&!waiting&&!link.busy;
  }
  function clearLive() {
    state.latest={};state.history=[];state.lastReceived=null;viewer.reset();horizon.reset();track.stop();track.breakSegment();
    marker?.remove();marker=null;lastLocation=null;hadFix=false;updateMapAvailability(false);
  }
  link.addEventListener('connection',({detail:c})=>{
    $('connectionBadge').textContent=c.connected?'已连接':'未连接';
    $('connectionBadge').className='badge '+(c.connected?'online':'offline');
    updateConnectionButtons();params.reset(link.readOnly||link.source==='cloud');clearLive();
    if(state.source!==link.source){track.clear();state.deviceId=null;state.source=link.source;}
    if(c.connected) {
      if(state.deviceId!==c.id)track.clear();
      state.deviceId=c.id;set('deviceName',c.name);set('notifyCharacteristic',c.tx);set('writeCharacteristic',c.rx);
      set('connectionText',link.source==='cloud'?'云端实时遥测 · '+c.name+(window.BoatAuth?.user?.role==='guest'?' · 访客只读监测':link.readOnly?' · 当前设备只读':' · 管理员可远程调参'):c.readOnly?'已连接 '+c.name+' · 访客只读监测':'已连接 '+c.name+'，等待 UART4 遥测；参数仅在点击时读取。');
    } else {
      set('deviceName','--');set('connectionText',c.message||'已断开');set('notifyCharacteristic','--');set('writeCharacteristic','--');
    }
    render();
  });
  function on(id,fn){$(id).onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message));}
  // requestDevice 必须直接位于用户手势回调，避免浏览器丢失授权上下文。
  $('connectButton').onclick=async()=>{
    $('connectButton').disabled=true;
    try{await link.connect($('cloudDevice').value);}catch(e){if(e.name!=='NotFoundError')toast(e.message);}
    finally{updateConnectionButtons();}
  };
  on('disconnectButton',()=>link.disconnect());
  on('chartModeButton',()=>{
    state.chartMode=state.chartMode==='speed'?'heading':'speed';
    set('chartTitle',state.chartMode==='speed'?'船速曲线':'航向角曲线');
    set('chartModeButton',state.chartMode==='speed'?'切换为航向角':'切换为速度');render();
  });
  on('chartClear',()=>{state.history=[];render();});
  on('trackStart',()=>{track.active?track.stop():track.start();const x=state.latest.velocity;position(x?.frame,x?.at||0,performance.now());render();});
  on('trackClear',()=>{track.clear();render();});
  on('mapVectorsToggle',()=>mapVectors.toggle());
  on('mapProviderToggle',async()=>{
    const switched=await map.switchProvider(map.provider==='amap'||!map.ready?'osm':'amap');
    if(switched)toast('已切换至'+(map.provider==='amap'?'高德地图':' OpenStreetMap'));
  });
  on('mapCenter',()=>{if(!map?.ready)toast('地图尚未就绪，请查看地图底部提示');else if(lastLocation)map.setView(lastLocation,16);else toast('尚无有效定位');});
  $('mapFollow').onchange=()=>{if($('mapFollow').checked&&lastLocation&&map?.ready)map.setView(lastLocation,16);};
  const openSettings=()=>{window.BoatAuth?.assertManage();$('settingsDialog').showModal();mapSettings.open();};
  on('settingsToggle',openSettings);
  on('settingsEntry',openSettings);
  on('sidebarSettings',openSettings);
  on('settingsClose',()=>$('settingsDialog').close());
  for(const [id,kind] of [['readParameters','read'],['writeParameters','write'],['saveFlash','flash']])on(id,()=>params.command(kind));
  on('fillTuning',()=>params.tune());
  on('helpToggle',()=>{$('parameterHelp').hidden=!$('parameterHelp').hidden;});
  on('exportParameters',()=>{
    const url=URL.createObjectURL(new Blob(['\uFEFF'+params.exportText()],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download='unmanned-boat-parameters-'+new Date().toISOString().slice(0,10)+'.txt';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出参数文件');
  });
  on('copyParameters',async()=>{if(!navigator.clipboard)throw Error('浏览器不支持剪贴板，请使用导出 .txt');await navigator.clipboard.writeText(params.exportText());toast('参数已复制');});
  $('animationEnabled').checked=viewer.settings.animation;$('waterEnabled').checked=viewer.settings.water;$('quality').value=viewer.settings.quality;
  $('animationEnabled').onchange=e=>viewer.configure('animation',e.target.checked);
  $('waterEnabled').onchange=e=>viewer.configure('water',e.target.checked);
  $('quality').onchange=e=>viewer.configure('quality',e.target.value);
  on('resetView',()=>{viewer.renderer?.resetCamera();viewer.schedule(true);});
  on('yawZero',()=>viewer.yawZero());
  on('reloadModel',()=>viewer.load());
  function renderCloud(s=cloud.state()) {
    const select=$('cloudDevice'),selected=select.value||s.selectedId;
    const signature=JSON.stringify(s.devices.map(d=>[d.id,!!d.online]));
    if(select.dataset.devices!==signature){
      select.replaceChildren();
      if(!s.devices.length)select.add(new Option(s.authenticated?'等待单片机上线':'请先登录云端',''));
      for(const device of s.devices)select.add(new Option(device.id+' · '+(device.online?'在线':'离线'),device.id));
      if(s.devices.some(d=>d.id===selected))select.value=selected;
      select.dataset.devices=signature;
    }
    select.disabled=!s.enabled||!s.authenticated||s.streaming;
    $('cloudRefresh').disabled=!s.enabled||!s.authenticated;
    const accountMode=!!window.BoatAuth&&window.BoatAuth.enabled!==false;
    $('cloudLoginOpen').hidden=accountMode||!s.requiresLogin||s.authenticated||!s.enabled;
    $('cloudLogout').hidden=accountMode||!s.requiresLogin||!s.authenticated;
    set('cloudStatus',s.message);
    renderSourceAccess();
    if(link.source==='cloud'){
      set('connectionText',s.message);updateConnectionButtons();
      $('connectButton').disabled=$('connectButton').disabled||!s.enabled||!s.authenticated||!select.value;
    }
  }
  cloud.addEventListener('cloudstate',({detail})=>renderCloud(detail));
  cloud.addEventListener('authrequired',()=>{if(link.source==='cloud')set('cloudStatus',window.BoatAuth?.enabled===true?'请使用平台账户重新登录':'请输入访问密码登录云端');});
  function renderSourceAccess(){
    const remote=link.source==='cloud',guest=window.BoatAuth?.user?.role==='guest';
    set('sourceHint',guest?'访客账户仅可查看遥测、地图和轨迹；设备调参需要管理员账户。':remote?cloud.readOnly?cloud.parameterReadOnlyReason:'云端调参已就绪：管理员可读取、写入参数，调试完成后手动保存到 Flash。':'蓝牙可查看遥测并调整参数；云端调参需管理员账户和支持该功能的固件。');
    $('cloudReadOnlyNotice').hidden=!remote;
    if(remote){
      set('sourceDescription',cloud.readOnly?'云端 MQTT · 只读监测':'云端 MQTT · 可远程调参');
      set('cloudReadOnlyNotice',cloud.readOnly?cloud.parameterReadOnlyReason+'；已保留的本地草稿仍可保存预设或导出。':'当前通过云端操作设备参数，成功提示以 STM32 响应为准。超时或断连后，写入可能已经生效，请先读取确认再重试。Flash 保存仍需满足停机保护。');
    }
  }
  link.addEventListener('permissionchange',({detail})=>{detail.capabilityOnly?params.updateButtons():params.reset(true);updateConnectionButtons();renderCloud();renderSourceAccess();render();});
  $('telemetrySource').onchange=()=>{
    const source=$('telemetrySource').value;link.select(source);
    const remote=source==='cloud';$('cloudControls').hidden=!remote;$('cloudReadOnlyNotice').hidden=!remote;
    set('sourceChip',remote?'MQTT':'T10');set('sourceDescription',remote?'云端 MQTT · 只读监测':'本地蓝牙 · 单船监测');
    updateMapLabels();
    set('sourceSideNote',remote?'MQTT 云端监测 · 网口上云':'本地蓝牙直连 · T10 / 无人船电控');
    $('connectButton').textContent=remote?'连接云端无人船':'选择蓝牙设备';
    $('connectionRoute').textContent=remote?'无人船 → 网口 → MQTT Broker → 服务器 → 浏览器':'浏览器 ↔ T10 ↔ 无人船';
    renderSourceAccess();
    if(remote&&cloud.authenticated)cloud.refreshDevices().catch(error=>toast(error.message));
    renderCloud();render();
  };
  $('cloudDevice').onchange=()=>{if(link.source==='cloud'){link.disconnect();track.clear();state.deviceId=null;renderCloud();render();}};
  on('cloudRefresh',()=>cloud.refreshDevices());
  on('cloudLoginOpen',()=>{$('cloudLoginError').textContent='';$('cloudPassword').value='';$('cloudLoginDialog').showModal();$('cloudPassword').focus();});
  on('cloudLoginClose',()=>$('cloudLoginDialog').close());
  $('cloudLoginDialog').addEventListener('close',()=>{$('cloudPassword').value='';});
  $('cloudLoginForm').onsubmit=async event=>{
    event.preventDefault();$('cloudLoginSubmit').disabled=true;$('cloudLoginError').textContent='';
    const password=$('cloudPassword').value;$('cloudPassword').value='';
    try{await cloud.login(password);$('cloudLoginDialog').close();toast('云端登录成功');}
    catch(error){$('cloudLoginError').textContent=error.message;}
    finally{$('cloudLoginSubmit').disabled=false;}
  };
  on('cloudLogout',()=>cloud.logout());
  cloud.initialize().catch(()=>{cloud.message='无法读取云端配置，请检查服务器连接';renderCloud();});
  set('supportNotice',!window.isSecureContext?'当前不是安全地址：蓝牙需 HTTPS 或 localhost':!navigator.bluetooth?'此浏览器不支持 Web Bluetooth。建议使用支持蓝牙的桌面 Chrome/Edge 或 Android Chrome。':'蓝牙直接连接当前电脑/手机；地图底图需要联网。');
  readChartPalette();setupMap();mapVectors=new MapVelocityView(map);render();
  const timer=setInterval(render,200);
  const cloudTimer=setInterval(()=>{if(link.source==='cloud'&&cloud.enabled&&cloud.authenticated&&!document.hidden)cloud.refreshDevices().catch(()=>{});},10000);
  document.addEventListener('visibilitychange',()=>{
    if(link.source==='cloud'){
      if(document.hidden)cloud.suspend();else cloud.resume();
    }
    if(!document.hidden)render();
  });
  window.addEventListener('pagehide',()=>{clearInterval(timer);clearInterval(cloudTimer);viewer.stop();mapSettings.destroy();link.disconnect();});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  window.addEventListener('resize',()=>render());
  window.addEventListener('boat-theme-change',()=>{readChartPalette();map?.setTheme(document.documentElement.dataset.theme);render();});
  // 提供浏览器控制台诊断入口，界面不显示原始字节流。
  window.boatMonitor={link,params,viewer,horizon,track,map,mapVectors,mapSettings};
})();
