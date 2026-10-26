'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createServer}=require('../server');
const {readMapConfig,MAP_CONTENT_SECURITY_POLICY}=require('../server/map-config');
const {getVideoContentSecurityPolicy}=require('../server/video-protocol');
const KEY='0123456789abcdef0123456789abcdef',CODE='fedcba9876543210fedcba9876543210';

async function fixture(t,env={}){
  const server=createServer({env});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return (path,method='GET')=>new Promise((resolve,reject)=>{
    http.request({hostname:'127.0.0.1',port:server.address().port,path,method},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const body=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(body);}catch(_){}
        resolve({status:res.statusCode,headers:res.headers,body,json});
      });
    }).on('error',reject).end();
  });
}

test('高德配置缺失时明确说明缺项，同时服务和其他仪表资源可用',async t=>{
  const request=await fixture(t);
  const response=await request('/api/map/config');
  assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
  assert.deepEqual({...response.json,reason:''},{provider:'amap',version:'2.0',enabled:false,configured:false,key:'',securityJsCode:'',reason:''});
  assert.match(response.json.reason,/BOAT_AMAP_KEY/);assert.match(response.json.reason,/BOAT_AMAP_SECURITY_CODE/);
  assert.equal((await request('/healthz')).json.ok,true);assert.equal((await request('/app.js')).status,200);
  const partial=readMapConfig({BOAT_AMAP_KEY:KEY});assert.equal(partial.key,'');assert.match(partial.reason,/BOAT_AMAP_SECURITY_CODE/);
});

test('高德浏览器配置仅来自对应环境变量，不暴露账户或 MQTT 密码',async t=>{
  const request=await fixture(t,{BOAT_AMAP_KEY:KEY,BOAT_AMAP_SECURITY_CODE:CODE,BOAT_MQTT_PASSWORD:'fixture-private-password',BOAT_ADMIN_PASSWORD:'fixture-admin-password'});
  const response=await request('/api/map/config');
  assert.deepEqual(response.json,{provider:'amap',version:'2.0',enabled:true,configured:true,key:KEY,securityJsCode:CODE,reason:''});
  assert.doesNotMatch(response.body,/fixture-private|fixture-admin|PASSWORD/);
  const head=await request('/api/map/config','HEAD');assert.equal(head.status,200);assert.equal(head.body,'');
});

test('非法配置不能启用地图或将任意内容注入 SDK 地址',()=>{
  for(const value of ['https://evil.test/loader.js',KEY+'?callback=evil','<script>alert(1)</script>','x'.repeat(4096),'']){
    for(const env of [{BOAT_AMAP_KEY:value,BOAT_AMAP_SECURITY_CODE:CODE},{BOAT_AMAP_KEY:KEY,BOAT_AMAP_SECURITY_CODE:value}]){
      const config=readMapConfig(env);assert.equal(config.enabled,false);assert.equal(config.key,'');assert.equal(config.securityJsCode,'');
      assert.equal(config.reason.includes(value)&&value.length>0,false);
    }
  }
  assert.equal(readMapConfig({BOAT_AMAP_KEY:' '+KEY+' ',BOAT_AMAP_SECURITY_CODE:' '+CODE+' '}).configured,true);
});

test('地图 API 是只读配置入口，没有任意 URL 转发或修改接口',async t=>{
  const request=await fixture(t,{BOAT_AMAP_KEY:KEY,BOAT_AMAP_SECURITY_CODE:CODE});
  const response=await request('/api/map/config?url=http%3A%2F%2F127.0.0.1%2Fprivate&key=override');
  assert.equal(response.json.key,KEY);assert.equal(response.json.securityJsCode,CODE);
  const post=await request('/api/map/config','POST');assert.equal(post.status,405);assert.equal(post.headers.allow,'GET, HEAD');
  assert.equal((await request('/api/map/proxy?url=https://evil.test')).status,404);
});

