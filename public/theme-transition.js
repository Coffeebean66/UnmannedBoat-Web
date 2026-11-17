/* 直接插值主题颜色，不截取整页画面，地图、视频和驾驶输入继续实时运行。 */
(() => {
  'use strict';
  const root=document.documentElement,motion=matchMedia('(prefers-reduced-motion: reduce)');
  const colors=('bg panel soft line line-strong text muted faint accent accent-hover accent-soft '+
    'blue blue-soft violet violet-soft success success-bg warn warn-bg danger danger-bg '+
    'chart-bg chart-grid chart-text chart-target chart-actual nav-bg').split(' ').map(name=>'--'+name);
  const timing={duration:360,easing:'cubic-bezier(.22,.61,.36,1)'};
  let interpolatesColors=typeof CSS!=='undefined'&&typeof CSS.registerProperty==='function';
  let animations=[],generation=0;
  // 注册为可插值颜色，使用这些变量的文字、面板及渐变背景可以同步过渡。
  if(interpolatesColors)for(const name of colors){
    try{CSS.registerProperty({name,syntax:'<color>',inherits:true,initialValue:'#000000'});}
    catch(error){if(error.name!=='InvalidModificationError'){interpolatesColors=false;break;}}
  }
  const palette=()=>{const style=getComputedStyle(root);return Object.fromEntries(colors.map(name=>[name,style.getPropertyValue(name).trim()]));};
  function stop(){
    ++generation;
    for(const animation of animations)animation.cancel();
    animations=[];delete root.dataset.themeTransition;
  }
  function run(update,{animate=false}={}){
    const play=animate&&!motion.matches&&!document.hidden&&!window.BoatStartup?.active&&typeof root.animate==='function';
    // 连点时从屏幕当前的中间颜色继续，取消旧动画只影响本模块创建的效果。
    const from=play&&interpolatesColors?palette():null;
    stop();
    // 先通知图表/地图读取最终主题，避免Canvas把动画起始颜色缓存成新主题。
    update();
    if(!play)return;
    const to=palette(),current=generation;
    try{
      if(from&&colors.some(name=>from[name]!==to[name])){
        const animation=root.animate([from,to],timing);animation.id='boat-theme-palette';animations.push(animation);
      }
      for(const button of document.querySelectorAll('#themeToggle,#driverThemeToggle')){
        if(!button.getClientRects().length)continue;
        const icon=button.querySelector('svg');
        if(icon){
          const animation=icon.animate([{transform:'rotate(-70deg) scale(.65)',opacity:.35},{transform:'rotate(0deg) scale(1)',opacity:1}],timing);
          animation.id='boat-theme-icon';animations.push(animation);
        }
        const halo=button.animate([{boxShadow:'0 0 0 0 '+to['--accent']},{boxShadow:'0 0 0 9px transparent'}],timing);
        halo.id='boat-theme-halo';animations.push(halo);
      }
      if(!animations.length)return;
      root.dataset.themeTransition='active';
      Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>{
        if(current!==generation)return;
        animations=[];delete root.dataset.themeTransition;
      });
    }catch(_){stop();} // 旧浏览器不支持动画时，最终主题仍已正确应用。
  }
  motion.addEventListener('change',event=>{if(event.matches)stop();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  window.addEventListener('pagehide',stop,{once:true});
  window.BoatThemeTransition=Object.freeze({run});
})();
