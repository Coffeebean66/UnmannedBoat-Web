/* 页面导航只切换可见工作区；移动已有面板，保留地图、轨迹和 WebGL 实例。 */
(() => {
  'use strict';
  const views = {
    overview: { title:'船况概览', english:'VESSEL OVERVIEW', description:'快速掌握船速、航向、定位与姿态，进入对应页面查看详情。' },
    navigation: { title:'船位与轨迹', english:'NAVIGATION & TRACK', description:'查看实时船位、速度方向与航行轨迹，独立调整地图视野。' },
    attitude: { title:'三维姿态', english:'VESSEL ATTITUDE', description:'观察三维船体姿态和 IMU / RTK 测量数据。' },
    analysis: { title:'控制曲线', english:'CONTROL ANALYSIS', description:'对比目标与实际船速、航向，辅助闭环调参。' },
    propulsion: { title:'推进系统', english:'PROPULSION SYSTEM', description:'监测双推进器转速、电压、电流和输出状态。' },
    diagnostics: { title:'通信诊断', english:'COMMUNICATION DIAGNOSTICS', description:'检查通信链路、有效帧、CRC 与数据接收情况。' }
  };
  const panels = new Map([...document.querySelectorAll('[data-workspace-view]')].map(panel => [panel.dataset.workspaceView,panel]));
  if (!panels.has('overview')) return;
  const links = [...document.querySelectorAll('.side-nav a,.mobile-nav a')];
  const shared = {
    navigation:document.getElementById('navigation'),
    attitude:document.getElementById('attitude'),
    sensors:document.getElementById('sensorTelemetry')
  };
  const title = document.getElementById('viewTitle');
  let current = null;

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
    }
  }
  function validView(id) { return Object.hasOwn(views,id) && panels.has(id) ? id : 'overview'; }
  function routeFromLocation() { return validView(window.location.hash.slice(1)); }
  function writeHash(view, replace) {
    const hash = '#'+view;
    if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](window.history.state,'',hash);
  }
  function resetScroll() {
    // 页面切换必须立即回顶部，避免继承全局 smooth 产生跨页面滚动动画。
    window.scrollTo({top:0,left:0,behavior:'instant'});
  }
  function navigate(id, {replace=false,focus=true,history:recordHistory=true} = {}) {
    const view = validView(id), previous = current, changed = view !== previous;
    if (recordHistory) writeHash(view,replace);
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
    const view = routeFromLocation();
    // 无效片段统一回到概览，不让浏览器滚到不存在或旧的页面锚点。
    if (window.location.hash !== '#'+view) writeHash(view,true);
    navigate(view,{focus:false,history:false});
  }
  window.addEventListener('popstate',restoreLocation);
  window.addEventListener('hashchange',restoreLocation);
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  window.BoatWorkspace = Object.freeze({get current(){return current;},navigate});
  navigate(routeFromLocation(),{replace:true,focus:false});
})();
