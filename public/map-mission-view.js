/* 当前任务路线仅作为地图覆盖物：复用任务轮询，不发送任何控制指令。 */
class MapMissionView {
  constructor(map) {
    this.map = map;
    this.markers = [];
    this.visible = true;
    try { this.visible = localStorage.getItem('boat_web_mission_route_v1') !== 'hidden'; } catch (_) {}
    this.button = document.getElementById('mapMissionToggle');
    this.info = document.getElementById('mapMissionInfo');
    this.status = document.getElementById('mapMissionStatus');
    this.toggle = () => {
      this.visible = !this.visible;
      try { localStorage.setItem('boat_web_mission_route_v1', this.visible ? 'visible' : 'hidden'); } catch (_) {}
      this.render();
    };
    this.button.addEventListener('click', this.toggle);
    this.update = event => { this.state = event.detail; this.render(); };
    this.restore = () => { this.drawKey = null; this.render(); };
    window.addEventListener('boat-mission-change', this.update);
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

  render() {
    const state = this.state || {}, allowed = state.allowed === true && !!state.deviceId;
    const run = state.run?.active && state.run.deviceId === state.deviceId ? state.run : null;
    const route = run && state.route?.id === run.routeId ? state.route : null;
    const points = route?.points || [];
    const valid = points.length >= 2 && points.length <= 256 && points.every(p =>
      Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 85 && Math.abs(p.longitude) <= 180);
    const show = allowed && this.visible && !!run && valid && !state.stale;
    this.button.hidden = this.info.hidden = !allowed;
    this.button.textContent = this.visible ? '任务路线：显示' : '任务路线：隐藏';
    this.button.setAttribute('aria-pressed', String(this.visible));
    this.info.dataset.visible = String(show);
    const phase = { preparing: '读取参数', acquiring: '等待接管', stopping: '正在停止' }[run?.status] ||
      (run?.action === 'goto' ? '前往起点' : run?.phase === 'returning' ? '返回起点' : '沿线航行');
    const text = !allowed ? '' : state.stale ? '任务状态同步中断，恢复后更新路线' : !run ? '当前无人船暂无执行中任务' :
      !valid ? '正在同步当前任务路线…' : (run.routeName || route.name || '当前任务') + ' · ' + phase +
      (run.loopEnabled ? ' · 第 ' + run.currentLoop + ' / ' + run.loopCount + ' 圈' : '') +
      ' · ' + (this.visible ? '蓝色虚线为任务路线，橙色为循环返回线' : '路线已隐藏，任务继续执行');
    if (this.status.textContent !== text) this.status.textContent = text;
    // 只在航线/当前航点变化时重绘，避免每次状态轮询重建全部地图对象。
    const current = run?.status === 'running' && !state.stale ? run.targetIndex : -1;
    const returning = run?.action === 'start' && route?.loopEnabled === true;
    const key = JSON.stringify([show, state.deviceId, run?.runId, points, current, returning, this.map.provider]);
    if (key === this.drawKey) return;
    this.drawKey = key;
    this.clear();
    if (!show) return;
    const lines = [{ points, color: '#467dff', width: 3, dashed: true, behind: true, className: 'map-mission-line' }];
    if (returning) lines.push({ points: [points.at(-1), points[0]], color: '#d5952b', width: 3,
      dashed: true, behind: true, className: 'map-mission-line map-mission-return' });
    this.map.setOverlayLines('mission', lines);
    if (!this.map.ready) return;
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
    this.button.removeEventListener('click', this.toggle);
    this.map.off('ready', this.restore);
    this.map.off('providerchange', this.restore);
    this.clear();
  }
}
window.MapMissionView = MapMissionView;