test('CSP 兼容真实高德 SDK 初始化，同时限制外部资源、内联事件和站点边界',async t=>{
  const request=await fixture(t);const response=await request('/');
  assert.equal(response.headers['content-security-policy'],getVideoContentSecurityPolicy(MAP_CONTENT_SECURITY_POLICY,{}));
  const directives=new Map(MAP_CONTENT_SECURITY_POLICY.split('; ').map(value=>{const [name,...sources]=value.split(' ');return [name,sources];}));
  // 真实 SDK 的 WebGL/WASM 初始化、尺寸检测和 JSONP 均需要这些能力；
  // 仅能构造 AMap.Map 的模拟 SDK 不足以覆盖原来的空白底图故障。
  const scripts=directives.get('script-src');
  for(const source of ["'unsafe-inline'","'unsafe-eval'","'wasm-unsafe-eval'",'https://webapi.amap.com','https://restapi.amap.com','https://mapplugin.amap.com'])assert.ok(scripts.includes(source),source);
  assert.equal(directives.has('script-src-elem'),false,'script elements must inherit the compatible script-src policy');
  assert.deepEqual(directives.get('script-src-attr'),["'none'"],'SDK compatibility must not enable HTML event attributes');
  assert.ok(directives.get('connect-src').includes('https://jsapi.amap.com'));
  for(const source of ['https://o4.amap.com','https://custyle.amap.com','https://mapplugin.amap.com',...[1,2,3,4,5].map(shard=>'https://jsapi-data'+shard+'.amap.com')])assert.ok(directives.get('connect-src').includes(source),source);
  assert.ok(directives.get('connect-src').includes('https://vdata.amap.com'));
  assert.ok(directives.get('img-src').includes('https://webrd01.is.autonavi.com'));
  assert.ok(directives.get('img-src').includes('https://tile.openstreetmap.org'));
  assert.ok(directives.get('img-src').includes('https://o4.amap.com'),'the SDK loads its sprite sheets as images as well as its style over XHR');
  assert.deepEqual(directives.get('worker-src'),["'self'",'blob:']);
  assert.deepEqual(directives.get('frame-ancestors'),["'none'"]);
  assert.deepEqual(directives.get('object-src'),["'none'"]);
  assert.deepEqual(directives.get('base-uri'),["'self'"]);
  assert.deepEqual(directives.get('default-src'),["'self'"]);
  assert.doesNotMatch(MAP_CONTENT_SECURITY_POLICY,/\*/);
  for(const sources of directives.values())assert.equal(sources.includes('https:'),false,'no unrestricted HTTPS source');
  assert.deepEqual(scripts.filter(source=>source.startsWith('http')),['https://webapi.amap.com','https://a.amap.com','https://restapi.amap.com','https://mapplugin.amap.com']);
  for(const source of ['blob:','data:','https://evil.test'])assert.equal(scripts.includes(source),false,source);
});

test('服务器CSP仅向媒体与连接放行已配置视频来源，页面和API返回一致策略',async t=>{
  const request=await fixture(t,{BOAT_VIDEO_ALLOWED_ORIGINS:'https://video.test http://127.0.0.1:9000'});
  const page=await request('/'),api=await request('/api/cloud/config');
  assert.equal(page.headers['content-security-policy'],api.headers['content-security-policy']);
  const policy=new Map(page.headers['content-security-policy'].split('; ').map(value=>{const [key,...sources]=value.split(' ');return [key,sources];}));
  assert.deepEqual(policy.get('media-src'),["'self'",'blob:','https://video.test','http://127.0.0.1:9000']);
  for(const origin of ['https://video.test','http://127.0.0.1:9000']){
    assert.ok(policy.get('connect-src').includes(origin));
    for(const directive of ['script-src','img-src','style-src'])assert.ok(!policy.get(directive).includes(origin));
  }
  assert.doesNotMatch(page.headers['content-security-policy'],/\*/);
  assert.throws(()=>createServer({env:{BOAT_VIDEO_ALLOWED_ORIGINS:'https://video.test; script-src https:'}}),/BOAT_VIDEO_ALLOWED_ORIGINS/);
});
