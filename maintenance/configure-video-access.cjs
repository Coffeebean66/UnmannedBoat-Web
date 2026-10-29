/* root 读取私密 JSON，一次配置视频发布账号、主题权限及 Broker 报文上限。 */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createMqttDeviceManager,validateVideoInput}=require('./mqtt-device-worker.cjs');
const USAGE='Usage: sudo node maintenance/configure-video-access.cjs --config /root/video-access.json [--config-dir /etc/unmanned-boat-web]';
function parseArguments(argv){
  const result={configDir:'/etc/unmanned-boat-web'};const seen=new Set();
  for(let i=0;i<argv.length;i+=2){
    const option=argv[i],value=argv[i+1];
    if(!['--config','--config-dir'].includes(option)||seen.has(option)||typeof value!=='string'||!value||value.startsWith('--'))throw Error(USAGE);
    seen.add(option);result[option==='--config'?'configFile':'configDir']=path.resolve(value);
  }
  if(!result.configFile)throw Error(USAGE);
  return result;
}
async function readPrivateConfiguration(file,{ownership=true}={}){
  const before=await fs.promises.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>2048||ownership&&(before.uid!==0||(before.mode&0o077)!==0))throw Error('视频账号 JSON 必须为 root 所有、权限 600 的普通私密文件');
  const handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const opened=await handle.stat();
    if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw Error('视频账号配置在读取时发生变化，请重试');
    let value;try{value=JSON.parse(await handle.readFile('utf8'));}catch(_){throw Error('视频账号 JSON 格式无效');}
    validateVideoInput(value);return value;
  }finally{await handle.close();}
}
async function configureFromFile({configFile,configDir},{ownership=true,createManager=createMqttDeviceManager}={}){
  const value=await readPrivateConfiguration(configFile,{ownership});
  const manager=createManager({configDir});
  return manager.configureVideo(value);
}
async function main(argv=process.argv.slice(2)){
  if(process.getuid?.()!==0)throw Error('视频 MQTT 接入配置必须在 Linux 服务器由 root 执行');
  const options=parseArguments(argv),result=await configureFromFile(options);
  process.stdout.write(JSON.stringify({ok:true,...result.video,requiresReconnect:result.requiresReconnect})+'\n');
}
if(require.main===module)main().catch(error=>{
  // 不输出 JSON 内容、工具参数或第三方异常，避免错误路径泄露密码。
  const safe=error.status||error.message===USAGE||/^(视频|MQTT)/.test(error.message||'');
  console.error(safe?error.message:'视频 MQTT 接入配置失败，请检查受管理部署及私密文件权限');process.exitCode=1;
});
module.exports={parseArguments,readPrivateConfiguration,configureFromFile,main};
