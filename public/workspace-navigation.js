/* 页面导航只切换可见工作区；移动已有面板，保留地图、轨迹和 WebGL 实例。 */
(() => {
  'use strict';
  const views = {
    fleet: { title:'船队总览', english:'FLEET OVERVIEW', description:'同时接收所有无人船状态，选择一艘查看详细监测与控制数据。' },
    overview: { title:'船况概览', english:'VESSEL OVERVIEW', description:'快速掌握船速、航向、定位与姿态，进入对应页面查看详情。' },
    navigation: { title:'船位与轨迹', english:'NAVIGATION & TRACK', description:'查看实时船位、速度方向与航行轨迹，独立调整地图视野。' },
    attitude: { title:'三维姿态', english:'VESSEL ATTITUDE', description:'观察三维船体姿态和 IMU / RTK 测量数据。' },
    analysis: { title:'控制曲线', english:'CONTROL ANALYSIS', description:'对比目标与实际船速、航向，辅助闭环调参。' },
    propulsion: { title:'推进系统', english:'PROPULSION SYSTEM', description:'监测双推进器转速、电压、电流和输出状态。' },
    diagnostics: { title:'通信诊断', english:'COMMUNICATION DIAGNOSTICS', description:'检查通信链路、有效帧、CRC 与数据接收情况。' },
    video: { title:'视频监控', english:'ONBOARD VIDEO', description:'查看当前无人船的船载摄像头画面，独立控制视频连接与播放。' },
    driving: { title:'驾驶操控', english:'PILOT STATION', description:'集中查看图传、地图与航行仪表；管理员启用操控后使用键盘驾驶。' },
    missions: { title:'航线任务', english:'MISSION PLANNER', description:'在地图规划航点并保存到服务器，按船只独立执行航线。' }
  };
  const panels = new Map([...document.querySelectorAll('[data-workspace-view]')].map(panel => [panel.dataset.workspaceView,panel]));
  if (!panels.has('overview')) return;
  const links = [...document.querySelectorAll('.side-nav a,.mobile-nav a')];
  const restrictedViews = new Set(['driving','missions']);
  const boatNav = document.getElementById('singleBoatNav');
  const boatNavName = document.getElementById('singleBoatNavName');
  const breadcrumbView = document.getElementById('workspaceBreadcrumbView');
  const breadcrumbBoat = document.getElementById('workspaceBreadcrumbBoat');
  const shared = {
    navigation:document.getElementById('navigation'),
    attitude:document.getElementById('attitude'),
    sensors:document.getElementById('sensorTelemetry'),
    video:document.getElementById('videoCard'),
    motors:document.getElementById('motors')
  };
  const title = document.getElementById('viewTitle');
  let current = null, selectedBoatId = '', deferredView = null;

  function canAccessView(id) {
    const auth = window.BoatAuth;
    // 账户状态未确认时先隐藏入口；旧访问密码模式保留原来的监测页面。
    return !restrictedViews.has(id) || (auth?.ready === true &&
      (auth.enabled === false || (auth.enabled === true && auth.user?.role === 'admin')));
  }

  function updateAccess() {
    for (const link of links) {
      if (restrictedViews.has(link.hash.slice(1))) link.hidden = !canAccessView(link.hash.slice(1));
    }
    if (deferredView && canAccessView(deferredView)) {
      const destination = deferredView; deferredView = null;
      navigate(destination,{replace:true,focus:false});
    } else if (current && !canAccessView(current)) {
      // 切换账号/会话过期时立即离开专用页面，正常派发离页事件以释放手动驾驶。
      navigate(defaultView(),{replace:true,focus:false});
    }
    if (window.BoatAuth?.user?.role === 'guest' || window.BoatAuth?.enabled === false) deferredView = null;
  }

  function updateBreadcrumb() {
    if (breadcrumbView) breadcrumbView.textContent = views[current]?.title || '';
    if (breadcrumbBoat) {
      breadcrumbBoat.textContent = selectedBoatId;
      breadcrumbBoat.hidden = !selectedBoatId || current === 'fleet';
    }
  }

  function setBoatSelected(selectedId) {
    const id = typeof selectedId === 'string' ? selectedId.trim() : '';
    const changed = id !== selectedBoatId;
    selectedBoatId = id;
    if (boatNav) {
      boatNav.hidden = !id;
      // 遥测会反复同步同一船只，不能覆盖用户手动折叠菜单的选择。
      if (!id) boatNav.open = false;
      else if (changed) boatNav.open = true;
    }
    if (boatNavName) boatNavName.textContent = id || '未选择';
    updateBreadcrumb();
  }

  // 实际面板始终只有一份，换页不重建对象，也不会重新建立设备连接。
  function mount(panel, slotName) {
    const slot = document.querySelector('[data-workspace-slot="'+slotName+'"]');
    if (panel && slot && panel.parentElement !== slot) slot.append(panel);
  }
  function mountShared(view) {
    if (view === 'overview') {
      mount(shared.navigation,'overview-map');
      mount(shared.attitude,'overview-attitude');
      mount(shared.sensors,'overview-sensors');
    } else if (view === 'navigation') mount(shared.navigation,'navigation-map');
    else if (view === 'attitude') {
      mount(shared.attitude,'attitude-model');
      mount(shared.sensors,'attitude-sensors');
    } else if (view === 'video') mount(shared.video,'video-playback');
    else if (view === 'propulsion') mount(shared.motors,'propulsion-motors');
    else if (view === 'driving') {
      mount(shared.navigation,'driving-map');
      mount(shared.attitude,'driving-model');
      mount(shared.sensors,'driving-sensors');
      mount(shared.video,'driving-video');
      mount(shared.motors,'driving-motors');
    }
  }
  function defaultView() { return panels.has('fleet') ? 'fleet' : 'overview'; }
  function routeFromLocation() { return window.location.hash.slice(1); }
  function writeHash(view, replace) {
    const hash = '#'+view;
    if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](window.history.state,'',hash);
  }
  function resetScroll() {
    // 页面切换必须立即回顶部，避免继承全局 smooth 产生跨页面滚动动画。
    window.scrollTo({top:0,left:0,behavior:'instant'});
  }
  function navigate(id, {replace=false,focus=true,history:recordHistory=true} = {}) {
    const requested = Object.hasOwn(views,id) && panels.has(id) ? id : defaultView();
    const permitted = canAccessView(requested);
    if (!permitted && (!window.BoatAuth?.ready || (window.BoatAuth?.enabled === true && !window.BoatAuth.user))) deferredView = requested;
    else deferredView = null;
    const view = permitted ? requested : defaultView(), previous = current, changed = view !== previous;
    if (recordHistory) writeHash(view,replace);
    if (boatNav) boatNav.open = !!selectedBoatId && view !== 'fleet';
    if (changed) {
      mountShared(view);
      panels.forEach((panel,name) => { panel.hidden = name !== view; });
      current = view;
      document.documentElement.dataset.workspaceView = view;
      const meta = views[view];
      if (title) title.textContent = meta.title;
      const english = document.getElementById('viewEnglish'), subtitle = document.getElementById('viewSubtitle');
      if (english) english.textContent = meta.english;
      if (subtitle) subtitle.textContent = meta.description;
      updateBreadcrumb();
      document.title = meta.title+' · 无人船监测平台';
      links.forEach(link => {
        const destination = link.hash.slice(1), selected = destination === view;
        link.classList.toggle('active',selected);
        if (selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
        // 平板侧栏会隐藏文字，保留独立的可访问名称和鼠标提示。
        if (Object.hasOwn(views,destination)) {
          link.setAttribute('aria-label',views[destination].title);
          link.title = views[destination].title;
        }
        const panel = panels.get(destination);
        if (panel?.id) link.setAttribute('aria-controls',panel.id);
      });
      window.dispatchEvent(new CustomEvent('boat-view-change',{detail:{view,previous}}));
    }
    resetScroll();
    if (focus) title?.focus({preventScroll:true});
    return view;
  }
  document.addEventListener('click',event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('.side-nav a,.mobile-nav a,.brand,.skip-link,a[data-view-link]');
    if (!link || !Object.hasOwn(views,link.hash.slice(1))) return;
    event.preventDefault();
    navigate(link.hash.slice(1));
  });
  function restoreLocation() {
    // 地址栏直达、刷新、前进/后退与点击入口走同一权限校验，不增加额外历史。
    navigate(routeFromLocation(),{replace:true,focus:false});
  }
  window.addEventListener('popstate',restoreLocation);
  window.addEventListener('hashchange',restoreLocation);
  window.addEventListener('boat-selection-change',event=>setBoatSelected(event.detail?.selectedId));
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  window.BoatAuth?.addEventListener('change',updateAccess);
  window.BoatWorkspace = Object.freeze({get current(){return current;},navigate,setBoatSelected,canAccessView});
  setBoatSelected('');
  navigate(routeFromLocation(),{replace:true,focus:false});
  updateAccess();
})();
