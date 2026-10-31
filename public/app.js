/* 监控页面只在固定频率更新文本；姿态直接接收 IMU，参数界面独立维护。 */
(() => {
  'use strict';
  const M=BoatModules, $=id=>document.getElementById(id);
  const link=new CloudBoatLink(),cloud=link;
  let toastTimer;
  function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
  const params=new ParameterPanel(link,toast), viewer=new AttitudeView($('boatCanvas'));
  const horizon=new BoatArtificialHorizon($('imuHorizon'));
  const compass=new BoatCompassView($('boatCompass'));
  const mapSettings=new BoatMapSettingsPanel();
  const users=new BoatUserManagementPanel({toast});
  const mqttDevices=new BoatMqttDeviceSettingsPanel();
  const videoDevices=new BoatVideoDeviceSettingsPanel();
  const videoView=new BoatVideoView();
  const videoRecording=new BoatVideoRecordingPanel();
  const firmware=new BoatFirmwarePanel();
  const driver=new BoatDriverControl({toast});
  const fleet=new BoatFleetLink(cloud);
  const fleetView=new BoatFleetView({onSelect:id=>selectBoat(id),onConfigure:id=>openBoatSettings(id).catch(error=>toast(error.message)),onVideo:id=>openBoatVideo(id).catch(error=>toast(error.message)),onFirmware:id=>{if(driver.active||driver.pending)return toast('请先停船并退出电脑操控');firmware.open(id);}});
  const fleetMapView=new BoatFleetMapView({onSelect:id=>selectBoat(id)});
  let parameterDeviceId='',parameterOpenSequence=0,videoOpenSequence=0;
  const wgs=(latitude,longitude)=>Number.isFinite(latitude)&&Number.isFinite(longitude)&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180?{latitude,longitude}:null;
  const track=new M.boatTrack.BoatTrack(wgs);
  const state={latest:{},history:[],chartMode:'speed',lastReceived:null,lastUpdateAt:null,forwardDelayMs:null,
    uplinkDelayMs:null,uplinkRttMs:null,uplinkUncertaintyMs:null,deviceId:null,
    historical:null,historyEnd:null,historyMessage:'选择无人船后自动载入记录',trackDisplayEnabled:true,liveTrackPoints:[]};
  let map,marker,mapVectors,mapMission,trackRevision=-1,lastLocation,hadFix=false,viewResizeFrame;
  let autoSelectInFlight=null,autoSelectionSuppressed=false,historyRequest=0,historyController=null;
  let chartPalette;
  let compassVisible=true;
  try{compassVisible=localStorage.getItem('boat_compass_visible')!=='0';}catch(_){/* 禁用本地存储时仍可切换罗盘。 */}
  const set=(id,value)=>{const text=value==null?'--':String(value);if($(id).textContent!==text)$(id).textContent=text;};
  function setCompassVisibility(visible,persist=false) {
    compassVisible=visible;
    $('compassCard').hidden=!visible;
    $('sensorAttitudeLayout').classList.toggle('compass-hidden',!visible);
    $('compassToggle').setAttribute('aria-pressed',String(visible));
    set('compassToggle',visible?'隐藏罗盘':'显示罗盘');
    if(persist)try{localStorage.setItem('boat_compass_visible',visible?'1':'0');}catch(_){}
  }
  function renderCompass(now) {
    if(!compassVisible)return;
    const x=state.latest;
    // 绝对船头方向与对地航迹角独立；未定位仍可展示有效航向，断流不伪装成正北。
    compass.setTelemetry(M.compassDisplay.prepareCompassDisplay(x.boat?.frame,x.boat?.at||0,x.velocity?.frame,x.velocity?.at||0,now,link.connected));
  }
  setCompassVisibility(compassVisible);
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
  function renderChartSummary(now) {
    const b=state.latest.boat,heading=state.chartMode==='heading';
    const live=M.boatChart.createBoatChartSample(b?.frame,b?.at||0,now,link.connected);
    const summary=M.boatChart.prepareBoatChartSummary(link.connected?live:state.history.at(-1),state.chartMode);
    const unit=heading?'°':' m/s';
    set('chartTarget',summary.target==='--'?'--':summary.target+unit);
    set('chartActual',summary.actual==='--'?'--':summary.actual+unit);
    set('chartError',summary.error==='--'?'--':summary.error+unit);
    set('chartSummary','目标 '+summary.target+unit+' · 实际 '+summary.actual+unit+' · 误差 '+summary.error+unit+(heading?'（目标−实际，取最短角差）':'（实际−目标）'));
  }
  function drawChart(now) {
    // 隐藏页面仍接收数据和更新读数，只跳过没有尺寸的 Canvas 绘制。
    renderChartSummary(now);
    const canvas=$('chart'),ctx=canvas.getContext('2d'),width=canvas.clientWidth,height=canvas.clientHeight;
    if(!width)return;
    const ratio=Math.min(devicePixelRatio||1,2),pw=Math.round(width*ratio),ph=Math.round(height*ratio);
    if(canvas.width!==pw)canvas.width=pw;if(canvas.height!==ph)canvas.height=ph;
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle=chartPalette.background;ctx.fillRect(0,0,width,height);
    const chart=M.boatChart.prepareBoatChart(state.history,state.chartMode),heading=state.chartMode==='heading';
    const reference=link.connected?now:Number.isFinite(state.historyEnd)?state.historyEnd:now;
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
        const x=left+(point.timestamp-(reference-12000))/12000*w,y=top+h-(point[key]-chart.minValue)/span*h;
        if(x<left){previous=null;continue;}
        if(!previous||point.timestamp<previous.timestamp||point.timestamp-previous.timestamp>=Math.min(previous.gapMs,point.gapMs))ctx.moveTo(x,y);else ctx.lineTo(x,y);
        previous=point;
      }ctx.stroke();
    }
    if(!chart.hasValues){ctx.fillStyle=chartPalette.text;ctx.textAlign='center';ctx.fillText('等待有效'+(heading?'航向闭环':'船速闭环')+'数据',width/2,height/2);}
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
    const mapResize=new ResizeObserver(()=>{if($('map').clientWidth&&$('map').clientHeight)map.invalidateSize();});
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
    set('mapLayerName',map?.providerLabel||'地图加载中');
    set('mapCoordinateSystem',amap?'GCJ-02':'WGS84');
    const button=$('mapProviderToggle');
    const nextOsm=amap||!map?.ready;
    const satellite=map?.mode==='satellite';
    button.disabled=!map||map.switching;
    button.setAttribute('aria-busy',String(!!map?.switching));
    set('mapProviderToggle',map?.switching?'正在切换…':satellite?'切换至平面':nextOsm?'切换至 OSM':'切换至高德');
    button.title=satellite?'恢复此前使用的平面地图':nextOsm?'切换为 OpenStreetMap，保留轨迹和船位':'切换为高德平面地图；卫星视角及来源可在地图内选择';
    set('heroSourceLabel','MQTT 云端监测 / '+(map?.providerLabel||'地图加载中'));
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
    set('trackStatus',(track.active?(fresh?'更新本页轨迹':'显示云端历史'):'本页轨迹已暂停')+' · '+track.pointCount+'点'+(track.truncated?' · 已裁剪最早轨迹':''));
    $('trackStart').textContent=track.active?'停止追踪':'开始追踪';
  }
  function renderDeviceSummary(stats) {
    // MQTT 接入名就是遥测主题中的设备 ID；离线时仍显示当前选中的船。
    const selectedId=cloud.authenticated?cloud.selectedId||$('cloudDevice').value:'';
    const name=selectedId||'未选择无人船';
    const sameDevice=!!selectedId&&state.deviceId==='cloud:'+selectedId;
    const waiting=!link.connected&&(cloud.wanted||cloud.busy);
    const status=link.connected?'online':waiting?'waiting':'offline';
    $('deviceSummary').dataset.state=status;
    set('deviceName',name);
    $('deviceName').title=selectedId?'MQTT 设备 ID：'+selectedId:name;
    set('deviceConnectionState',link.connected?'已连接':waiting?'等待遥测':'未连接');
    set('frameCount',new Intl.NumberFormat('zh-CN').format(sameDevice?stats.framesReceived:0));
    const updated=sameDevice&&Number.isFinite(state.lastUpdateAt)?new Date(state.lastUpdateAt):null;
    set('deviceLastUpdate',updated?updated.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'--');
    if(updated)$('deviceLastUpdate').dateTime=updated.toISOString();else $('deviceLastUpdate').removeAttribute('datetime');
    const forward=link.connected&&sameDevice&&Number.isFinite(state.forwardDelayMs)?state.forwardDelayMs:null;
    const uplink=link.connected&&sameDevice&&Number.isFinite(state.uplinkDelayMs)?state.uplinkDelayMs:null;
    const total=forward!==null&&uplink!==null?forward+uplink:null;
    const delayText=value=>value===null?'--':Math.round(value)+' ms';
    set('deviceLatency',delayText(forward));
    set('deviceUplinkLatency',delayText(uplink));
    set('deviceTotalLatency',delayText(total));
    set('diagnosticForwardLatency',delayText(forward));
    set('diagnosticUplinkLatency',delayText(uplink));
    set('diagnosticTotalLatency',delayText(total));
    const uplinkTitle=uplink===null?'船端上报且完成校时后显示；旧固件、断线或校时失效时未知。':
      '估计 STM32 发出遥测至服务器收到的耗时，不含传感器采样。'+
      (Number.isFinite(state.uplinkRttMs)?'校时网络往返 '+Math.round(state.uplinkRttMs)+' ms。':'')+
      (Number.isFinite(state.uplinkUncertaintyMs)?'上行估计误差约 ±'+Math.ceil(state.uplinkUncertaintyMs)+' ms。':'');
    $('deviceUplinkLatency').title=uplinkTitle;$('diagnosticUplinkLatency').title=uplinkTitle;
  }
  function render() {
    if(document.hidden)return;
    driver.update({deviceId:cloud.authenticated?cloud.selectedId:'',connected:link.connected,authenticated:cloud.authenticated,
      parameterBusy:params.busy||!!link.pending||firmware.busy});
    syncParameterAccess();
    const fleetPage=window.BoatWorkspace?.current==='fleet',fleetState=fleet.state();
    const badgeOnline=fleetPage?fleetState.streamConnected&&fleetState.brokerConnected:link.connected;
    set('connectionBadge',fleetPage?(badgeOnline?'船队在线':cloud.authenticated?'船队连接中':'未登录'):(link.connected?'已连接':'未连接'));
    $('connectionBadge').className='badge '+(badgeOnline?'online':'offline');
    const now=performance.now(),x=state.latest;
    const b=M.boatDisplay.prepareBoatDisplay(x.boat?.frame,x.boat?.at||0,now,link.connected);
    const driverHeading=M.compassDisplay.prepareCompassDisplay(x.boat?.frame,x.boat?.at||0,x.velocity?.frame,x.velocity?.at||0,now,link.connected).headingDegrees;
    for(const [id,key] of Object.entries({boatStatus:'status',boatActual:'actual',boatTarget:'target',boatRequested:'requested',boatDirection:'direction',boatMode:'modeText',boatHeading:'actualHeading',boatTargetHeading:'targetHeading',boatHeadingError:'headingError',boatCommon:'common',boatTurn:'turn'}))set(id,b[key]);
    $('boatMeter').style.width=(Number.isFinite(Number(b.common))?Math.min(100,Math.abs(Number(b.common))):0)+'%';
    const v=M.velocityDisplay.prepareVelocityDisplay(x.velocity?.frame,x.velocity?.at||0,now,link.connected);
    for(const [id,key] of Object.entries({velocityStatus:'status',velocityPlanar:'planar',sensorPlanar:'planar',velocityX:'x',velocityY:'y',latitude:'latitude',longitude:'longitude',rtkHeading:'heading',velocityAge:'ageText',velocitySequence:'sequence',rtkAlignment:'alignmentText',fixStatus:'fixStatus'}))set(id,v[key]);
    $('sensorFixState').dataset.valid=String(v.fixFresh);
    set('mapCoordinate',v.fixFresh?v.latitude+', '+v.longitude:'--（无有效定位）');
    if(!v.fixFresh){track.breakSegment();marker?.setOpacity(.3);}
    updateMapAvailability(v.fixFresh);
    renderTrack(v.fixFresh);
    mapVectors.render(M.mapVelocity.prepareMapVelocity(x.boat?.frame,x.boat?.at||0,x.velocity?.frame,x.velocity?.at||0,now,link.connected));
    renderCompass(now);
    const imu=M.imuDisplay.prepareImuDisplay(x.imu?.frame,x.imu?.at||0,now,link.connected);
    // 驾驶左上读数与原监测卡共用有效期判断，断流后一起清空，避免显示旧定位。
    driver.setTelemetry({...b,actualHeading:Number.isFinite(driverHeading)?driverHeading.toFixed(2):'--',
      latitude:v.latitude,longitude:v.longitude,fixStatus:v.fixStatus,fixValid:v.fixFresh,imuStatus:imu.status,imuValid:imu.fresh});
    for(const key of ['roll','pitch','yaw','gyroX','gyroY','gyroZ'])set(key,imu[key]);
    for(const [id,key] of Object.entries({imuStatus:'status',imuSequence:'sequence',imuAge:'ageText',imuAlignment:'alignmentText',imuHeadingUpdate:'headingUpdateText'}))set(id,imu[key]);
    // 角速度与欧拉角独立有效，部分数据可用时以黄色提示。
    $('sensorImuState').dataset.valid=String(imu.fresh);
    $('sensorImuState').dataset.partial=String(imu.sourceFresh&&!imu.fresh&&(imu.gyroFresh||imu.eulerFresh));
    viewer.setTelemetry(imu);
    horizon.setTelemetry(imu);
    renderMotor(x.status?.frame,x.status?.at||0,now);
    const stats=link.parser.getStats();
    for(const [id,key] of Object.entries({parsedFrames:'framesReceived',crcErrors:'crcErrors',bufferedBytes:'bufferedBytes',bytesReceived:'bytesReceived'}))set(id,stats[key]);
    renderDeviceSummary(stats);
    set('linkAge',state.lastReceived==null?'--':Math.round(now-state.lastReceived)+' ms');
    const historyReference=link.connected?now:Number.isFinite(state.historyEnd)?state.historyEnd:now;
    state.history=state.history.filter(s=>historyReference-s.timestamp<=12000);
    renderHistoryStatus();
    drawChart(now);
  }
  link.addEventListener('frame',({detail:frame})=>{
    const now=performance.now(),at=Number.isFinite(frame.receivedAtMonotonic)?frame.receivedAtMonotonic:now;
    if(now-at>=1000)return;
    state.lastReceived=at;state.lastUpdateAt=Date.now();
    state.forwardDelayMs=Number.isFinite(frame.cloudForwardDelayMs)?frame.cloudForwardDelayMs:null;
    state.uplinkDelayMs=Number.isFinite(frame.cloudUplinkDelayMs)?frame.cloudUplinkDelayMs:null;
    state.uplinkRttMs=Number.isFinite(frame.cloudUplinkRttMs)?frame.cloudUplinkRttMs:null;
    state.uplinkUncertaintyMs=Number.isFinite(frame.cloudUplinkUncertaintyMs)?frame.cloudUplinkUncertaintyMs:null;
    if(frame.motors)state.latest.status={frame,at};
    if(frame.boat) {
      state.latest.boat={frame,at};
      state.history.push(M.boatChart.createBoatChartSample(frame,at,now,link.connected,state.history.at(-1)));
      if(state.history.length>240)state.history.shift();
      state.historyEnd=at;
    }
    if(frame.velocity){
      state.latest.velocity={frame,at};state.liveTrackPoints.push({velocity:frame.velocity,timestamp:at});
      if(state.liveTrackPoints.length>1000)state.liveTrackPoints.shift();position(frame,at,now);
    }
    if(frame.imu){
      state.latest.imu={frame,at};
      const imu=M.imuDisplay.prepareImuDisplay(frame,at,now,link.connected);
      viewer.setTelemetry(imu);horizon.setTelemetry(imu);
    }
  });
  function updateConnectionButtons() {
    const waiting=cloud.wanted;
    $('connectButton').disabled=link.connected||link.busy||waiting||!cloud.enabled||!cloud.authenticated||!$('cloudDevice').value||!!(window.BoatAuth&&!window.BoatAuth.canMonitor);
    $('disconnectButton').disabled=!link.connected&&!waiting&&!link.busy;
  }
  function clearLive() {
    state.latest={};state.lastReceived=null;state.forwardDelayMs=null;
    state.uplinkDelayMs=null;state.uplinkRttMs=null;state.uplinkUncertaintyMs=null;
    viewer.reset();horizon.reset();compass.reset();track.stop();track.breakSegment();
    marker?.remove();marker=null;lastLocation=null;hadFix=false;updateMapAvailability(false);
  }
  function cancelHistory(){++historyRequest;historyController?.abort();historyController=null;}
  function clearHistory(){cancelHistory();state.history=[];state.liveTrackPoints=[];state.historyEnd=null;state.historical=null;state.historyMessage='选择无人船后自动载入记录';}
  function renderHistoryStatus(){
    $('historyPanel').hidden=!cloud.authenticated||!cloud.selectedId;
    const item=state.historical,recording=item?.recording;
    set('historyRecordingState',recording?.storageError?'云端记录保存异常':recording?.persistent?(Number.isFinite(recording.lastSavedAt)?'服务器自动记录 · 已持久化':'服务器自动记录 · 等待首次落盘'):recording?'服务器自动记录 · 内存保存':'服务器持续采集');
    set('historyStatus',state.historyMessage);
    const date=Number.isFinite(item?.receivedAt)?new Date(item.receivedAt):null;
    set('historyLastTime',date?date.toLocaleString('zh-CN',{hour12:false}):'尚无记录');
    if(date)$('historyLastTime').dateTime=date.toISOString();else $('historyLastTime').removeAttribute('datetime');
    set('historyLastSpeed',Number.isFinite(item?.last?.speedMps)?item.last.speedMps.toFixed(3)+' m/s':'--');
    set('historyLastHeading',Number.isFinite(item?.last?.headingDegrees)?item.last.headingDegrees.toFixed(2)+'°':'--');
    set('historyLastPosition',item?.last?.fix?item.last.fix.latitude.toFixed(7)+', '+item.last.fix.longitude.toFixed(7):'--');
    const chartDate=state.history.length&&Number.isFinite(state.lastUpdateAt)?new Date(state.lastUpdateAt):date;
    set('chartHistoryState',link.connected?'实时曲线':chartDate?'最后记录 · '+chartDate.toLocaleString('zh-CN',{hour12:false}):'等待记录');
  }
  // 历史数据由服务器持续采集；打开页面或自动选船后先补齐最近记录，再由 SSE 继续接收实时帧。
  async function hydrateHistory(id,generation) {
    cancelHistory();const token=historyRequest,accountGeneration=window.BoatAuth?.generation;
    const controller=new AbortController();historyController=controller;
    const timer=setTimeout(()=>controller.abort(),8000);
    const current=()=>token===historyRequest&&generation===cloud.generation&&cloud.selectedId===id&&cloud.wanted&&cloud.authenticated&&!document.hidden&&accountGeneration===window.BoatAuth?.generation;
    state.historyMessage='正在读取服务器记录…';
    try {
      const result=await cloud.api('history?device='+encodeURIComponent(id)+'&limit=1000',{signal:controller.signal});
      if(!current())return;
      const history=M.boatHistory.prepareHistory(result,id,Date.now()+(cloud.serverOffset||0),performance.now());
      // 实时帧可能在历史请求期间到达；按时间合并，避免历史响应覆盖新数据。
      state.history=[...history.chart,...state.history].sort((a,b)=>a.timestamp-b.timestamp).slice(-1240);
      state.historyEnd=Math.max(state.historyEnd??-Infinity,history.end??-Infinity);
      state.historical=history;state.historyMessage=result.samples.length?'已载入 '+result.samples.length+' 条云端记录':'暂无历史记录，船上线后自动采集';
      const latest=history.latest;
      if(latest&&link.connected&&latest.ageMs<1000){
        const frame=latest.frame;
        for(const [field,present]of [['status',frame.motors],['boat',frame.boat],['velocity',frame.velocity],['imu',frame.imu]])
          if(present&&(!state.latest[field]||state.latest[field].at<latest.at))state.latest[field]={frame,at:latest.at};
      }
      if(state.trackDisplayEnabled){
        const last=history.points.at(-1)?.timestamp??-Infinity;
        track.restore([...history.points,...state.liveTrackPoints.filter(point=>point.timestamp>last)]);
      }
      const fix=history.last.fix;
      if(fix&&!link.connected){lastLocation=[fix.latitude,fix.longitude];if(map?.ready&&$('mapFollow').checked)map.setView(lastLocation,16,{animate:false});}
      trackRevision=-1;render();
    }catch(error){
      // 旧服务器没有历史接口时继续使用实时 SSE，不打断打开页面或自动选船。
      if(current()){state.historyMessage=error.status===404?'服务器尚未提供历史记录':'历史记录读取失败，可点击刷新重试';render();}
    }finally{clearTimeout(timer);if(historyController===controller)historyController=null;}
  }
  link.addEventListener('connection',({detail:c})=>{
    $('connectionBadge').textContent=c.connected?'已连接':'未连接';
    $('connectionBadge').className='badge '+(c.connected?'online':'offline');
    updateConnectionButtons();params.reset(true);clearLive();
    if(c.connected) {
      if(state.deviceId!==c.id){track.clear();state.lastUpdateAt=null;}
      state.deviceId=c.id;
      set('connectionText','云端实时遥测 · '+c.name+(window.BoatAuth?.user?.role==='guest'?' · 访客只读监测':link.readOnly?' · 当前设备只读':' · 管理员可远程调参'));
      if(state.trackDisplayEnabled)track.start();
    } else {
      set('connectionText',c.message||'已断开');
    }
    render();
  });
  function on(id,fn){$(id).onclick=()=>Promise.resolve().then(fn).catch(e=>toast(e.message));}
  $('connectButton').onclick=async()=>{
    $('connectButton').disabled=true;
    try{await link.connect($('cloudDevice').value);}catch(e){toast(e.message);}
    finally{updateConnectionButtons();}
  };
  on('disconnectButton',()=>{autoSelectionSuppressed=true;cancelHistory();link.disconnect();});
  on('chartModeButton',()=>{
    state.chartMode=state.chartMode==='speed'?'heading':'speed';
    set('chartTitle',state.chartMode==='speed'?'船速曲线':'航向角曲线');
    set('chartModeButton',state.chartMode==='speed'?'切换为航向角':'切换为速度');render();
  });
  on('chartClear',()=>{cancelHistory();state.history=[];state.historyEnd=null;render();});
  on('trackStart',()=>{state.trackDisplayEnabled=!track.active;track.active?track.stop():track.start();const x=state.latest.velocity;position(x?.frame,x?.at||0,performance.now());render();});
  on('trackClear',()=>{cancelHistory();state.liveTrackPoints=[];track.clear();render();});
  on('mapVectorsToggle',()=>mapVectors.toggle());
  on('compassToggle',()=>{setCompassVisibility(!compassVisible,true);renderCompass(performance.now());});
  on('mapProviderToggle',async()=>{
    const switched=await (map.mode==='satellite'?map.switchMode('planar'):map.switchProvider(map.provider==='amap'||!map.ready?'osm':'amap'));
    if(switched)toast('已切换至 '+map.providerLabel);
  });
  on('mapCenter',()=>{if(!map?.ready)toast('地图尚未就绪，请查看地图底部提示');else if(lastLocation)map.setView(lastLocation,16);else toast('尚无有效定位');});
  $('mapFollow').onchange=()=>{if($('mapFollow').checked&&lastLocation&&map?.ready)map.setView(lastLocation,16);};
  function parameterAccess() {
    return {canManage:!!window.BoatAuth?.canManage,canUpgradeFirmware:window.BoatAuth?.enabled===true&&window.BoatAuth?.ready===true&&window.BoatAuth?.user?.role==='admin',parameterBusy:params.busy||!!link.pending||driver.active||driver.pending};
  }
  function syncParameterAccess() {
    const access=parameterAccess(),selected=!!(cloud.authenticated&&cloud.selectedId);
    if(fleetView.state.canManage!==access.canManage||fleetView.state.canUpgradeFirmware!==access.canUpgradeFirmware||fleetView.state.parameterBusy!==access.parameterBusy)fleetView.update(access);
    const offline=!cloud.devices.some(device=>device.id===cloud.selectedId&&device.online);
    for(const id of ['settingsToggle','settingsEntry']){
      $(id).hidden=!access.canManage||!selected;
      $(id).disabled=access.parameterBusy||offline;
    }
    $('firmwareToggle').hidden=!access.canUpgradeFirmware||!selected;
    $('firmwareToggle').disabled=access.parameterBusy;
    document.querySelector('.settings-callout').hidden=!access.canManage||!selected;
  }
  async function openBoatSettings(id=cloud.selectedId) {
    window.BoatAuth?.assertManage();
    if(driver.active||driver.pending)throw Error('请先停船并退出电脑操控，再打开调参设置');
    if(!cloud.authenticated||!/^[A-Za-z0-9_-]{1,64}$/.test(id||''))throw Error('请从对应无人船卡片进入调参设置');
    if(params.busy||link.pending)throw Error('请等待当前无人船的参数操作完成，再打开调参设置');
    const request=++parameterOpenSequence,accountGeneration=window.BoatAuth?.generation;
    const selecting=selectBoat(id,false),generation=cloud.generation;
    const selected=await selecting;
    // 快速点击多张船卡、切船或登出后，迟到的打开流程不能改变当前调参对象。
    if(request!==parameterOpenSequence||!selected||generation!==cloud.generation||cloud.selectedId!==id||!cloud.wanted||accountGeneration!==window.BoatAuth?.generation)return;
    window.BoatAuth?.assertManage();
    renderCloud();
    $('settingsDialog').dataset.deviceId=id;
    if(!$('settingsDialog').open)$('settingsDialog').showModal();
  }
  const openSettings=()=>openBoatSettings();
  async function openBoatVideo(id) {
    if(!cloud.authenticated||!cloud.devices.some(device=>device.id===id))throw Error('请先登录并选择已接入的无人船');
    const request=++videoOpenSequence,accountGeneration=window.BoatAuth?.generation;
    const selecting=selectBoat(id,false),generation=cloud.generation;
    if(!await selecting||request!==videoOpenSequence||generation!==cloud.generation||cloud.selectedId!==id||!cloud.wanted||accountGeneration!==window.BoatAuth?.generation)return;
    window.BoatWorkspace?.navigate('video');
  }
  const openPlatformSettings=()=>{window.BoatAuth?.assertManage();$('platformSettingsDialog').showModal();users.open();mqttDevices.open();videoDevices.open();videoRecording.open();mapSettings.open();};
  on('settingsToggle',openSettings);
  on('firmwareToggle',()=>{if(driver.active||driver.pending)throw Error('请先停船并退出电脑操控');firmware.open(cloud.selectedId);});
  on('settingsEntry',openSettings);
  on('settingsClose',()=>$('settingsDialog').close());
  $('settingsDialog').addEventListener('close',()=>{if(!$('settingsDialog').open)delete $('settingsDialog').dataset.deviceId;});
  on('platformSettingsToggle',openPlatformSettings);
  on('sidebarPlatformSettings',openPlatformSettings);
  on('platformSettingsClose',()=>$('platformSettingsDialog').close());
  $('platformSettingsDialog').addEventListener('close',()=>{users.close();mqttDevices.close();videoDevices.close();videoRecording.close();mapSettings.close();});
  window.addEventListener('pagehide',()=>{users.destroy();mqttDevices.destroy();videoDevices.destroy();firmware.destroy();},{once:true});
  for(const [id,kind] of [['readParameters','read'],['writeParameters','write'],['saveFlash','flash']])on(id,async()=>{
    if(!$('settingsDialog').open||$('settingsDialog').dataset.deviceId!==cloud.selectedId)throw Error('调参对象已变化，请从对应无人船重新进入');
    try{await params.command(kind);}finally{syncParameterAccess();}
  });
  on('fillTuning',()=>params.tune());
  on('applyControlAlgorithm',async()=>{
    if(!$('settingsDialog').open||$('settingsDialog').dataset.deviceId!==cloud.selectedId)throw Error('调参对象已变化，请从对应无人船重新进入');
    try{await params.applyAlgorithm();}finally{syncParameterAccess();}
  });
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
    const select=$('cloudDevice'),selected=s.selectedId||select.value;
    const signature=JSON.stringify(s.devices.map(d=>[d.id,!!d.online]));
    if(select.dataset.devices!==signature){
      select.replaceChildren();
      if(!s.devices.length)select.add(new Option(s.authenticated?'等待单片机上线':'请先登录云端',''));
      for(const device of s.devices)select.add(new Option(device.id+' · '+(device.online?'在线':'离线'),device.id));
      if(selected&&!s.devices.some(d=>d.id===selected))select.add(new Option(selected+' · 等待上线',selected));
      select.dataset.devices=signature;
    }
    // 切船通常不会改变船队目录，选中项也必须随当前详情对象更新。
    if(selected&&!Array.from(select.options).some(option=>option.value===selected))select.add(new Option(selected+' · 等待上线',selected));
    if(selected)select.value=selected;
    // 船队连接与单船详情独立，详情接收中也可直接切船。
    select.disabled=!s.enabled||!s.authenticated;
    $('cloudRefresh').disabled=!s.enabled||!s.authenticated;
    const accountMode=!!window.BoatAuth&&window.BoatAuth.enabled!==false;
    $('cloudLoginOpen').hidden=accountMode||!s.requiresLogin||s.authenticated||!s.enabled;
    $('cloudLogout').hidden=accountMode||!s.requiresLogin||!s.authenticated;
    const statusMessage=s.authenticated&&!s.selectedId?(s.devices.length?'已发现 '+s.devices.length+' 艘无人船，船队总览持续更新；选择船舶查看详情':s.message):s.message;
    set('cloudStatus',statusMessage);
    renderSourceAccess();
    set('connectionText',statusMessage);updateConnectionButtons();
    renderDeviceSummary(link.parser.getStats());
    const target=s.authenticated?s.selectedId:'';
    videoView.update({deviceId:target,descriptor:s.devices.find(device=>device.id===target)?.video||null,
      authenticated:s.authenticated&&(!window.BoatAuth||window.BoatAuth.canMonitor),streaming:s.streaming,
      allowedOrigins:s.videoConfig?.allowedOrigins||[]});
    videoRecording.update({deviceId:target,authenticated:s.authenticated&&window.BoatAuth?.canMonitor});
    window.dispatchEvent(new CustomEvent('boat-selection-change',{detail:{selectedId:target}}));
    if(target!==parameterDeviceId){
      parameterDeviceId=target;params.reset(false);
      // 参数确认和表单草稿只属于当前船，切换时必须重新读取。
      $('settingsDialog').close();
    }
    set('parameterDeviceName',target||'尚未选择无人船');
    set('parameterDeviceNotice',target?'当前操作对象：'+target+'。参数和 Flash 命令只发给这艘船；切换后需要重新读取。':'请从对应无人船卡片的“调参设置”进入，再读取当前船的参数。');
    fleetView.update({...fleet.state(),...parameterAccess()});
    syncParameterAccess();
  }
  cloud.addEventListener('cloudstate',({detail})=>{
    if(!detail.authenticated){clearHistory();track.clear();autoSelectionSuppressed=false;}
    renderCloud(detail);
  });
  cloud.addEventListener('authrequired',()=>set('cloudStatus',window.BoatAuth?.enabled===true?'请使用平台账户重新登录':'请输入访问密码登录云端'));
  function renderSourceAccess(){
    const guest=window.BoatAuth?.user?.role==='guest';
    if(!cloud.selectedId){
      set('sourceHint',guest?'船队总览同时监测所有船舶；选择一艘查看详情。访客可监测，调参需要管理员。':'选择船卡查看单船详情，或点击该船的“调参设置”独立调参；平台设置管理用户、接入账号与地图。');
      set('sourceDescription','MQTT 云端 · 尚未选择详情船舶');
      set('cloudReadOnlyNotice','请先选择并连接需要调参的无人船，再读取当前船的参数。平台设置与船端调参分别管理。');
      return;
    }
    set('sourceHint',guest?'访客账户可查看遥测、地图、轨迹和船载视频；设备调参需要管理员账户。':cloud.readOnly?cloud.parameterReadOnlyReason:'云端调参已就绪：管理员可读取、写入参数，调试完成后手动保存到 Flash。');
    set('sourceDescription',cloud.readOnly?'MQTT 云端 · 只读监测':'MQTT 云端 · 可远程调参');
    set('cloudReadOnlyNotice',cloud.readOnly?cloud.parameterReadOnlyReason+'；已保留的本地草稿仍可保存预设或导出。':'当前通过云端操作设备参数，成功提示以 STM32 响应为准。超时或断连后，写入可能已经生效，请先读取确认再重试。Flash 保存仍需满足停机保护。');
  }
  link.addEventListener('permissionchange',({detail})=>{detail.capabilityOnly?params.updateButtons():params.reset(true);updateConnectionButtons();renderCloud();renderSourceAccess();render();});
  async function selectBoat(id,showDetails=true,automatic=false) {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(id||''))return false;
    if(!automatic)autoSelectionSuppressed=false;
    if(cloud.selectedId===id&&(cloud.wanted||cloud.connected)){
      if(showDetails)window.BoatWorkspace?.navigate('overview');return true;
    }
    driver.stop('正在切换无人船，已停止原船操控');
    // 先撤销旧船正在等待的命令，再建立新船的独立解析器。
    link.disconnect('正在切换无人船');clearHistory();params.reset(false);track.clear();state.deviceId='cloud:'+id;state.lastUpdateAt=null;
    if(showDetails)window.BoatWorkspace?.navigate('overview');
    const connecting=cloud.connect(id),generation=cloud.generation;
    try{await connecting;}catch(error){toast(error.message);return false;}
    renderCloud();render();
    const selected=generation===cloud.generation&&cloud.selectedId===id&&cloud.wanted;
    if(selected){if(state.trackDisplayEnabled)track.start();hydrateHistory(id,generation);}
    return selected;
  }
  $('cloudDevice').onchange=()=>{autoSelectionSuppressed=false;return selectBoat($('cloudDevice').value,false);};
  fleet.addEventListener('fleetstate',({detail})=>{
    fleetView.update({...detail,...parameterAccess()});
    fleetMapView.update(detail);
    // 总览已通过同一认证通道发现新船，设备下拉框同步而无需等待10秒轮询。
    if(detail.streamConnected&&cloud.authenticated){
      cloud.devices=detail.devices.map(device=>({id:device.id,online:device.online,parametersReady:device.parametersReady,video:device.video||null}));
      if(cloud.devices.some(device=>device.id===cloud.selectedId&&device.parametersReady))cloud.parameterCapableId=cloud.selectedId;
      renderCloud();
      // 首次打开页面时自动进入第一艘在线船的详情，不需要用户再点击“连接无人船”。
      const candidate=detail.devices.find(device=>device.online===true)||[...detail.devices].filter(device=>Number.isFinite(device.lastReceivedAt)).sort((a,b)=>b.lastReceivedAt-a.lastReceivedAt)[0];
      if(!autoSelectionSuppressed&&!cloud.selectedId&&candidate&&!autoSelectInFlight){
        const pending=selectBoat(candidate.id,false,true);autoSelectInFlight=pending;
        pending.finally(()=>{if(autoSelectInFlight===pending)autoSelectInFlight=null;});
      }
    }
  });
  on('cloudRefresh',async()=>{await cloud.refreshDevices();await fleet.refresh();if(cloud.selectedId&&cloud.wanted)hydrateHistory(cloud.selectedId,cloud.generation);});
  on('fleetRefresh',()=>fleet.refresh());
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
  set('supportNotice','无人船通过 MQTT 向服务器上报，浏览器通过同源 HTTP/SSE 接收实时数据。船→云延迟在船端校时完成后显示；合计为船→云估计值与云→网页转发耗时之和，不含传感器采样或画面绘制。旧固件或校时失效时显示 --。远程访问建议使用 HTTPS；地图底图需要联网。');
  readChartPalette();setupMap();mapVectors=new MapVelocityView(map);mapMission=new MapMissionView(map);render();
  function refreshWorkspace() {
    videoView.setVisible(['video','driving'].includes(window.BoatWorkspace?.current)&&!document.hidden);
    videoRecording.setVisible(window.BoatWorkspace?.current==='video'&&!document.hidden);
    // 切页保留连接与历史，待新容器布局完成后恢复地图、图表和三维画面。
    viewer.visible=false;viewer.stop();cancelAnimationFrame(viewResizeFrame);
    viewResizeFrame=requestAnimationFrame(()=>{
      if($('map').clientWidth&&$('map').clientHeight)map.invalidateSize();
      const rect=viewer.canvas.getBoundingClientRect();
      viewer.visible=!viewer.canvas.closest('details:not([open])')&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight;
      if(viewer.visible){viewer.resize();viewer.catchUp();viewer.schedule(true);}
      render();
    });
  }
  window.addEventListener('boat-view-change',refreshWorkspace);
  window.addEventListener('boat-driver-layout-change',refreshWorkspace);
  refreshWorkspace();
  const timer=setInterval(render,200);
  const cloudTimer=setInterval(()=>{if(cloud.enabled&&cloud.authenticated&&!document.hidden)cloud.refreshDevices().catch(()=>{});},10000);
  document.addEventListener('visibilitychange',()=>{
    videoView.setVisible(['video','driving'].includes(window.BoatWorkspace?.current)&&!document.hidden);
    videoRecording.setVisible(window.BoatWorkspace?.current==='video'&&!document.hidden);
    if(document.hidden){cancelHistory();cloud.suspend();}else{cloud.resume();if(cloud.selectedId&&cloud.wanted)hydrateHistory(cloud.selectedId,cloud.generation);}
    if(!document.hidden)render();
  });
  window.addEventListener('pagehide',()=>{driver.destroy();mapMission.destroy();cancelHistory();cancelAnimationFrame(viewResizeFrame);clearInterval(timer);clearInterval(cloudTimer);videoView.destroy();videoRecording.destroy();viewer.stop();compass.destroy?.();mapSettings.destroy();fleetMapView.destroy();fleet.destroy();fleetView.destroy();link.disconnect();});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  window.addEventListener('resize',()=>render());
  window.addEventListener('boat-theme-change',()=>{readChartPalette();map?.setTheme(document.documentElement.dataset.theme);fleetMapView.setTheme(document.documentElement.dataset.theme);render();});
  // 提供浏览器控制台诊断入口，界面不显示原始字节流。
  window.boatMonitor={link,params,viewer,horizon,compass,driver,track,map,mapVectors,mapMission,mapSettings,mqttDevices,fleet,fleetView,fleetMapView,videoView,videoRecording,selectBoat,openBoatSettings,openBoatVideo,
    historyState:()=>({deviceId:cloud.selectedId,recordedAt:state.historical?.receivedAt||null,points:track.pointCount,chartSamples:state.history.length,message:state.historyMessage})};
})();
