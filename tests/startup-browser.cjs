/* 本地真实Chrome验证：等待确认进入、管理员开关、全局生效及主题/手机适配。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {createFixtureServer}=require('./mqtt-browser-fixture.cjs');
const output=path.resolve(__dirname,'../.test-output'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
  fs.mkdirSync(output,{recursive:true});
  const run=fs.mkdtempSync(path.join(output,'startup-state-'));
  const server=createFixtureServer({env:{STATE_DIRECTORY:run,BOAT_ACCOUNTS_FILE:path.join(run,'accounts.json')},startupOptions:{file:path.join(run,'startup-settings.json'),defaultEnabled:true}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port,profile=fs.mkdtempSync(path.join(output,'chrome-startup-')),errors=[];
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-webgl','--use-angle=swiftshader',
    '--enable-unsafe-swiftshader','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'
  ],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>errors.push(error.message));let socket;
  try{
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;i<100&&!fs.existsSync(portFile)&&!errors.length;i++)await wait(100);
    if(!fs.existsSync(portFile))throw Error(errors.join('; ')||'Chrome did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0],pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let serial=0,initialization;const pending=new Map();
    socket.onmessage=event=>{
      const message=JSON.parse(event.data),item=pending.get(message.id);
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;
    };
    const until=async expression=>{
      for(let i=0;i<160;i++){if(await evaluate(expression))return;await wait(25);}
      const state=await evaluate('({startup:window.BoatStartup?.active,phase:document.documentElement.dataset.startup,screen:!!document.getElementById("startupScreen"),login:document.getElementById("accountLoginDialog")?.open,account:window.BoatAuth?.state(),settings:{open:document.getElementById("platformSettingsDialog")?.open,status:document.getElementById("startupSettingsStatus")?.textContent,hidden:document.getElementById("startupSettings")?.hidden,busy:document.getElementById("startupSettingsForm")?.getAttribute("aria-busy")}})');
      throw Error('Condition timed out: '+expression+'\n'+JSON.stringify(state)+'\n'+errors.join('\n'));
    };
    const navigate=async(theme,width,height,extra='')=>{
      if(initialization)await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:initialization});
      initialization=(await send('Page.addScriptToEvaluateOnNewDocument',{source:'localStorage.setItem("boat_web_theme_v1",'+JSON.stringify(theme)+');'+extra})).identifier;
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await send('Page.navigate',{url});
    };
    const picture=async name=>{
      const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));
    };
    const key=async(key,code,number)=>{
      await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:number});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:number});
    };
    const click=async(x,y)=>{
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y});
    };
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
    await send('Network.setBlockedURLs',{urls:['https://*']});
    const layouts=[];
    for(const [theme,width,height,action]of [['dark',1440,900,'letter'],['light',1440,900,'shift'],['dark',375,812,'tap'],['light',320,568,'button']]){
      await navigate(theme,width,height);
      await until('window.BoatStartup?.active&&document.getElementById("startupLogo").naturalWidth===480');
      await until('BoatStartup.waiting');
      if(action==='letter')await wait(3500); // 超过旧4秒自动退出时间，仍须等待确认。
      const layout=await evaluate('(()=>{const box=document.getElementById("startupScreen"),logo=document.getElementById("startupLogo"),title=document.querySelector(".startup-title"),button=document.getElementById("startupSkip"),r=button.getBoundingClientRect(),b=title.getBoundingClientRect();return {theme:document.documentElement.dataset.theme,background:getComputedStyle(box).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth,logo:logo.naturalWidth,titleFits:b.left>=0&&b.right<=innerWidth&&b.top>=0,loginVisible:document.getElementById("accountLoginDialog").open,skip:{x:r.x+r.width/2,y:r.y+r.height/2,visible:r.bottom<=innerHeight}};})()');
      assert.equal(layout.theme,theme);assert.equal(layout.overflow,false);assert.equal(layout.titleFits,true);assert.equal(layout.loginVisible,false);assert.equal(layout.skip.visible,true);
      assert.equal(await evaluate('getComputedStyle(document.getElementById("startupScreen")).visibility'),'visible');
      assert.equal(await evaluate('document.getElementById("startupStatus").textContent'),'按任意键或点击进入后台');
      assert.equal(await evaluate('document.querySelector("header.topbar").inert'),true);
      layouts.push({theme,width,height,background:layout.background});
      await picture('startup-'+theme+'-'+width);
      if(action==='letter')await key('q','KeyQ',81);
      if(action==='shift')await key('Shift','ShiftLeft',16);
      if(action==='tap'){
        await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y:height/2}]});
        await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }
      if(action==='button')await click(layout.skip.x,layout.skip.y);
      await until('window.BoatStartup&&!BoatStartup.active&&!document.getElementById("startupScreen")&&document.getElementById("accountLoginDialog").open');
      assert.equal(await evaluate('document.documentElement.hasAttribute("data-startup")'),false);
      assert.equal(await evaluate('document.querySelector("header.topbar").inert'),false);
      assert.equal(await evaluate('document.getElementById("accountUsername").value'),'','Entry key must not type into login');
    }
    assert.notEqual(layouts[0].background,layouts[1].background,'Startup uses the saved theme before opening the workbench');

    // 提前按键不会进入；Esc/跳过只提前结束动画，仍需下一次确认。
    await navigate('dark',1440,900);
    await until('document.documentElement.dataset.startup==="active"');
    await key('w','KeyW',87);assert.equal(await evaluate('BoatStartup.active'),true);
    await key('Escape','Escape',27);await until('BoatStartup.waiting');
    assert.equal(await evaluate('document.getElementById("accountLoginDialog").open'),false);
    await key('Enter','Enter',13);await until('!BoatStartup.active&&document.getElementById("accountLoginDialog").open');

    // 图片失败保留品牌文字，动画和登录衔接仍可完成。
    await send('Network.setBlockedURLs',{urls:['https://*','*coffeebean-logo.png*']});
    await navigate('dark',1440,900);
    await until('window.BoatStartup?.active&&!document.getElementById("startupWordmark").hidden');
    await until('document.documentElement.dataset.startup==="active"');
    await evaluate('document.getElementById("startupSkip").click()');
    await until('BoatStartup.waiting');
    await click(700,400);
    await until('!BoatStartup.active&&document.getElementById("accountLoginDialog").open');

    // 减弱动态仍需明确进入；配置接口暂不可用也不无限等待网络。
    await send('Network.setBlockedURLs',{urls:['https://*','*/api/startup-settings']});
    await navigate('dark',1440,900);await until('window.BoatStartup?.waiting');
    await key(' ','Space',32);await until('!BoatStartup.active');
    await send('Network.setBlockedURLs',{urls:['https://*']});
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await navigate('light',375,812);
    await until('window.BoatStartup?.waiting&&window.BoatAuth?.ready');
    assert.equal(await evaluate('document.getElementById("accountLoginDialog").open'),false);
    await key(' ','Space',32);await until('!BoatStartup.active&&document.getElementById("accountLoginDialog").open');
    await evaluate('BoatAuth.login("operator","browser-admin-test-only")');
    await until('BoatAuth.user?.role==="admin"&&!document.getElementById("accountLoginDialog").open');
    assert.equal(await evaluate('BoatAuth.canManage'),true);
    await evaluate('BoatWorkspace.navigate("navigation")');
    assert.equal(await evaluate('document.getElementById("startupScreen")'),null,'Workspace changes do not replay startup');

    // 管理员从真实设置表单关闭，匿名刷新也立即进入；再启用后欢迎页恢复。
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('document.getElementById("platformSettingsDialog").open&&!document.getElementById("startupSettingsSave").disabled');
    assert.equal(await evaluate('document.getElementById("startupSettingsEnabled").checked'),true);
    await evaluate('document.getElementById("startupSettingsEnabled").click();document.getElementById("startupSettingsForm").requestSubmit()');
    await until('document.getElementById("startupSettingsStatus").textContent.includes("已保存")&&!document.getElementById("startupSettingsSave").disabled');
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'startup-settings.json'),'utf8')).enabled,false);
    await picture('startup-admin-settings-375');
    await evaluate('document.getElementById("platformSettingsClose").click()');
    await until('!document.getElementById("platformSettingsDialog").open');
    await evaluate('BoatAuth.logout()');await navigate('dark',1440,900);
    // 关闭动画后可早于主页面脚本就绪，操作平台按钮前须等待其事件绑定完成。
    await until('window.boatMonitor&&window.BoatStartup&&!BoatStartup.active&&window.BoatAuth?.ready&&document.getElementById("accountLoginDialog").open');
    await evaluate('BoatAuth.login("observer","browser-guest-test-only")');
    await until('BoatAuth.user?.role==="guest"');
    assert.equal(await evaluate('document.getElementById("startupSettings").hidden'),true);
    await evaluate('BoatAuth.login("operator","browser-admin-test-only")');
    await evaluate('document.getElementById("platformSettingsToggle").click()');
    await until('!document.getElementById("startupSettingsSave").disabled');
    assert.equal(await evaluate('document.getElementById("startupSettingsEnabled").checked'),false);
    await evaluate('document.getElementById("startupSettingsEnabled").click();document.getElementById("startupSettingsForm").requestSubmit()');
    await until('document.getElementById("startupSettingsStatus").textContent.includes("已保存")&&!document.getElementById("startupSettingsSave").disabled');
    await navigate('dark',1440,900);await until('window.BoatStartup?.waiting&&window.BoatAuth?.user');
    assert.equal(await evaluate('document.getElementById("accountLoginDialog").open'),false);
    await click(700,400);await until('!BoatStartup.active');

    // 启动脚本资源不可用时，隐藏态不妨碍已有登录页面和工作台初始化。
    await evaluate('BoatAuth.logout()');
    await send('Network.setBlockedURLs',{urls:['https://*','*startup.js*']});
    await navigate('dark',1440,900);
    await until('window.BoatAuth?.ready&&document.getElementById("accountLoginDialog").open');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("startupScreen")).display'),'none');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'startup-layouts.json'),JSON.stringify(layouts,null,2));
    console.log('Chrome startup passed: waits beyond 4s, arbitrary keys/click/tap, input isolation, skip-to-wait, administrator global toggle and anonymous refresh, saved themes, 1440/375/320px, reduced motion, configuration/image/script fallbacks, login and navigation.');
  }finally{socket?.close();browser.kill();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
