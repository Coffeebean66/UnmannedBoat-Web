/* 用实际 WebGL 船模生成透明缩略图；临时本地服务与 Chrome 在完成后退出。 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const server = http.createServer((request, response) => {
    const file = request.url === '/bundle.js' ? path.join(root, 'public/utils-bundle.js') :
      request.url === '/boat.glb' ? path.join(root, 'public/assets/boat_jnu_motors_v6.glb') : null;
    if (file) { response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'model/gltf-binary'); response.end(fs.readFileSync(file)); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body style="margin:0;background:transparent"><canvas id="preview" width="2560" height="1120"></canvas><script src="/bundle.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const outputDirectory = path.join(root, '.test-output');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const profile = fs.mkdtempSync(path.join(outputDirectory, 'chrome-thumbnail-'));
  const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--user-data-dir=' + profile
  ], { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data), item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => reject(Error('CDP timeout ' + method)), 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
      return value.result.value;
    };
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    for (let i = 0; i < 100 && !await evaluate('!!window.BoatModules'); i++) await wait(50);
    const result = await evaluate(`(async()=>{
      const model = BoatModules.glbModel.parseGlb(await (await fetch('/boat.glb')).arrayBuffer());
      const canvas = document.getElementById('preview');
      const getContext = canvas.getContext.bind(canvas);
      canvas.getContext = (kind, options) => getContext(kind, {...options, alpha:true, preserveDrawingBuffer:true});
      const renderer = new BoatModules.boatRenderer.BoatRenderer(canvas, model);
      renderer.gl.clearColor(0, 0, 0, 0);
      renderer.gridCount = 0;
      renderer.cameraYaw = ${Number(process.argv[2] || 125)};
      renderer.cameraPitch = ${Number(process.argv[3] || 20)};
      renderer.draw([0,0,0,1], {waterEnabled:false});
      window.previewRenderer = renderer;
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(canvas,0,0);
      const pixels = ctx.getImageData(0,0,copy.width,copy.height).data;
      let minX=copy.width,minY=copy.height,maxX=0,maxY=0;
      for(let y=0;y<copy.height;y++)for(let x=0;x<copy.width;x++)if(pixels[(y*copy.width+x)*4+3]>4){
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      }
      const output = document.createElement('canvas'); output.width=640;output.height=280;
      const context = output.getContext('2d'), w=maxX-minX+1,h=maxY-minY+1;
      const scale=Math.min(595/w,255/h);
      context.drawImage(copy,minX,minY,w,h,(640-w*scale)/2,(280-h*scale)/2,w*scale,h*scale);
      return {png:output.toDataURL('image/png'), primitives:model.primitives.length};
    })()`);
    const output = path.resolve(root, process.argv[4] || 'public/assets/boat-jnu-preview.png');
    fs.writeFileSync(output, Buffer.from(result.png.split(',')[1], 'base64'));
    console.log(JSON.stringify({ output, primitives: result.primitives }));
  } finally { socket?.close(); browser.kill(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
