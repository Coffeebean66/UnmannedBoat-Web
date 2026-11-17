/* 登录前读取平台开关；品牌入场结束后等待用户确认，业务初始化仍然并行进行。 */
(() => {
  'use strict';
  const screen=document.getElementById('startupScreen');
  if(!screen)return;
  const root=document.documentElement,motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const skip=document.getElementById('startupSkip'),logo=document.getElementById('startupLogo');
  const status=document.getElementById('startupStatus'),buttonLabel=document.getElementById('startupButtonLabel');
  let removed=false,leaving=false,phase='configuring',animationTimer,exitTimer,configTimer,resolveFinished;
  const finished=new Promise(resolve=>{resolveFinished=resolve;}),controller=new AbortController(),background=[];
  try{const saved=localStorage.getItem('boat_web_theme_v1');if(saved==='light'||saved==='dark')root.dataset.theme=saved;}catch(_){}
  root.dataset.startup=phase;
  function remove(){
    if(removed)return;
    removed=true;clearTimeout(animationTimer);clearTimeout(exitTimer);clearTimeout(configTimer);controller.abort();
    document.removeEventListener('keydown',onKey,true);document.removeEventListener('keyup',onKey,true);
    screen.removeEventListener('click',onClick);
    window.removeEventListener('DOMContentLoaded',onReady);window.removeEventListener('pagehide',remove);
    motion.removeEventListener('change',onMotion);
    for(const [node,inert]of background)node.inert=inert;
    delete root.dataset.startup;screen.remove();resolveFinished();
  }
  function dismiss(){
    if(leaving||removed)return;
    leaving=true;clearTimeout(animationTimer);root.dataset.startup='leaving';skip.disabled=true;
    if(motion.matches)remove();else exitTimer=setTimeout(remove,280);
  }
  function waitForEntry(){
    if(removed||leaving||phase!=='active')return;
    clearTimeout(animationTimer);phase='waiting';root.dataset.startup=phase;
    status.textContent='按任意键或点击进入后台';buttonLabel.textContent='进入后台';
  }
  function onReady(){
    if(removed)return;
    // 隔离背景焦点，避免等待期间的Tab或快捷键操作到驾驶页面。
    for(const node of document.body.children)if(node!==screen&&node.tagName!=='SCRIPT'){background.push([node,node.inert]);node.inert=true;}
    screen.focus({preventScroll:true});
  }
  function onKey(event){
    if(removed)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.type!=='keydown'||event.repeat||event.isComposing||leaving)return;
    if(phase==='waiting')dismiss();
    else if(phase==='active'&&event.key==='Escape')waitForEntry();
  }
  function onClick(event){
    event.preventDefault();event.stopImmediatePropagation();
    if(phase==='waiting')dismiss();
    else if(phase==='active'&&event.target.closest('#startupSkip'))waitForEntry();
  }
  function onMotion(event){if(event.matches)waitForEntry();}
  function onLogoError(){logo.hidden=true;document.getElementById('startupWordmark').hidden=false;}
  logo.addEventListener('error',onLogoError,{once:true});
  if(logo.complete&&!logo.naturalWidth)onLogoError();
  screen.addEventListener('click',onClick);
  document.addEventListener('keydown',onKey,true);document.addEventListener('keyup',onKey,true);
  motion.addEventListener('change',onMotion);window.addEventListener('pagehide',remove,{once:true});
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',onReady,{once:true});else onReady();
  window.BoatStartup=Object.freeze({get active(){return !removed;},get waiting(){return !removed&&!leaving&&phase==='waiting';},finished});
  async function configure(){
    let enabled=true;
    // 网络异常最多等待1.5秒后使用默认开启；不依赖登录、船端或地图就绪。
    const timeout=new Promise((_,reject)=>{configTimer=setTimeout(()=>{controller.abort();reject(Error('Startup settings timeout'));},1500);});
    try{
      const data=await Promise.race([fetch('/api/startup-settings',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal})
        .then(response=>{if(!response.ok)throw Error('Startup settings unavailable');return response.json();}),timeout]);
      if(typeof data.enabled==='boolean')enabled=data.enabled;
    }catch(_){}finally{clearTimeout(configTimer);}
    if(removed)return;
    if(!enabled){remove();return;}
    phase='active';root.dataset.startup=phase;
    animationTimer=setTimeout(waitForEntry,motion.matches?0:1250);
  }
  configure();
})();
