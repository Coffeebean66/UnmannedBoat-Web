/* 零运行时依赖静态服务器：默认只监听本机，可用 HOST/PORT/TLS_* 配置。 */
'use strict';
const http=require('node:http'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.join(__dirname,'public');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.glb':'model/gltf-binary','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
function createServer({root=ROOT,key,cert}={}) {
  const base=fs.realpathSync(root);
  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','bluetooth=(self)');
    // 所有程序和模型均本地加载；仅地图图块需要外部图片权限。
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    const fail=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(text);};
    if(req.method!=='GET'&&req.method!=='HEAD'){res.setHeader('Allow','GET, HEAD');return fail(405,'Method not allowed');}
    let pathname;
    try{pathname=decodeURIComponent((req.url||'/').split('?')[0]);}catch(_){return fail(400,'Invalid path');}
    if(pathname.includes('\0')||pathname.includes('\\')||pathname.split('/').some(x=>x==='..'||x.startsWith('.')))return fail(403,'Forbidden');
    if(pathname==='/healthz'){res.setHeader('Content-Type','application/json');return res.end(req.method==='HEAD'?undefined:'{"ok":true,"app":"unmanned-boat-web"}');}
    if(pathname==='/')pathname='/index.html';
    const requested=path.resolve(base,'.'+pathname);
    if(!requested.startsWith(base+path.sep))return fail(403,'Forbidden');
    try {
      const actual=await fs.promises.realpath(requested);
      // 同时校验真实路径，防止public内部链接意外暴露其他文件。
      if(!actual.startsWith(base+path.sep))return fail(403,'Forbidden');
      const stat=await fs.promises.stat(actual);
      if(!stat.isFile())return fail(404,'Not found');
      res.writeHead(200,{'Content-Type':MIME[path.extname(actual).toLowerCase()]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache'});
      if(req.method==='HEAD')return res.end();
      const stream=fs.createReadStream(actual);stream.on('error',()=>res.destroy());stream.pipe(res);
    } catch(error){fail(error.code==='ENOENT'||error.code==='ENOTDIR'?404:500,error.code==='ENOENT'?'Not found':'File unavailable');}
  };
  return key&&cert?https.createServer({key,cert},handler):http.createServer(handler);
}
if(require.main===module) {
  const port=Number(process.env.PORT||8080),host=process.env.HOST||'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT 必须为 1–65535');
  if(!!process.env.TLS_KEY!==!!process.env.TLS_CERT)throw Error('TLS_KEY 和 TLS_CERT 必须同时设置');
  const secure=!!process.env.TLS_KEY;
  const server=createServer(secure?{key:fs.readFileSync(process.env.TLS_KEY),cert:fs.readFileSync(process.env.TLS_CERT)}:{});
  server.on('error',error=>{console.error('服务器启动失败：'+error.message);process.exitCode=1;});
  server.listen(port,host,()=>console.log('无人船监测平台：http'+(secure?'s':'')+'://'+host+':'+port+'（Ctrl+C 停止）'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
}
module.exports={createServer};
