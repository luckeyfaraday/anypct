import fs from 'node:fs/promises';
import path from 'node:path';

// Turns a run's telemetry log into a replay timeline: camera poses, visible
// entities, HUD state, and block changes. Runs that logged `block` events
// replay exact changes; older runs infer them from the agent's mine, place and
// pillar actions (other changes, such as explosions or fluid flow, are missing).
const round=v=>Math.round(v*100)/100;
export async function loadTimeline(runDirectory){
  const manifest=JSON.parse(await fs.readFile(path.join(runDirectory,'manifest.json'),'utf8'));
  const result=await fs.readFile(path.join(runDirectory,'result.json'),'utf8').then(JSON.parse).catch(()=>null);
  const text=await fs.readFile(path.join(runDirectory,'events.jsonl'),'utf8');
  const frames=[],messages=[],milestones=[],logged=[],starts=new Map(),inferred=[];let deaths=[];
  for(const line of text.split('\n')){
    if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}
    const t=e.elapsedMs;if(t===null||t===undefined)continue;const d=e.data??{};
    if(e.type==='frame'&&d.position){
      frames.push({t,dimension:d.dimension,position:d.position,yaw:d.yaw??0,pitch:d.pitch??0,health:d.health,food:d.food,alive:d.alive,heldItem:d.heldItem,
        inventory:(d.inventory??[]).map(i=>`${i.name}×${i.count}`),entities:(d.entities??[]).slice(0,24).map(x=>({id:x.id,name:x.name,position:x.position})),
        dragon:d.dragon??null,action:d.actions?.active?{name:d.actions.active.name,args:d.actions.active.args}:null});
    }
    else if(e.type==='block')logged.push({t,dimension:d.dimension,position:d.position,from:d.from,to:d.to});
    else if(e.type==='milestone')milestones.push({t:d.wallMs??t,name:d.name});
    else if(e.type==='death')deaths.push(t);
    else if(e.type==='action_start')starts.set(d.id,{t,...d});
    else if(e.type==='action_end'&&d.ok){const s=starts.get(d.id);if(s)inferred.push({t,start:s,end:d});}
    else if(e.type==='model_response'){
      const said=d.content?(d.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')):(d.item?.type==='agent_message'?d.item.text:'');
      if(said?.trim())messages.push({t,text:said.trim()});
    }
  }
  frames.sort((a,b)=>a.t-b.t);
  const dimensionAt=t=>{let lo=0,hi=frames.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(frames[mid].t<=t)lo=mid;else hi=mid-1;}return frames[lo]?.dimension??'overworld';};
  let changes,changeSource;
  if(logged.length){changes=logged;changeSource='logged';}
  else{
    changeSource='inferred from mine/place/pillar actions';changes=[];
    const offset={up:[0,1,0],down:[0,-1,0],north:[0,0,-1],south:[0,0,1],east:[1,0,0],west:[-1,0,0]};
    for(const {t,start,end} of inferred){
      const dimension=dimensionAt(t);
      if(start.name==='mine'&&end.value?.block)changes.push({t,dimension,position:start.args.position.map(Math.floor),fromName:end.value.block,toName:'air'});
      else if(start.name==='place'&&offset[start.args.face]){const p=start.args.reference.map((v,i)=>Math.floor(v)+offset[start.args.face][i]);changes.push({t,dimension,position:p,fromName:'air',toName:start.args.item});}
      else if(start.name==='pillar'&&end.value?.placed){const [x,y,z]=end.value.position.map(Math.floor);for(let i=1;i<=end.value.placed;i++)changes.push({t,dimension,position:[x,y-i,z],fromName:'air',toName:start.args.item});}
    }
  }
  changes.sort((a,b)=>a.t-b.t);
  return {id:path.basename(runDirectory),model:manifest.model,kind:manifest.kind,scenario:manifest.scenario,version:manifest.scenario.minecraft,
    duration:Math.max(frames.at(-1)?.t??0,result?.elapsedMs??0),outcome:result?.outcome??manifest.status,progress:result?.progress??null,
    frames,messages,milestones,deaths,changes,changeSource};
}
// Pose at time t, interpolated between frames; teleports and respawns snap.
export function poseAt(timeline,t){
  const f=timeline.frames;if(!f.length)return null;
  let lo=0,hi=f.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(f[mid].t<=t)lo=mid;else hi=mid-1;}
  const a=f[lo],b=f[Math.min(lo+1,f.length-1)];
  const span=b.t-a.t,k=span>0?Math.min(1,Math.max(0,(t-a.t)/span)):0;
  const jump=a.dimension!==b.dimension||Math.hypot(...a.position.map((v,i)=>v-b.position[i]))>12;
  const lerp=(x,y)=>jump?x:x+(y-x)*k;
  const dyaw=((b.yaw-a.yaw+Math.PI*3)%(Math.PI*2))-Math.PI;
  return {frame:a,dimension:a.dimension,position:a.position.map((v,i)=>round(lerp(v,b.position[i]))),yaw:jump?a.yaw:a.yaw+dyaw*k,pitch:lerp(a.pitch,b.pitch)};
}
