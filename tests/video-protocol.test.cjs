'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decodeVideoDescriptor,readVideoConfig,getVideoContentSecurityPolicy}=require('../server/video-protocol');
const encode=value=>Buffer.from(JSON.stringify(value));

test('视频描述保留流地址及签名查询，支持HLS/FLV/native/auto并独立设置标题',()=>{
  for(const format of ['auto','hls','flv','native']){
    const value={version:1,url:'https://video.example.com/live/boat.m3u8?token=example&part=1',format,title:'船载摄像头'};
    assert.deepEqual(decodeVideoDescriptor(encode(value)),value);
  }
  assert.deepEqual(decodeVideoDescriptor(encode({version:1,url:'http://192.168.1.20:8080/live.flv',enabled:true})),
    {version:1,url:'http://192.168.1.20:8080/live.flv',format:'auto',title:''});
});

test('关闭消息只能显式清空配置，不能同时夹带地址或伪造字段',()=>{
  assert.deepEqual(decodeVideoDescriptor(encode({version:1,enabled:false})),{version:1,enabled:false});
  for(const value of [{version:1,enabled:false,url:'https://video.test/a'},
    {version:1,enabled:false,title:'旧画面'},{version:1,url:'https://video.test/a',password:'private'},
    {version:2,url:'https://video.test/a'},{version:1,url:'https://video.test/a',format:'rtsp'}])assert.equal(decodeVideoDescriptor(encode(value)),null);
});

test('拒绝脚本/RTSP/相对地址、账号密码、片段和控制字符，不接受URL解析器隐式改写',()=>{
  for(const url of ['javascript:alert(1)','data:video/mp4;base64,AA','rtsp://video.test/a','/live/a.m3u8',
    'https://user:secret@video.test/live','https://@video.test/live','https://video.test/live#key',
    'https://video.test/live#',' https://video.test/a','https://video.test/a\n',
    'https://video.test/a\r\nb','https://video.test\\@other.test/a','https://video.test/a\0']){
    assert.equal(decodeVideoDescriptor(encode({version:1,url})),null,url);
  }
});

test('视频消息限制UTF8、4096字节载荷、2048字符URL和64字标题',()=>{
  for(const payload of [Buffer.alloc(4097),Buffer.from('{'),Buffer.from([0xff]),Buffer.alloc(0),encode(null),encode([]),encode('https://video.test')])assert.equal(decodeVideoDescriptor(payload),null);
  assert.equal(decodeVideoDescriptor(encode({version:1,url:'https://video.test/'+'a'.repeat(2048)})),null);
  assert.equal(decodeVideoDescriptor(encode({version:1,url:'https://video.test/a',title:'船'.repeat(65)})),null);
  assert.equal(decodeVideoDescriptor(encode({version:1,url:'https://video.test/a',title:'船\n头'})),null);
  assert.ok(decodeVideoDescriptor(encode({version:1,url:'https://video.test/a',title:'🚢'.repeat(64)})));
});

test('视频来源配置为空仅允许同源，多个明确来源去重并保留端口',()=>{
  assert.deepEqual(readVideoConfig({}),{allowedOrigins:[]});
  assert.deepEqual(readVideoConfig({BOAT_VIDEO_ALLOWED_ORIGINS:'https://video.test, http://127.0.0.1:9000 https://video.test/'}),
    {allowedOrigins:['https://video.test','http://127.0.0.1:9000']});
});

test('视频来源不接受任意域名、路径、凭据、查询、CSP注入或超过16个来源',()=>{
  for(const value of ['*','https:','https://*.video.test','https://video.test/live',
    'https://user:secret@video.test','https://video.test?token=example',"https://video.test;script-src",'file:///tmp/video',
    Array.from({length:17},(_,i)=>'https://v'+i+'.test').join(',')]){
    assert.throws(()=>readVideoConfig({BOAT_VIDEO_ALLOWED_ORIGINS:value}),/BOAT_VIDEO_ALLOWED_ORIGINS/);
  }
});

test('视频CSP只扩展媒体和连接精确来源，不扩大脚本、图片或任意HTTP(S)访问',()=>{
  const base="default-src 'self'; script-src 'self' https://webapi.amap.com; connect-src 'self' https://restapi.amap.com; img-src 'self'; media-src 'none'";
  const result=getVideoContentSecurityPolicy(base,{BOAT_VIDEO_ALLOWED_ORIGINS:'https://video.test https://segments.test'});
  assert.match(result,/script-src 'self' https:\/\/webapi\.amap\.com;/);
  assert.match(result,/connect-src 'self' https:\/\/restapi\.amap\.com https:\/\/video\.test https:\/\/segments\.test;/);
  assert.match(result,/media-src 'self' blob: https:\/\/video\.test https:\/\/segments\.test$/);
  assert.equal((result.match(/media-src/g)||[]).length,1);
  assert.ok(!result.includes(' https: '));assert.ok(!result.includes(' http: '));
  assert.equal(getVideoContentSecurityPolicy("default-src 'self'",{}),"default-src 'self'; connect-src 'self'; media-src 'self' blob:");
});
