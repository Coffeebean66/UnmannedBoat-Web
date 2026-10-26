/* 船队总览只显示概况，不把其他船的数据注入当前单船仪表或调参对象。 */
(function(scope){
  'use strict';
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const modes={0:'PWM 开环',1:'船速闭环',2:'航向闭环'};
  const idPattern=/^[A-Za-z0-9_-]{1,64}$/;

  // 后台为每种测量携带独立失效时间；新遥测不能让失效定位/航向重新变为有效。
  function prepareDevice(device,{now=Date.now(),brokerConnected=false,streamConnected=false}={}){
    const online=!!(brokerConnected&&streamConnected&&device.online===true),summary=device.summary;
    const sourceFresh=online&&summary&&finite(summary.receivedAt)&&now-summary.receivedAt>=-1000&&now-summary.receivedAt<1000;
    const fresh=key=>!!(sourceFresh&&finite(summary.validUntil?.[key])&&summary.validUntil[key]>now);
    const value=(key,min=-Infinity,max=Infinity)=>fresh(key)&&finite(summary[key])&&summary[key]>=min&&summary[key]<=max?summary[key]:null;
    const speed=value('speedMps',0,100),target=value('targetSpeedMps',-100,100),heading=value('headingDegrees',0,360),voltage=value('voltageV',0,1000);
    const fix=!!(fresh('position')&&finite(summary.latitude)&&finite(summary.longitude)&&Math.abs(summary.latitude)<=90&&Math.abs(summary.longitude)<=180);
    const age=finite(device.lastReceivedAt)?Math.max(0,now-device.lastReceivedAt):null;
    const seconds=age===null?null:Math.floor(age/1000);
    const ageText=seconds===null?'尚无遥测':seconds<1?'刚刚更新':seconds<60?seconds+' 秒前':seconds<3600?Math.floor(seconds/60)+' 分钟前':seconds<86400?Math.floor(seconds/3600)+' 小时前':Math.floor(seconds/86400)+' 天前';
    return {id:device.id,online,moving:speed!==null&&speed>=.1,speed:speed===null?'--':speed.toFixed(2),target:target===null?'--':target.toFixed(2),
      heading:heading===null?'--':heading.toFixed(1),voltage:voltage===null?'--':voltage.toFixed(1),
      mode:fresh('controlMode')&&Object.hasOwn(modes,summary.controlMode)?modes[summary.controlMode]:'--',
      latitude:fix?summary.latitude.toFixed(6):'--',longitude:fix?summary.longitude.toFixed(6):'--',fix,ageText,
      status:!streamConnected?'通道未连接':!brokerConnected?'云端断开':!online?'已离线':!sourceFresh?'等待新数据':'实时在线'};
  }

  class BoatFleetView{
    constructor({onSelect=()=>{},document=scope.document,now=Date.now,setInterval=scope.setInterval.bind(scope),clearInterval=scope.clearInterval.bind(scope)}={}){
      this.document=document;this.onSelect=onSelect;this.now=now;this.clearInterval=clearInterval;this.cards=new Map();this.recentRows=new Map();this.destroyed=false;
      this.state={devices:[],brokerConnected:false,streamConnected:false,authenticated:false,enabled:true,selectedId:'',serverOffset:0};
      this.nodes=Object.fromEntries(['fleetTotal','fleetOnline','fleetOffline','fleetMoving','fleetVisibleCount','fleetStreamState','fleetSearch','fleetFilter','fleetCards','fleetEmpty','fleetEmptyTitle','fleetEmptyDescription','fleetRecentList','fleetRecentSummary','fleetRecentEmpty'].map(id=>[id,document.getElementById(id)]));
      this.onSearch=()=>this.render();this.nodes.fleetSearch?.addEventListener('input',this.onSearch);this.nodes.fleetFilter?.addEventListener('change',this.onSearch);
      this.timer=setInterval(()=>{if(!this.document.hidden)this.render();},500);
      this.render();
    }
    update(state){
      if(this.destroyed)return;
      this.state={...this.state,...state};
      if(this.state.authenticated===false)this.state.devices=[];
      this.render();
    }
    set(id,text){const node=this.nodes[id];if(node&&node.textContent!==String(text))node.textContent=String(text);}
    make(tag,className,text,parent){const element=this.document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;parent?.append(element);return element;}
    createCard(id){
      const article=this.make('article','fleet-card'),header=this.make('div','fleet-card-heading',undefined,article);
      const identity=this.make('div','fleet-card-identity',undefined,header),title=this.make('h3','',id,identity);title.title='MQTT 设备 ID：'+id;
      const status=this.make('span','fleet-card-status','',header);
      const facts=this.make('dl','fleet-card-facts',undefined,article),data={};
      for(const [key,label,unit]of [['latitude','纬度','°'],['longitude','经度','°'],['heading','船头航向','°'],['speed','实际速度',' m/s'],['voltage','电压',' V'],['mode','控制模式','']]){
        const line=this.make('div','',undefined,facts);this.make('dt','',label,line);const value=this.make('dd','',undefined,line);data[key]=this.make('b','','--',value);if(unit)this.make('span','',unit,value);
      }
      const footer=this.make('div','fleet-card-footer',undefined,article),update=this.make('div','fleet-card-update',undefined,footer),fix=this.make('span','fleet-card-fix','等待定位',update),age=this.make('span','fleet-card-age','尚无遥测',update);
      const actions=this.make('div','fleet-card-actions',undefined,footer),targetLine=this.make('span','fleet-target',undefined,actions);this.make('span','','目标 ',targetLine);const target=this.make('b','','--',targetLine);this.make('span','',' m/s',targetLine);
      const button=this.make('button','fleet-detail-button','查看详情',actions);
      button.type='button';button.setAttribute('aria-label','查看 '+id+' 的详细数据');button.addEventListener('click',()=>this.onSelect(id));
      article.dataset.deviceId=id;
      return {article,title,status,target,...data,fix,age,button};
    }
    createRecentRow(id){
      const element=this.make('button','fleet-recent-row',undefined),name=this.make('strong','',id,element),status=this.make('span','fleet-recent-status','',element),age=this.make('small','',undefined,element);
      element.type='button';element.setAttribute('aria-label','查看 '+id+' 的实时状态');element.addEventListener('click',()=>this.onSelect(id));
      return {element,name,status,age};
    }
    renderRecent(devices,values){
      const list=this.nodes.fleetRecentList;if(!list)return;
      const rows=devices.map((device,index)=>({device,value:values[index]}))
        .filter(item=>finite(item.device.lastReceivedAt)).sort((a,b)=>b.device.lastReceivedAt-a.device.lastReceivedAt).slice(0,5),active=new Set();
      rows.forEach(({device,value})=>{
        active.add(device.id);let row=this.recentRows.get(device.id);
        if(!row){row=this.createRecentRow(device.id);this.recentRows.set(device.id,row);}
        row.element.dataset.online=String(value.online);row.element.dataset.selected=String(this.state.selectedId===device.id);
        row.status.textContent=value.online?'在线':device.online?'数据暂不可用':'离线';
        row.age.textContent=value.ageText==='尚无遥测'?'最近更新未知':'最近更新 '+value.ageText;
        list.append(row.element);
      });
      for(const [id,row]of this.recentRows)if(!active.has(id)){row.element.remove();this.recentRows.delete(id);}
      if(this.nodes.fleetRecentEmpty)this.nodes.fleetRecentEmpty.hidden=rows.length>0;
      this.set('fleetRecentSummary',rows.length?rows.length+' 艘有上报记录':'等待船端数据');
    }
    render(){
      if(this.destroyed||!this.nodes.fleetCards)return;
      const state=this.state,now=this.now()+(finite(state.serverOffset)?state.serverOffset:0),seen=new Set();
      const devices=(Array.isArray(state.devices)?state.devices:[]).filter(device=>device&&idPattern.test(device.id)&&!seen.has(device.id)&&seen.add(device.id)).slice(0,64);
      const ready=state.authenticated===true&&state.enabled!==false;
      const values=devices.map(device=>prepareDevice(device,{now,brokerConnected:ready&&state.brokerConnected,streamConnected:ready&&state.streamConnected}));
      const online=values.filter(device=>device.online).length;
      this.set('fleetTotal',values.length);this.set('fleetOnline',online);this.set('fleetOffline',values.length-online);this.set('fleetMoving',values.filter(device=>device.moving).length);
      const streamState=!ready?(state.enabled===false?'服务器尚未启用 MQTT':'登录后监测整支船队'):!state.streamConnected?(state.message||'船队通道正在连接'):!state.brokerConnected?'服务器与 MQTT 连接中断':'正在监测 '+values.length+' 艘无人船';
      this.set('fleetStreamState',streamState);this.nodes.fleetStreamState.dataset.tone=ready&&state.streamConnected&&state.brokerConnected?'success':'warning';
      const search=(this.nodes.fleetSearch?.value||'').trim().toLowerCase(),filter=this.nodes.fleetFilter?.value||'all';
      let visible=0;
      for(const value of values){
        let card=this.cards.get(value.id);if(!card){card=this.createCard(value.id);this.cards.set(value.id,card);this.nodes.fleetCards.append(card.article);}
        card.article.hidden=!!(search&&!value.id.toLowerCase().includes(search)||filter==='online'&&!value.online||filter==='offline'&&value.online);
        if(!card.article.hidden)visible++;
        card.article.dataset.online=String(value.online);card.article.dataset.selected=String(state.selectedId===value.id);
        for(const key of ['status','speed','target','heading','voltage','mode','latitude','longitude','age']){const text=key==='age'?value.ageText:value[key];if(card[key].textContent!==text)card[key].textContent=text;}
        card.fix.textContent=value.fix?'定位有效':'暂无定位';card.fix.dataset.valid=String(value.fix);
        card.button.textContent=state.selectedId===value.id?'当前船舶':'查看详情';
      }
      const activeIds=new Set(values.map(device=>device.id));
      for(const [id,card]of this.cards)if(!activeIds.has(id)){card.article.remove();this.cards.delete(id);}
      this.set('fleetVisibleCount',visible+' 艘 / 共 '+values.length+' 艘');this.nodes.fleetEmpty.hidden=visible>0;
      this.renderRecent(devices,values);
      this.set('fleetEmptyTitle',!ready?(state.enabled===false?'MQTT 监测尚未启用':'登录后查看船队'):values.length?'没有匹配的无人船':'等待无人船接入');
      this.set('fleetEmptyDescription',!ready?(state.enabled===false?'请管理员在服务器上启用 MQTT 云端服务。':'管理员和访客登录后均可查看所有已接入无人船。'):values.length?'请调整搜索关键词或在线状态筛选。':'为每艘船配置独立设备 ID 与 MQTT 账号，收到数据后会自动出现在此处。');
    }
    destroy(){if(this.destroyed)return;this.destroyed=true;this.clearInterval(this.timer);this.nodes.fleetSearch?.removeEventListener('input',this.onSearch);this.nodes.fleetFilter?.removeEventListener('change',this.onSearch);this.cards.clear();this.recentRows.clear();}
  }
  BoatFleetView.prepareDevice=prepareDevice;
  scope.BoatFleetView=BoatFleetView;
})(window);
