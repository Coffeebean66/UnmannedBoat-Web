/* 为已有受管理 MQTT 账号增加参数/OTA/驾驶主题；保留密码和无关 ACL，并留下恢复副本。 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function configureParameterAcl(file,envFile){
  for(const name of [file,envFile])if(!fs.lstatSync(name).isFile())throw Error('Invalid managed MQTT configuration');
  const env=Object.fromEntries(fs.readFileSync(envFile,'utf8').split(/\r?\n/).filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const p=line.indexOf('=');return[line.slice(0,p),line.slice(p+1)];}));
  const bridge=env.BOAT_MQTT_USERNAME,prefix=env.BOAT_MQTT_TOPIC_PREFIX||'boats';
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(bridge||'')||!/^[A-Za-z0-9_-]{1,64}$/.test(prefix))throw Error('Invalid managed bridge username or topic prefix');
  const old=fs.readFileSync(file,'utf8'),blocks=old.split(/(?=^user[ \t]+)/m);let devices=0,bridges=0;
  const next=blocks.map(block=>{
    const user=block.match(/^user[ \t]+([A-Za-z0-9_-]{1,64})[ \t\r]*$/m)?.[1];if(!user)return block;
    const add=[],lines=new Set(block.split(/\r?\n/).map(line=>line.trim()));
    if(user===bridge){bridges++;add.push('topic write '+prefix+'/+/parameter-command','topic read '+prefix+'/+/parameter-response','topic read '+prefix+'/+/parameter-capability',
      'topic write '+prefix+'/+/firmware-command','topic read '+prefix+'/+/firmware-response','topic read '+prefix+'/+/firmware-capability',
      'topic write '+prefix+'/+/control-command','topic read '+prefix+'/+/control-state','topic read '+prefix+'/+/control-capability');}
    else {
      const id=block.match(new RegExp('^topic write '+prefix+'/([A-Za-z0-9_-]{1,64})/telemetry[ \\t\\r]*$','m'))?.[1];
      if(id&&lines.has('topic write '+prefix+'/'+id+'/status')){
        devices++;add.push('topic read '+prefix+'/'+id+'/parameter-command','topic write '+prefix+'/'+id+'/parameter-response','topic write '+prefix+'/'+id+'/parameter-capability',
          'topic read '+prefix+'/'+id+'/firmware-command','topic write '+prefix+'/'+id+'/firmware-response','topic write '+prefix+'/'+id+'/firmware-capability',
          'topic read '+prefix+'/'+id+'/control-command','topic write '+prefix+'/'+id+'/control-state','topic write '+prefix+'/'+id+'/control-capability');
      }
    }
    const missing=add.filter(line=>!lines.has(line));
    return missing.length?block.trimEnd()+'\n'+missing.join('\n')+'\n\n':block;
  }).join('');
  if(bridges!==1||!devices)throw Error('Managed device or bridge ACL block is missing or ambiguous');
  if(next===old)return false;
  const suffix=crypto.randomBytes(6).toString('hex'),backup=path.join(path.dirname(file),'acl.before-parameters-'+suffix),temporary=file+'.parameters-'+suffix;
  fs.writeFileSync(backup,old,{flag:'wx',mode:0o600});const stat=fs.statSync(file);
  try{
    fs.writeFileSync(temporary,next,{flag:'wx',mode:0o640});
    fs.chownSync(temporary,stat.uid,stat.gid);fs.chmodSync(temporary,0o640);fs.renameSync(temporary,file);
  }catch(error){try{fs.unlinkSync(temporary);}catch(_){}throw error;}
  return true;
}
if(require.main===module){try{if(process.argv.length!==4)throw Error('Usage: configure-parameter-acl.cjs <acl> <runtime.env>');process.stdout.write(configureParameterAcl(process.argv[2],process.argv[3])?'1':'0');}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={configureParameterAcl};
