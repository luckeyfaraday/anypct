import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTimeline, poseAt } from './timeline.mjs';

// 3D replay of recorded runs. Each browser tab gets its own copy of the run's
// final saved world (read-only: saves go nowhere), rewound to the replay time by
// undoing later block changes, and a camera that follows the recorded poses.
const here=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(here,'..'),RUNS=path.join(ROOT,'data','runs');
const local=createRequire(import.meta.url),shared=createRequire(path.join(ROOT,'package.json'));
const express=shared('express'),{Server}=shared('socket.io'),{Vec3}=shared('vec3');
const {WorldView}=shared('prismarine-viewer/viewer/lib/worldView'),{setupRoutes}=shared('prismarine-viewer/lib/common');
const {Anvil}=local('prismarine-provider-anvil');
const {values}=parseArgs({options:{port:{type:'string',default:'8124'},distance:{type:'string',default:'5'}}});
const VIEW_DISTANCE=Number(values.distance),TICK_MS=50;
const REGION={overworld:'region',the_nether:'DIM-1/region',the_end:'DIM1/region'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeRun=id=>/^[\w.-]+$/.test(id??'')?id:null;

const timelines=new Map();
async function timeline(id){
  if(!timelines.has(id)){timelines.set(id,loadTimeline(path.join(RUNS,id)));while(timelines.size>3)timelines.delete(timelines.keys().next().value);}
  return timelines.get(id);
}

class Replay {
  constructor(key){this.key=key;this.viewer=null;this.control=null;this.closed=false;this.started=false;}
  async start(){
    if(this.started||!this.viewer||!this.control)return;this.started=true;
    try{
      this.data=await timeline(this.run);const v=this.data.version;
      this.World=shared('prismarine-world')(v);this.registry=shared('prismarine-registry')(v);this.AnvilVersion=Anvil(v);
      this.worlds={};this.applied=this.data.changes.length;this.t=0;this.playing=true;this.speed=4;this.camera=this.cameraMode??'chase';
      this.entities=new Set();this.dimension=null;this.lastFrame=null;this.lastTrail=-Infinity;
      this.control.emit('meta',{id:this.data.id,model:this.data.model,scenario:this.data.scenario.id,duration:this.data.duration,outcome:this.data.outcome,progress:this.data.progress,
        milestones:this.data.milestones,deaths:this.data.deaths,changeSource:this.data.changeSource,changes:this.data.changes.length,landmarks:this.data.scenario.landmarks??[]});
      this.viewer.emit('version',v);
      void this.loop();
    }catch(error){this.control?.emit('failure',String(error.message??error));}
  }
  world(dimension){
    if(!this.worlds[dimension]){
      const provider=new this.AnvilVersion(path.join(RUNS,this.data.id,'server','world',REGION[dimension]??'region'));
      // Read-only: the run's saved world is evidence and is never written.
      const readOnly={load:(x,z)=>provider.load(x,z).catch(()=>null),save:async()=>{}};
      this.worlds[dimension]=new this.World(null,readOnly,0);
    }
    return this.worlds[dimension];
  }
  state(change,side){
    if(change[side]!==undefined)return change[side];
    const name=change[`${side}Name`];if(name==='air')return 0;
    return this.registry.blocksByName[name]?.defaultState??null;
  }
  async set(change,stateId){
    if(stateId===null||stateId===undefined)return;const pos=new Vec3(...change.position);
    try{await this.world(change.dimension).setBlockStateId(pos,stateId);}catch{return;}
    if(change.dimension===this.dimension&&this.view?.loadedChunks[`${Math.floor(pos.x/16)*16},${Math.floor(pos.z/16)*16}`])this.viewer?.emit('blockUpdate',{pos,stateId});
  }
  async rewindTo(t){
    const c=this.data.changes;let lo=0,hi=c.length;while(lo<hi){const mid=(lo+hi)>>1;if(c[mid].t<=t)lo=mid+1;else hi=mid;}
    while(this.applied>lo){const change=c[--this.applied];await this.set(change,this.state(change,'from'));}
    while(this.applied<lo){const change=c[this.applied++];await this.set(change,this.state(change,'to'));}
  }
  async enter(dimension,pos){
    if(this.view)for(const key of Object.keys(this.view.loadedChunks)){const [x,z]=key.split(',').map(Number);this.viewer.emit('unloadChunk',{x,z});}
    for(const id of this.entities)this.viewer.emit('entity',{id,delete:true});this.entities.clear();
    for(const id of ['trail',...(this.data.scenario.landmarks??[]).map((_,i)=>`landmark${i}`)])this.viewer.emit('primitive',{id,type:'none'});
    this.dimension=dimension;this.view=new WorldView(this.world(dimension),VIEW_DISTANCE,pos,this.viewer);
    // WorldView raycasts on every browser click; on an anvil world a ray into an unloaded column throws
    // and took the server down. A replay has no block clicking.
    this.viewer.removeAllListeners('mouseClick');
    await this.view.init(pos);
    (this.data.scenario.landmarks??[]).forEach((l,i)=>{if(l.dimension!==dimension)return;const [x,y,z]=l.position;
      this.viewer.emit('primitive',{id:`landmark${i}`,type:'line',color:0x45d6ff,points:[{x:x+.5,y,z:z+.5},{x:x+.5,y:y+48,z:z+.5}]});});
  }
  cameraPose(pose){
    const [x,y,z]=pose.position;
    if(this.camera==='first')return {pos:{x,y,z},yaw:pose.yaw,pitch:pose.pitch};
    if(this.camera==='overhead')return {pos:{x,y:y+28,z},yaw:0,pitch:-Math.PI/2+0.001};
    // Chase: behind and above, with the heading smoothed so look-arounds do not whip the camera.
    const d=((pose.yaw-(this.chaseYaw??pose.yaw)+Math.PI*3)%(Math.PI*2))-Math.PI;this.chaseYaw=(this.chaseYaw??pose.yaw)+d*0.12;
    const yaw=this.chaseYaw,back=6;
    return {pos:{x:x+Math.sin(yaw)*back,y:y+2.2,z:z+Math.cos(yaw)*back},yaw,pitch:-0.32};
  }
  syncEntities(pose){
    const f=pose.frame;if(f===this.lastFrame&&!this.cameraChanged)return;this.lastFrame=f;this.cameraChanged=false;
    const seen=new Map();
    if(this.camera!=='first')seen.set('agent',{id:'agent',name:'player',username:'BenchAgent',width:0.6,height:1.8});
    // Sizes from Minecraft data: the viewer falls back to a box of this size when it has no model.
    const size=name=>{const d=this.registry.entitiesByName[name];return {width:d?.width??0.6,height:d?.height??1.8};};
    for(const e of f.entities)seen.set(e.id,{id:e.id,name:e.name,...size(e.name),pos:{x:e.position[0],y:e.position[1],z:e.position[2]}});
    if(f.dragon?.visible&&f.dragon.position)seen.set(f.dragon.id,{id:f.dragon.id,name:'ender_dragon',...size('ender_dragon'),pos:{x:f.dragon.position[0],y:f.dragon.position[1],z:f.dragon.position[2]}});
    for(const id of this.entities)if(!seen.has(id)){this.viewer.emit('entity',{id,delete:true});this.entities.delete(id);}
    for(const [id,e] of seen){if(id==='agent')continue;this.viewer.emit('entity',e);this.entities.add(id);}
    if(seen.has('agent'))this.entities.add('agent');
  }
  trail(t){
    if(Math.abs(t-this.lastTrail)<1000)return;this.lastTrail=t;
    const points=this.data.frames.filter(f=>f.dimension===this.dimension&&f.t<=t&&f.t>t-180000).filter((_,i)=>i%2===0).map(f=>({x:f.position[0],y:f.position[1]+0.1,z:f.position[2]}));
    this.viewer.emit('primitive',points.length>1?{id:'trail',type:'line',color:0x9cff57,points}:{id:'trail',type:'none'});
  }
  hud(pose){
    const t=this.t,f=pose.frame,said=this.data.messages.filter(m=>m.t<=t).at(-1);
    this.control.emit('hud',{t,duration:this.data.duration,playing:this.playing,speed:this.speed,camera:this.camera,dimension:pose.dimension,position:pose.position,
      health:f.health,food:f.food,alive:f.alive,heldItem:f.heldItem,inventory:f.inventory,action:f.action,dragon:f.dragon,
      message:said?{t:said.t,text:said.text.slice(0,600)}:null,reached:this.data.milestones.filter(m=>m.t<=t).map(m=>m.name),deaths:this.data.deaths.filter(d=>d<=t).length});
  }
  async loop(){
    let last=performance.now(),lastHud=0;
    while(!this.closed){
      const now=performance.now();
      if(this.seekTo!==undefined){this.t=Math.max(0,Math.min(this.data.duration,this.seekTo));this.seekTo=undefined;this.lastTrail=-Infinity;}
      else if(this.playing){this.t=Math.min(this.data.duration,this.t+(now-last)*this.speed);if(this.t>=this.data.duration)this.playing=false;}
      last=now;
      const pose=poseAt(this.data,this.t);
      if(pose&&this.viewer){
        const pos=new Vec3(...pose.position);
        if(pose.dimension!==this.dimension)await this.enter(pose.dimension,pos);
        await this.rewindTo(this.t);
        const cam=this.cameraPose(pose);
        this.viewer.emit('position',{pos:{x:cam.pos.x,y:cam.pos.y-1.62,z:cam.pos.z},yaw:cam.yaw,pitch:cam.pitch});
        if(this.entities.has('agent')||this.camera!=='first')this.viewer.emit('entity',{id:'agent',name:'player',username:'BenchAgent',width:0.6,height:1.8,pos:{x:pos.x,y:pos.y,z:pos.z}});
        this.syncEntities(pose);this.trail(this.t);
        await this.view.updatePosition(pos);
        if(now-lastHud>200){this.hud(pose);lastHud=now;}
      }
      await sleep(TICK_MS);
    }
  }
  command(c){
    if(c.cmd==='toggle')this.playing=!this.playing;
    else if(c.cmd==='play')this.playing=true;
    else if(c.cmd==='pause')this.playing=false;
    else if(c.cmd==='seek'&&Number.isFinite(c.t))this.seekTo=c.t;
    else if(c.cmd==='speed'&&[0.5,1,2,4,8,16,32].includes(c.speed))this.speed=c.speed;
    else if(c.cmd==='camera'&&['chase','first','overhead'].includes(c.camera)){
      if(this.camera!==c.camera&&c.camera==='first'){this.viewer?.emit('entity',{id:'agent',delete:true});this.entities.delete('agent');}
      this.camera=c.camera;this.cameraChanged=true;
    }
  }
  close(){this.closed=true;}
}

const app=express(),server=http.createServer(app),io=new Server(server);
const diagnostics='window.benchViewer={errors:[]};';
const viewerSource=await fs.readFile(shared.resolve('prismarine-viewer/public/index.js'),'utf8');
const workerSource=await fs.readFile(shared.resolve('prismarine-viewer/public/worker.js'),'utf8');
app.get('/',(_req,res)=>res.sendFile(path.join(here,'index.html')));
app.get('/favicon.ico',(_req,res)=>res.status(204).end());
app.get('/index.js',(_req,res)=>res.type('js').send(diagnostics+viewerSource));
app.get('/worker.js',(_req,res)=>res.type('js').send(workerSource));
app.get('/api/runs',async(_req,res)=>{
  const runs=[];
  for(const id of (await fs.readdir(RUNS)).sort().reverse()){
    try{const manifest=JSON.parse(await fs.readFile(path.join(RUNS,id,'manifest.json'),'utf8'));if(manifest.kind!=='evaluation')continue;
      await fs.access(path.join(RUNS,id,'server','world','region'));
      const result=await fs.readFile(path.join(RUNS,id,'result.json'),'utf8').then(JSON.parse).catch(()=>null);
      runs.push({id,model:manifest.model,scenario:manifest.scenario.id,createdAt:manifest.createdAt,outcome:result?.outcome??manifest.status,progress:result?.progress?.score??null});
    }catch{}
  }
  runs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  res.json({runs});
});
setupRoutes(app,'');

const replays=new Map();
// Each tab adds a random `tab` id to its URL before loading the stock viewer bundle.
// The bundle's socket carries the page URL as its Referer; the page's control socket
// sends the same id, so two tabs (e.g. two runs side by side) never share a replay.
const tabOf=socket=>{
  if(socket.handshake.query.role==='control')return socket.handshake.query.tab;
  try{return new URL(socket.handshake.headers.referer).searchParams.get('tab');}catch{return null;}
};
io.on('connection',socket=>{
  const key=tabOf(socket);
  if(!/^[\w-]{8,64}$/.test(key??'')){socket.disconnect(true);return;}
  const role=socket.handshake.query.role==='control'?'control':'viewer';
  let replay=replays.get(key);if(!replay){replay=new Replay(key);replays.set(key,replay);}
  replay[role]=socket;
  if(role==='control'){
    replay.run=safeRun(socket.handshake.query.run);replay.cameraMode=['chase','first','overhead'].includes(socket.handshake.query.camera)?socket.handshake.query.camera:'chase';
    if(!replay.run){socket.emit('failure','Unknown run');return;}
    socket.on('control',c=>replay.command(c??{}));
  }
  void replay.start();
  socket.on('disconnect',()=>{if(replay[role]===socket)replay[role]=null;if(!replay.viewer&&!replay.control){replay.close();replays.delete(key);}});
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(values.port),'127.0.0.1',resolve);});
console.log(`Replay server: http://127.0.0.1:${server.address().port}/`);
// Replays are read-only and per tab: a stray async failure in viewer code is logged rather than ending every open replay.
process.on('unhandledRejection',error=>console.error('unhandled rejection:',error?.stack??error));
