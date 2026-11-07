/* 当前任务及驾驶选择预览只作为地图覆盖物，复用任务轮询，不发送控制指令。 */
class MapMissionView {
  constructor(map) {
    this.map = map;
    this.markers = [];
    this.visible = true;
    this.pointsVisible = true;
    try { this.visible = localStorage.getItem('boat_web_mission_route_v1') !== 'hidden'; } catch (_) {}
    try { this.pointsVisible = localStorage.getItem('boat_web_mission_waypoints_v1') !== 'hidden'; } catch (_) {}
    this.button = document.getElementById('mapMissionToggle');
    this.pointButtons = ['mapMissionPointsToggle', 'driverMissionPointsToggle'].map(id => document.getElementById(id)).filter(Boolean);
    this.info = document.getElementById('mapMissionInfo');
    this.status = document.getElementById('mapMissionStatus');
    this.toggle = () => {
      this.visible = !this.visible;
      try { localStorage.setItem('boat_web_mission_route_v1', this.visible ? 'visible' : 'hidden'); } catch (_) {}
      this.render();
    };
    this.button.addEventListener('click', this.toggle);
    this.togglePoints = () => {
      this.pointsVisible = !this.pointsVisible;
      try { localStorage.setItem('boat_web_mission_waypoints_v1', this.pointsVisible ? 'visible' : 'hidden'); } catch (_) {}
      this.render();
    };
    for (const button of this.pointButtons) button.addEventListener('click', this.togglePoints);
    this.update = event => { this.state = event.detail; this.render(); };
    this.restore = () => { this.drawKey = null; this.render(); };
    this.viewChange = () => this.render();
    window.addEventListener('boat-mission-change', this.update);
    window.addEventListener('boat-view-change', this.viewChange);
    this.map.on('ready', this.restore);
    this.map.on('providerchange', this.restore);
    this.state = window.BoatMissions?.navigationState();
    this.render();
  }

  clear() {
    for (const marker of this.markers) marker.remove();
    this.markers = [];
    this.map.setOverlayLines('mission', []);
  }

  setDriverPreview(preview) {
    this.driverPreview = preview;
    this.render();
  }

  validRoute(route, minimum = 2) {
    return Array.isArray(route?.points) && route.points.length >= minimum && route.points.length <= 256 && route.points.every(p =>
      p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 85 && Math.abs(p.longitude) <= 180);
  }

  renderPreview(preview, state) {
    // 驾驶选择预览始终只画线，不覆盖监测页保存的路线 / 航点显隐偏好。
    const queue = preview.queue, routes = queue ? queue.routes || [] : preview.route ? [preview.route] : [];
    const valid = routes.length > 0 && routes.length <= 32 && routes.every(route => this.validRoute(route));
    const stale = state.stale || preview.stale, show = valid && !stale;
    const key = JSON.stringify(['driver-preview', state.deviceId, show, routes, queue?.loopEnabled, this.map.provider, this.map.ready]);
    const invalidCurve = this.previewErrorKey === key;
    this.button.hidden = true; this.info.hidden = false;
    for (const button of this.pointButtons) button.hidden = true;
    this.info.dataset.visible = String(show && !invalidCurve);
    this.status.textContent = stale ? '任务同步中断，恢复后更新所选轨迹' : !routes.length ? '请选择已保存的航线或任务组以预览轨迹' :
      !valid ? '所选任务轨迹无效，请重新读取任务' : invalidCurve ? '所选任务曲线无效，请重新读取任务' :
      (queue?.name || preview.route.name || '所选任务') + ' · 轨迹预览 · 航点已隐藏';
    if (key === this.drawKey) return;
    this.drawKey = key; this.clear();
    if (!show) return;
    const lines = [], paths = window.BoatModules.missionPath;
    try {
      routes.forEach((route, index) => {
        const color = queue ? paths.routeColor(index) : '#467dff';
        lines.push(...paths.routeLines(route, { color, width: 3, behind: true, className: 'map-mission-line', routeIndex: index }));
        if (route.loopEnabled) lines.push({ points: [route.points.at(-1), route.points[0]], color: queue ? color : '#d5952b',
          width: 2, dashed: true, behind: true, className: 'map-mission-line map-mission-return' });
        const next = routes[index + 1] || (queue?.loopEnabled ? routes[0] : null);
        if (next) lines.push({ points: [route.loopEnabled ? route.points[0] : route.points.at(-1), next.points[0]],
          color: '#929cab', width: 2, dashed: true, behind: true, className: 'map-mission-line map-mission-transfer' });
      });
    } catch (_) { this.previewErrorKey = key; this.info.dataset.visible = 'false'; this.status.textContent = '所选任务曲线无效，请重新读取任务'; return; }
    this.map.setOverlayLines('mission', lines);
  }

