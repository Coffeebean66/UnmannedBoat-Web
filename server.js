/* 无人船平台：静态页面与可选的 MQTT 实时遥测服务。 */
'use strict';
const http=require('node:http'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const {CloudBridge}=require('./server/cloud');
const {createCloudApi}=require('./server/cloud-api');
const {createAccountApi}=require('./server/account-api');
const {createUpdateApi,readCurrentRelease}=require('./server/update-api');
const {createMapConfigApi,MAP_CONTENT_SECURITY_POLICY}=require('./server/map-config');
const {version:packageVersion}=require('./package.json');
const ROOT=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.glb':'model/gltf-binary','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
function createServer({root=ROOT,key,cert,env=process.env,cloud,cloudOptions={},apiOptions={},updateOptions={},accountOptions={},mapOptions={}}={}) {
  const base=fs.realpathSync(root);
  const bridge=cloud||new CloudBridge({env,...cloudOptions});
  const accounts=createAccountApi({...accountOptions,env});
  const api=createCloudApi({bridge,env,...apiOptions,accounts});
  // 启动时只读取一次版本信息，health 与更新状态都代表同一个实际运行实例。
  const current=readCurrentRelease({version:packageVersion,releasePath:updateOptions.releasePath,instanceId:updateOptions.instanceId});
  const updateApi=createUpdateApi({...updateOptions,env,current,accounts});
  const mapApi=createMapConfigApi({...mapOptions,env,accounts});
  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options','DENY');
    // 业务脚本和模型本地加载；高德官方地图 SDK 及地图资源使用明确的域名白名单。
    res.setHeader('Content-Security-Policy',MAP_CONTENT_SECURITY_POLICY);
    const fail=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(text);};
    let pathname;
    try{pathname=decodeURIComponent((req.url||'/').split('?')[0]);}catch(_){return fail(400,'Invalid path');}
    if(pathname.includes('\0')||pathname.includes('\\')||pathname.split('/').some(x=>x==='..'||x.startsWith('.')))return fail(403,'Forbidden');
    try{
      const url=new URL(req.url||'/','http://localhost');
      if(await mapApi.handle(req,res,url))return;
      if(await accounts.handle(req,res,url))return;
      if(await updateApi.handle(req,res,url))return;
      if(await api.handle(req,res,url))return;
    }catch(_){if(!res.headersSent)return fail(500,'Service unavailable');res.destroy();return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.setHeader('Allow','GET, HEAD');return fail(405,'Method not allowed');}
    if(pathname==='/healthz'){
      // 部署检查只读取服务就绪状态，不依赖管理员初始密码，避免改密后误判失败。
      const readiness={cloudEnabled:bridge.enabled===true,brokerConnected:bridge.list()?.brokerConnected===true,
        accountsEnabled:accounts.enabled===true,accountManagement:1};
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      return res.end(req.method==='HEAD'?undefined:JSON.stringify({ok:true,app:'unmanned-boat-web',...current,apiVersion:1,readiness}));
    }
    if(pathname==='/')pathname='/index.html';
    const requested=path.resolve(base,'.'+pathname);
    if(!requested.startsWith(base+path.sep))return fail(403,'Forbidden');
    try {
      const actual=await fs.promises.realpath(requested);
      // 同时校验真实路径，防止 public 内部链接意外暴露其他文件。
      if(!actual.startsWith(base+path.sep))return fail(403,'Forbidden');
      const stat=await fs.promises.stat(actual);
      if(!stat.isFile())return fail(404,'Not found');
      res.writeHead(200,{'Content-Type':MIME[path.extname(actual).toLowerCase()]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache'});
      if(req.method==='HEAD')return res.end();
      const stream=fs.createReadStream(actual);stream.on('error',()=>res.destroy());stream.pipe(res);
    } catch(error){fail(error.code==='ENOENT'||error.code==='ENOTDIR'?404:500,error.code==='ENOENT'?'Not found':'File unavailable');}
  };
  const server=key&&cert?https.createServer({key,cert},handler):http.createServer(handler);
  const originalClose=server.close.bind(server);
  server.close=(callback)=>{mapApi.close();accounts.close();updateApi.close();api.close();bridge.stop();return originalClose(callback);};
  server.boatCloud=bridge;server.boatCloudApi=api;server.boatUpdateApi=updateApi;server.boatRelease=current;server.boatAccounts=accounts;
  bridge.start();
  return server;
}
if(require.main===module) {
  const port=Number(process.env.PORT||8080),host=process.env.HOST||'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT 必须为 1—65535');
  if(!!process.env.TLS_KEY!==!!process.env.TLS_CERT)throw Error('TLS_KEY 和 TLS_CERT 必须同时设置');
  const secure=!!process.env.TLS_KEY;
  const server=createServer(secure?{key:fs.readFileSync(process.env.TLS_KEY),cert:fs.readFileSync(process.env.TLS_CERT)}:{});
  server.on('error',error=>{console.error('服务器启动失败：'+error.code);process.exitCode=1;});
  server.listen(port,host,()=>console.log('无人船监控平台：http'+(secure?'s':'')+'://'+host+':'+port+'（Ctrl+C 停止）'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
}
module.exports={createServer};
