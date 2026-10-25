/* Trusted smoke test, executed as an unprivileged build user with no real secrets. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
async function main(){
  const directory=path.resolve(process.argv[2]),commit=process.argv[3];
  if(!/^[0-9a-f]{40}$/.test(commit||''))throw Error('Invalid commit');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  fs.writeFileSync(path.join(directory,'.boat-web-release.json'),JSON.stringify({commit,version:manifest.version}));
  const {createServer}=require(path.join(directory,'server.js'));
  const managed=process.argv.includes('--managed-accounts'),accountMode=managed||process.argv.includes('--accounts'),origin='https://boat-update-check.invalid';
  // Candidate code must never find an operator's actual account database.
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'boat-account-check-'));
  const env=accountMode?{BOAT_ACCOUNTS_ENABLED:'1',BOAT_ACCOUNTS_ORIGIN:origin,BOAT_ADMIN_USERNAME:'check-admin',BOAT_ADMIN_PASSWORD:'check-admin-password',BOAT_GUEST_USERNAME:'check-guest',BOAT_GUEST_PASSWORD:'check-guest-password',BOAT_ACCOUNTS_FILE:path.join(temporary,'accounts.json')}:{};
  let server;
  const boot=async()=>{server=createServer({env});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return 'http://127.0.0.1:'+server.address().port;};
  const close=async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));};
  try{
    let base=await boot();
    const request=(route,options={})=>fetch(base+route,{...options,signal:AbortSignal.timeout(5000)});
    const response=await request('/healthz'),health=await response.json();
    if(!response.ok||health.ok!==true||health.app!=='unmanned-boat-web'||health.apiVersion!==1||health.commit!==commit)throw Error('Release health contract is unsupported');
    const config=await request('/api/update/config');
    const state=await config.json();
    if(!config.ok||state.apiVersion!==1||state.enabled!==false)throw Error('Release update API contract is unsupported');
    const login=async(username,password)=>{
      const response=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username,password})});
      return {response,account:await response.json(),cookie:(response.headers.get('set-cookie')||'').split(';')[0]};
    };
    if(accountMode){
      const result=await login('check-admin','check-admin-password');
      if(!result.response.ok||result.account.user?.role!=='admin'||!result.cookie)throw Error('Release account API contract is unsupported');
      if(managed){
        if(health.readiness?.accountManagement!==1)throw Error('Release managed account readiness is unsupported');
        const headers={Cookie:result.cookie,Origin:origin,'Content-Type':'application/json'};
        const users=await request('/api/auth/users',{headers}),list=await users.json();
        if(!users.ok||!Array.isArray(list.users)||typeof list.currentUserId!=='string')throw Error('Release user management API is unsupported');
        const created=await request('/api/auth/users',{method:'POST',headers,body:JSON.stringify({username:'check-member',password:'member-check-password',role:'guest'})});
        if(!created.ok||(await created.json()).ok!==true)throw Error('Release cannot create accounts');
        const changed=await request('/api/auth/users/'+encodeURIComponent(list.currentUserId),{method:'PATCH',headers,body:JSON.stringify({username:'renamed-check-admin',password:'renamed-check-password',role:'admin'})});
        if(!changed.ok||(await changed.json()).reauthenticate!==true)throw Error('Release cannot update accounts');
        await close();base=await boot();
        const old=await login('check-admin','check-admin-password'),renamed=await login('renamed-check-admin','renamed-check-password'),member=await login('check-member','member-check-password');
        if(old.response.status!==401||!renamed.response.ok||renamed.account.user?.role!=='admin'||!member.response.ok||member.account.user?.role!=='guest')throw Error('Release does not preserve managed accounts across restart');
      }
    }
    const index=await request('/');
    if(!index.ok||!(await index.text()).includes('<html'))throw Error('Missing application page');
  }finally{await close();fs.rmSync(temporary,{recursive:true,force:true});}
}
main().then(()=>process.exit(0)).catch(error=>{console.error('Candidate validation failed: '+error.message);process.exit(1);});