  render() {
    const state = this.state || {}, allowed = state.allowed === true && !!state.deviceId;
    const preview = window.BoatWorkspace?.current === 'driving' && allowed && this.driverPreview?.deviceId === state.deviceId ? this.driverPreview : null;
    if (preview) { this.renderPreview(preview, state); return; }
    const run = (state.run?.active || state.run?.status === 'paused') && state.run.deviceId === state.deviceId ? state.run : null;
    const route = run && state.route?.id === run.routeId ? state.route : null;
    const points = route?.points || [];
    const valid = this.validRoute(route, ['hold','home'].includes(run?.action) ? 1 : 2);
    const show = allowed && this.visible && !!run && valid && !state.stale;
    this.button.hidden = this.info.hidden = !allowed;
    this.button.textContent = this.visible ? '任务路线：显示' : '任务路线：隐藏';
    this.button.setAttribute('aria-pressed', String(this.visible));
    for (const button of this.pointButtons) {
      button.hidden = !allowed;
      button.textContent = this.pointsVisible ? '隐藏任务航点' : '显示任务航点';
      button.setAttribute('aria-pressed', String(this.pointsVisible));
    }
    this.info.dataset.visible = String(show);
    const phase = { preparing: '读取参数', acquiring: '等待接管', stopping: '正在停止', paused:'已暂停' }[run?.status] ||
      ({goto:'前往起点',home:'返回返航点',hold:'定点保持'}[run?.action] || ({returning:'返回起点',transit:'前往下一航线',queueReturning:'队列返回起点'}[run?.phase] || '沿线航行'));
    const text = !allowed ? '' : state.stale ? '任务状态同步中断，恢复后更新路线' : !run ? '当前无人船暂无执行中任务' :
      !valid ? '正在同步当前任务路线…' : (run.queue ? run.queue.name+' · 航线 '+(run.queue.routeIndex+1)+' / '+run.queue.routeCount+(run.action==='start'?' · 第 '+run.queue.currentLoop+' / '+run.queue.loopCount+' 轮':'')+' · ' : '') + (run.routeName || route.name || '当前任务') + ' · ' + phase +
      (run.loopEnabled ? ' · 第 ' + run.currentLoop + ' / ' + run.loopCount + ' 圈' : '') +
      ' · ' + (this.visible ? '蓝色实线为可记录航段，虚线不记录；橙色为返回 / 转场线' + (this.pointsVisible ? '' : '；航点已隐藏') : '路线已隐藏，任务继续执行');
    if (this.status.textContent !== text) this.status.textContent = text;
    // 只在航线/当前航点变化时重绘，避免每次状态轮询重建全部地图对象。
    const current = run?.status === 'running' && !state.stale ? run.targetIndex : -1;
    const returning = run?.action === 'start' && route?.loopEnabled === true;
    const transfer = ['transit','queueReturning'].includes(run?.phase) && run.transitionFrom;
    const key = JSON.stringify([show, this.pointsVisible, state.deviceId, run?.runId, points, route?.segments, current, returning, transfer, this.map.provider]);
    if (key === this.drawKey) return;
    this.drawKey = key;
    this.clear();
    if (!show) return;
    let lines;
    try { lines=window.BoatModules.missionPath.routeLines(route,{color:'#467dff',width:3,behind:true,className:'map-mission-line'}); }
    catch (_) { this.status.textContent='当前任务曲线无效，请刷新任务状态'; return; }
    if (returning) lines.push({ points: [points.at(-1), points[0]], color: '#d5952b', width: 3,
      dashed: true, behind: true, className: 'map-mission-line map-mission-return' });
    if (transfer && Number.isFinite(transfer.latitude) && Number.isFinite(transfer.longitude)) lines.push({points:[transfer,points[0]],color:'#d5952b',width:3,dashed:true,behind:true,className:'map-mission-line map-mission-transfer'});
    this.map.setOverlayLines('mission', lines);
    if (!this.map.ready || !this.pointsVisible) return;
    points.forEach((point, index) => {
      const kind = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'via';
      const title = (kind === 'start' ? '任务起点' : kind === 'end' ? '任务终点' : '任务航点') + ' ' + (index + 1);
      const marker = this.map.createMarker(point, { className: 'map-mission-pin',
        html: '<span data-kind="' + kind + '" data-current="' + (index === current) + '">' + (index + 1) + '</span>',
        iconSize: [26, 26], iconAnchor: [13, 13], interactive: false, keyboard: false, zIndexOffset: -100, title });
      if (marker) this.markers.push(marker);
    });
  }

  destroy() {
    window.removeEventListener('boat-mission-change', this.update);
    window.removeEventListener('boat-view-change', this.viewChange);
    this.button.removeEventListener('click', this.toggle);
    for (const button of this.pointButtons) button.removeEventListener('click', this.togglePoints);
    this.map.off('ready', this.restore);
    this.map.off('providerchange', this.restore);
    this.clear();
  }
}
window.MapMissionView = MapMissionView;
