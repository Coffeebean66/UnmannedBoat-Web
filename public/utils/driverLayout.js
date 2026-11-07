/* 云端只接受驾驶显示偏好；不允许混入驾驶模式、接管凭据或任意 CSS。 */
'use strict';
const PROFILE_KEYS=Object.freeze(['desktop:dock','desktop:video','desktop:map','mobile:dock','mobile:video','mobile:map']);
const PART_IDS=Object.freeze(['navigation','hud','angles','horizon','compass','map','video','console','mission','details','motors','model','emergency']);
const SIZE_MAX=16384;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const opacityMin=id=>id==='emergency'?100:id==='console'?20:0;
const allowed=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
function normalizeProfiles(input){
  const profiles={};
  if(!object(input))return profiles;
  for(const key of PROFILE_KEYS){
    if(!Object.hasOwn(input,key)||!object(input[key]))continue;
    const profile=profiles[key]={};
    for(const id of PART_IDS){
      if(!Object.hasOwn(input[key],id)||!object(input[key][id]))continue;
      const source=input[key][id],entry=profile[id]={};
      if(finite(source.opacity))entry.opacity=clamp(source.opacity,opacityMin(id),100);
      if(finite(source.x)&&finite(source.y)){entry.x=clamp(source.x,0,1);entry.y=clamp(source.y,0,1);}
      if(['motors','model'].includes(id)&&source.floating===true)entry.floating=true;
      if(finite(source.width)&&source.width>0&&finite(source.height)&&source.height>0){entry.width=clamp(source.width,1,SIZE_MAX);entry.height=clamp(source.height,1,SIZE_MAX);}
    }
  }
  return profiles;
}
function normalizeCloudLayout(input){
  if(!allowed(input,['version','profiles','preferences'])||input.version!==1||!allowed(input.profiles,PROFILE_KEYS)||!allowed(input.preferences,['overlayOpacity','instrumentsVisible','primary']))return null;
  const preferences=input.preferences;
  if(!finite(preferences.overlayOpacity)||preferences.overlayOpacity<0||preferences.overlayOpacity>100||typeof preferences.instrumentsVisible!=='boolean'||!['video','map'].includes(preferences.primary))return null;
  for(const profile of Object.values(input.profiles)){
    if(!allowed(profile,PART_IDS))return null;
    for(const [id,entry]of Object.entries(profile)){
      if(!allowed(entry,['x','y','width','height','opacity','floating']))return null;
      if(Object.hasOwn(entry,'opacity')&&(!finite(entry.opacity)||entry.opacity<opacityMin(id)||entry.opacity>100))return null;
      for(const [first,second,min,max]of [['x','y',0,1],['width','height',1,SIZE_MAX]]){
        if(Object.hasOwn(entry,first)||Object.hasOwn(entry,second)){
          if(!finite(entry[first])||!finite(entry[second])||entry[first]<min||entry[first]>max||entry[second]<min||entry[second]>max)return null;
        }
      }
      if(Object.hasOwn(entry,'floating')&&(!['motors','model'].includes(id)||typeof entry.floating!=='boolean'))return null;
    }
  }
  return {version:1,profiles:normalizeProfiles(input.profiles),preferences:{overlayOpacity:preferences.overlayOpacity,instrumentsVisible:preferences.instrumentsVisible,primary:preferences.primary}};
}
module.exports={PROFILE_KEYS,PART_IDS,SIZE_MAX,normalizeProfiles,normalizeCloudLayout};
