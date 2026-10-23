// Reads a recording written by record/attach.mjs and builds what playback needs: packets with names, the bot's
// pose track (its own movement packets plus server teleports), and its local actions (swings, hotbar changes,
// digging, closed windows), none of which the server ever echoes back to the player.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const shared=createRequire(path.join(ROOT,'package.json'));
const mc=shared('minecraft-protocol'),mcData=shared('minecraft-data');
export const RUNS=path.join(ROOT,'data','runs');

export function protocol(version){
  const types=mcData(version).protocol.play.toClient.types;
  const names=new Map(Object.entries(types.packet[1][0].type[1].mappings).map(([id,name])=>[Number(id),name]));
  const parser=mc.createDeserializer({state:mc.states.PLAY,isServer:false,version});
  const serializer=mc.createSerializer({state:mc.states.PLAY,isServer:true,version});
  return {
    nameOf:buf=>{let v=0,shift=0,i=0;for(;;){const b=buf[i++];v|=(b&0x7f)<<shift;if(!(b&0x80))break;shift+=7;}return names.get(v);},
    parse:buf=>parser.parsePacketBuffer(buf).data.params,
    build:(name,params)=>serializer.createPacketBuffer({name,params}),
  };
}

export function readRecords(directory){
  const data=fs.readFileSync(path.join(directory,'stream.bin')),records=[];let o=0;
  while(o+13<=data.length){
    const kind=data.readUInt8(o),t=data.readDoubleLE(o+1),length=data.readUInt32LE(o+9);
    if(o+13+length>data.length)break;
    const body=data.subarray(o+13,o+13+length);o+=13+length;
    records.push(kind===0?{kind,t,buf:body}:{kind,t,json:JSON.parse(body.toString())});
  }
  return records;
}

// Course start and end in epoch ms, from the run's own log.
export function courseWindow(runId){
  const events=fs.readFileSync(path.join(RUNS,runId,'events.jsonl'),'utf8').trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
  const start=events.find(e=>e.type==='run_start');if(!start)throw new Error(`No run_start in ${runId}`);
  const startT=Date.parse(start.at)-(start.elapsedMs??0);
  const result=JSON.parse(fs.readFileSync(path.join(RUNS,runId,'result.json'),'utf8'));
  const end=events.find(e=>e.type==='result');
  return {startT,endT:end?Date.parse(end.at):startT+(result.clock?.wallMs??result.elapsedMs),result,manifest:JSON.parse(fs.readFileSync(path.join(RUNS,runId,'manifest.json'),'utf8'))};
}

export function load(directory){
  const meta=JSON.parse(fs.readFileSync(path.join(directory,'meta.json'),'utf8'));
  const records=readRecords(directory);
  const version=records.find(r=>r.kind===2&&r.json.type==='bot')?.json.version;if(!version)throw new Error('Recording names no Minecraft version');
  const P=protocol(version);
  const poses=[],looks=[],actions=[];let digTime=null,last={x:0,y:0,z:0,yaw:0,pitch:0};
  for(const r of records){
    if(r.kind===0){
      r.name=P.nameOf(r.buf);
      if(r.name==='position'){
        // Server teleport: absolute unless a flag bit makes an axis relative.
        const p=P.parse(r.buf),f=p.flags;
        const x=f&1?last.x+p.x:p.x,y=f&2?last.y+p.y:p.y,z=f&4?last.z+p.z:p.z,yaw=f&8?last.yaw+p.yaw:p.yaw,pitch=f&16?last.pitch+p.pitch:p.pitch;
        last={x,y,z,yaw,pitch};poses.push({t:r.t,x,y,z,snap:true});looks.push({t:r.t,yaw,pitch});
      }else if(r.name==='login'||r.name==='respawn')actions.push({t:r.t,type:r.name});
    }else if(r.kind===1){
      const {name,params}=r.json;
      if(name==='position'||name==='position_look'){last={...last,x:params.x,y:params.y,z:params.z};poses.push({t:r.t,x:params.x,y:params.y,z:params.z});}
      if(name==='look'||name==='position_look'){last={...last,yaw:params.yaw,pitch:params.pitch};looks.push({t:r.t,yaw:params.yaw,pitch:params.pitch});}
      if(name==='arm_animation')actions.push({t:r.t,type:'swing',hand:params.hand});
      else if(name==='held_item_slot')actions.push({t:r.t,type:'slot',slot:params.slotId});
      else if(name==='close_window')actions.push({t:r.t,type:'close',windowId:params.windowId});
      else if(name==='block_dig'&&[0,1,2].includes(params.status))actions.push({t:r.t,type:params.status===0?'dig':'digEnd',location:params.location,digTimeMs:params.status===0?digTime:null});
    }else if(r.json.type==='dig')digTime=r.json.digTimeMs;
  }
  return {meta,version,records,poses,looks,actions,P};
}

const lerpAngle=(a,b,k)=>a+((((b-a)%360)+540)%360-180)*k;
// Holds a value through gaps (the bot only reports movement when it moves), easing into the next sample
// over one tick; teleports snap.
function sampleAt(list,t,keys,angle=false){
  let lo=0,hi=list.length-1;if(hi<0)return null;if(t<=list[0].t)return list[0];
  while(lo<hi){const mid=(lo+hi+1)>>1;if(list[mid].t<=t)lo=mid;else hi=mid-1;}
  const a=list[lo],b=list[lo+1];if(!b||b.snap)return a;
  const start=Math.max(a.t,b.t-50);if(t<=start)return a;
  const k=(t-start)/(b.t-start),out={t};
  for(const key of keys)out[key]=angle?lerpAngle(a[key],b[key],k):a[key]+(b[key]-a[key])*k;
  return out;
}
export const poseAt=(track,t)=>sampleAt(track.poses,t,['x','y','z']);
export const lookAt=(track,t)=>sampleAt(track.looks,t,['yaw','pitch'],true);
