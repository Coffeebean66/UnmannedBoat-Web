/* Trusted smoke test, executed as an unprivileged build user with no real secrets. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
async function main(){
  const directory=path.resolve(process.argv[2]),commit=process.argv[3];
  if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Invalid commit');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  fs.writeFileSync(path.join(directory,'.boat-web-release.json'),JSON.stringify({commit,version:manifest.version}));
  const {createServer}=require(path.join(directory,'server.js'));
  const accountMode=process.argv.includes('--accounts'),origin='https://boat-update-check.invalid';
  const server=createServer({env:accountMode?{BOAT_ACCOUNTS_ENABLED:'1',BOAT_ACCOUNTS_ORIGIN:origin,BOAT_ADMIN_USERNAME:'check-admin',BOAT_ADMIN_PASSWORD:'check-admin-password',BOAT_GUEST_USERNAME:'check-guest',BOAT_GUEST_PASSWORD:'check-guest-password'}:{}});
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base='http://127.0.0.1:'+server.address().port;
    const response=await fetch(base+'/healthz',{signal:AbortSignal.timeout(5000)}),health=await response.json();
    if(!response.ok||health.ok!==true||health.app!=='unmanned-boat-web'||health.apiVersion!==1||health.commit!==commit)throw Error('Release health contract is unsupported');
    const config=await fetch(base+'/api/update/config',{signal:AbortSignal.timeout(5000)});
    const state=await config.json();
    if(!config.ok||state.apiVersion!==1||state.enabled!==false)throw Error('Release update API contract is unsupported');
    if(accountMode){
      const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'check-admin',password:'check-admin-password'}),signal:AbortSignal.timeout(5000)});
      const account=await login.json();
      if(!login.ok||account.user?.role!=='admin'||!login.headers.get('set-cookie'))throw Error('Release account API contract is unsupported');
    }
    const index=await fetch(base+'/',{signal:AbortSignal.timeout(5000)});
    if(!index.ok||!(await index.text()).includes('<html'))throw Error('Missing application page');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
main().then(()=>process.exit(0)).catch(error=>{console.error('Candidate validation failed: '+error.message);process.exit(1);});
