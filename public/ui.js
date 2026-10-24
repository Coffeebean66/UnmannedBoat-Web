/* 本地 SVG 图标、主题和大屏交互，无外部字体或组件依赖。 */
(() => {
  const paths = {
    boat:'M4 13 12 9l8 4-2 6H6l-2-6ZM8 10V5h8v5M12 5V2M2 21q2-2 5 0t5 0 5 0 5 0',
    dashboard:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    motor:'M9 9a4 4 0 1 0 6 6 4 4 0 0 0-6-6ZM12 8V3q7-2 5 4l-2 3M16 12h5q2 7-4 5l-3-2M12 16v5q-7 2-5-4l2-3M8 12H3Q1 5 7 7l3 2',
    chart:'M3 3v18h18M6 14l4-5 5 3 5-7',
    map:'m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16M15 5v16',
    compass:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4 6-2 6-6 2 2-6 6-2Z',
    activity:'M2 12h4l3-8 6 16 3-8h4',
    settings:'m9 3 1-1h4l1 3 3 1 3 1v4l-2 2-1 3-1 3h-4l-2-2-3-1-3-1v-4l2-2 1-3 1-3ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    bluetooth:'m7 7 10 10-5 4V3l5 4L7 17',
    radio:'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16',
    clock:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6v6l4 2',
    layers:'m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
    gauge:'M4 19a10 10 0 1 1 16 0H4ZM12 13l5-5M6 12H4M12 6V4M18 12h2',
    satellite:'m12 3 9 9-4 4-9-9 4-4ZM7 4 3 8l3 3 4-4M17 14l-4 4 3 3 4-4M3 14a7 7 0 0 1 7 7M3 18a3 3 0 0 1 3 3',
    monitor:'M3 3h18v13H3zM12 16v5M7 21h10',
    location:'M12 22s8-9 8-14a8 8 0 0 0-16 0c0 5 8 14 8 14ZM12 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    arrow:'M4 12h16M14 6l6 6-6 6',
    chevron:'m6 9 6 6 6-6',
    close:'m6 6 12 12M6 18 18 6',
    moon:'M20 13A8 8 0 0 1 11 4 9 9 0 1 0 20 13Z',
    sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
    sliders:'M4 5h4M12 5h8M4 12h10M18 12h2M4 19h2M10 19h10M8 2v6M14 9v6M6 16v6',
    download:'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
    copy:'M8 8h13v13H8zM16 8V3H3v13h5',
    help:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM9 8a3 3 0 1 1 4 3c-1 0-1 1-1 3M12 17v.1'
  };
  const icon=name=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.activity)+'"/></svg>';
  function decorate(root=document){root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));}
  function setTheme(theme) {
    document.documentElement.dataset.theme=theme;
    const button=document.getElementById('themeToggle'),dark=theme==='dark';
    button.innerHTML=icon(dark?'sun':'moon');
    button.setAttribute('aria-label',dark?'切换到浅色主题':'切换到深色主题');
    button.title=button.getAttribute('aria-label');button.setAttribute('aria-pressed',String(dark));
    document.querySelector('meta[name=theme-color]').content=dark?'#061425':'#f4f7fa';
    try{localStorage.setItem('boat_web_theme_v1',theme);}catch(_){}
    window.dispatchEvent(new Event('boat-theme-change'));
  }
  decorate();
  // 首次打开使用深海蓝；显式选择过浅色的用户仍恢复原来的偏好。
  let theme='dark';try{const saved=localStorage.getItem('boat_web_theme_v1');if(saved==='light'||saved==='dark')theme=saved;}catch(_){}
  setTheme(theme);
  document.getElementById('themeToggle').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
  document.getElementById('sidebarSettings').onclick=()=>document.getElementById('settingsDialog').showModal();
  const clock=document.getElementById('dashboardTime');
  function updateClock(){if(!document.hidden){const now=new Date();clock.dateTime=now.toISOString();clock.textContent=now.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}}
  updateClock();const clockTimer=setInterval(updateClock,1000);
  window.addEventListener('pagehide',()=>clearInterval(clockTimer),{once:true});
  const dialog=document.getElementById('settingsDialog');
  const syncModal=()=>{
    document.documentElement.classList.toggle('modal-open',dialog.open);
    // dialog 位于浏览器顶层，提示也要进入该层，避免校验错误被遮罩挡住。
    const toast=document.getElementById('toast'),parent=dialog.open?dialog:document.body;
    if(toast.parentElement!==parent)parent.append(toast);
  };
  new MutationObserver(syncModal).observe(dialog,{attributes:true,attributeFilter:['open']});
  dialog.addEventListener('close',syncModal);
  window.BoatUI={icon,decorate,setTheme};
})();
