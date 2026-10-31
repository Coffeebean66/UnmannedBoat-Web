/* 航线查询供已登录账户使用，保存/启动/停止仅允许同源管理员。 */
'use strict';
const {MissionStore,fault,ID}=require('./mission-store');
const {MissionService}=require('./mission-service');
const {readJson}=require('./control-api');
const {DEVICE}=require('./control-service');
function createMissionApi({bridge,control,accounts,env=process.env,store,service,storeOptions={},serviceOptions={}}={}){
  const library=store||new MissionStore({env,...storeOptions}),manager=service||new MissionService({bridge,control,store:library,...serviceOptions});let closed=false;
  const json=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  function authorize(req,res,session,write){
    if(closed||!accounts?.enabled)throw fault(503,'航线任务需要启用平台账户登录');
    if(!session||!accounts.isActive(session)||req.aborted||res.destroyed)throw fault(401,'请先登录监测平台');
    if(write&&session.value.role!=='admin')throw fault(403,'仅管理员可以编辑或执行航线任务');
    const browserRead=!write&&!req.headers.origin&&(!req.headers['sec-fetch-site']||req.headers['sec-fetch-site']==='same-origin');
    if(!browserRead&&!accounts.sameOrigin(req))throw fault(403,'请从本站操作航线任务');
  }
  return {manager,store:library,close(){if(closed)return;closed=true;manager.close();},async handle(req,res,url){
    if(!['/api/missions','/api/missions/route','/api/missions/run'].includes(url.pathname))return false;
    try{
      const session=accounts?.sessionFor?.(req),read=req.method==='GET';authorize(req,res,session,!read);
      if(read&&url.pathname==='/api/missions'){
        const id=url.searchParams.get('deviceId')||'';
        if(id&&!DEVICE.test(id)||[...url.searchParams.keys()].some(k=>k!=='deviceId')||url.searchParams.getAll('deviceId').length>1)throw fault(400,'无人船标识不正确');
        let position=null;try{position=require('./mission-service').feedback(bridge,id,manager.now());}catch(_){/* 无定位仍可规划。 */}
        json(res,200,{routes:id?library.list(id):[],runs:manager.list(),storageError:library.error,position});return true;
      }
      if(!['POST','DELETE'].includes(req.method)||url.search)throw fault(405,'任务接口方法不正确');
      const input=await readJson(req,40000);authorize(req,res,session,true);
      const fields=url.pathname==='/api/missions/route'?['deviceId','route','id','revision']:['deviceId','routeId','action','runId','revision'];
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))||!DEVICE.test(input.deviceId||''))throw fault(400,'任务请求字段不正确');
      const id=input.deviceId;
      if(url.pathname==='/api/missions/route'){
        const running=manager.jobs.get(id);
        if(manager.active(id)&&running.route.id===input.id)throw fault(409,'请先停止正在使用此航线的任务');
        if(req.method==='DELETE'){
          if(input.route!==undefined)throw fault(400,'删除请求不能包含航线内容');
          library.delete(id,input.id,input.revision,()=>authorize(req,res,session,true));json(res,200,{deleted:true});
        }else json(res,200,{route:library.save(id,input.route,input.id,input.revision,()=>authorize(req,res,session,true))});
      }else if(url.pathname==='/api/missions/run'&&req.method==='POST'){
        if(input.action==='stop'){
          if(!ID.test(input.runId||'')||manager.jobs.get(id)?.runId!==input.runId)throw fault(409,'任务已变化，请刷新后停止当前任务');
          if(input.routeId!==undefined||input.revision!==undefined)throw fault(400,'停止请求不能包含航线');
          json(res,202,{run:manager.stop(id)});
        }else{
          if(input.runId!==undefined||!ID.test(input.routeId||'')||!Number.isSafeInteger(input.revision)||input.revision<1)throw fault(400,'请先保存并选择当前无人船的航线');
          json(res,202,{run:manager.start(id,input.routeId,input.action,input.revision)});
        }
      }else throw fault(405,'任务接口方法不正确');
    }catch(error){req.resume();json(res,error.status||503,{error:error.status?error.message:'任务服务或航线文件不可用，请检查服务器存储权限'});}
    return true;
  }};
}
module.exports={createMissionApi};
