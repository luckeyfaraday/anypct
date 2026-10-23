// Real in-game footage of a recorded run. A local stand-in server streams the recording into a vanilla
// Minecraft client logged in as the bot, so the client receives exactly what the bot received and shows it
// with the real renderer, HUD, hand and hotbar. The bot's own movement, swings, hotbar changes, dig cracks and
// closed windows (never echoed by a server) are replayed from its recorded outgoing packets. ffmpeg captures the
// window (Windows Graphics Capture) to an MP4 that starts `lead` seconds before the course clock.
//   node record/play.mjs --run <run id> [--from 0 --to 120] [--no-capture]
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, courseWindow, poseAt, lookAt, shared } from './stream.mjs';
import { layout, launchArgs, writeOptions, install } from './client.mjs';

const mc=shared('minecraft-protocol');
const {values}=parseArgs({options:{recording:{type:'string'},run:{type:'string'},out:{type:'string'},port:{type:'string',default:'25690'},
  lead:{type:'string',default:'2'},tail:{type:'string',default:'5'},settle:{type:'string',default:'15'},capture:{type:'boolean',default:true},
  from:{type:'string'},to:{type:'string'},width:{type:'string',default:'1920'},height:{type:'string',default:'1080'},fps:{type:'string',default:'60'},
  cq:{type:'string',default:'20'},keep:{type:'boolean',default:false},topmost:{type:'boolean',default:true}},allowNegative:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DATA=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','data');
const EYE=1.62,FAR=1000;

function findRecording(run){
  for(const base of [process.env.BENCH_RECORD_DIR,path.join(DATA,'recordings'),path.join(DATA,'recordings-test')].filter(Boolean)){
    if(!fs.existsSync(base))continue;
    for(const d of fs.readdirSync(base)){try{if(JSON.parse(fs.readFileSync(path.join(base,d,'meta.json'),'utf8')).run===run)return path.join(base,d);}catch{}}
  }
  throw new Error(`No recording for run ${run}`);
}
const recordingDir=values.recording??findRecording(values.run);
const track=load(recordingDir),{P,records}=track,VERSION=track.version;
const runId=values.run??track.meta.run;
const course=courseWindow(runId);
const from=course.startT+Number(values.from??0)*1000-Number(values.lead)*1000;
const to=values.to?course.startT+Number(values.to)*1000:course.endT+Number(values.tail)*1000;
const outDir=values.out??path.join(process.env.BENCH_FOOTAGE_DIR||path.join(DATA,'footage'),runId);
fs.mkdirSync(outDir,{recursive:true});
const logFile=fs.openSync(path.join(outDir,'play.log'),'w');
const log=(...a)=>{const line=`${new Date().toISOString()} ${a.join(' ')}`;console.log(line);fs.writeSync(logFile,line+'\n');};
const username=course.manifest.player??'BenchAgent';
const uuid=records.find(r=>r.kind===2&&r.json.type==='login')?.json.uuid;
log(`run ${runId}: ${course.manifest.model}; course ${((course.endT-course.startT)/1000).toFixed(1)} s; playing ${((to-from)/1000).toFixed(1)} s from course ${((from-course.startT)/1000).toFixed(1)} s`);

const REMAP=new Set(['entity_status','entity_metadata','entity_velocity','entity_effect','remove_entity_effect','entity_update_attributes','animation','entity_equipment']);
const server=mc.createServer({'online-mode':false,version:VERSION,host:'127.0.0.1',port:Number(values.port),motd:'Bench footage',maxPlayers:1,hideErrors:true});
let session=null;
server.on('connection',client=>log(`connection from port ${client.socket?.remotePort}`));
server.on('login',client=>{if(session){client.end('Busy');return;}session=play(client);});

function play(client){
  const send=(name,params)=>client.writeRaw(P.build(name,params));
  const state={selfId:null,newSelf:null,alive:true,pos:null,estimated:false,teleportId:1,lastMove:0,lastLook:null,dig:null,digTime:null,ready:false,playing:false,t:from};
  let index=0;
  const onMove=p=>{state.pos={x:p.x,y:p.y,z:p.z};state.estimated=false;if(state.playing)move(state.t);};
  client.on('position',onMove);client.on('position_look',onMove);
  client.on('error',error=>log('client error',error.message));
  client.on('end',reason=>{log(`client disconnected ${reason??''}`);state.ended=true;});
  // The client answers the join packet with its settings once it is in the world; the rest waits for that.
  const joined=new Promise(resolve=>client.once('settings',()=>{state.joined=true;resolve();}));

  function forward(r){
    const n=r.name;
    if(n==='keep_alive'||n==='kick_disconnect')return;
    if(n==='login'){
      const p=P.parse(r.buf);
      if(state.selfId===null){state.selfId=p.entityId;client.writeRaw(r.buf);return;}
      // A reconnect during the run: the client keeps its player and the new session arrives as a respawn.
      state.newSelf=p.entityId;
      send('respawn',{dimension:p.dimension,worldName:p.worldName,hashedSeed:p.hashedSeed,gamemode:p.gameMode,previousGamemode:p.previousGameMode,isDebug:p.isDebug,isFlat:p.isFlat,copyMetadata:false});
      log('reconnect in recording: continued as a respawn');return;
    }
    if(state.newSelf!==null&&REMAP.has(n)){const p=P.parse(r.buf);if(p.entityId===state.newSelf){p.entityId=state.selfId;send(n,p);return;}}
    if(n==='update_health'){const p=P.parse(r.buf);state.alive=p.health>0;}
    client.writeRaw(r.buf);
    if(n==='respawn'||n==='position')state.pos=null;
  }
  function act(r,visual){
    const {name,params}=r.json,id=state.selfId;
    if(name==='held_item_slot')send('held_item_slot',{slot:params.slotId});
    else if(name==='close_window')send('close_window',{windowId:params.windowId});
    else if(!visual)return;
    else if(name==='arm_animation')send('animation',{entityId:id,animation:params.hand===1?3:0});
    else if(name==='block_dig'&&params.status===0)state.dig={location:params.location,start:r.t,time:state.digTime,stage:-2};
    else if(name==='block_dig'&&(params.status===1||params.status===2)){if(state.dig)send('block_break_animation',{entityId:id,location:state.dig.location,destroyStage:-1});state.dig=null;}
  }
  function handle(r,visual){
    if(r.kind===0)forward(r);
    else if(r.kind===1)act(r,visual);
    else if(r.json.type==='dig')state.digTime=r.json.digTimeMs;
  }
  function teleport(p,l){send('position',{x:p.x,y:p.y,z:p.z,yaw:l?.yaw??0,pitch:l?.pitch??0,flags:0,teleportId:state.teleportId++});state.pos={x:p.x,y:p.y,z:p.z};state.estimated=true;}
  // Movement: each client tick moves the player by its velocity, so setting the velocity to the gap between
  // where the client is and where the bot will be one tick later keeps the client's own smooth interpolation.
  function move(t){
    state.lastMove=performance.now();
    if(!state.alive||state.selfId===null)return;
    const target=poseAt(track,t+50),l=lookAt(track,t);if(!target)return;
    if(!state.pos){teleport(target,l);return;}
    const d={x:target.x-state.pos.x,y:target.y-state.pos.y,z:target.z-state.pos.z};
    if(Math.hypot(d.x,d.y,d.z)>4){teleport(target,l);return;}
    const v=k=>Math.max(-32000,Math.min(32000,Math.round(d[k]*8000)));
    send('entity_velocity',{entityId:state.selfId,velocity:{x:v('x'),y:v('y'),z:v('z')}});
    state.pos={x:target.x,y:target.y,z:target.z};state.estimated=true;
  }
  // Looking: face_player turns the client without touching its position, so it can run every frame.
  function look(t){
    const l=lookAt(track,t);if(!l||state.selfId===null)return;
    if(state.lastLook&&Math.abs(l.yaw-state.lastLook.yaw)<0.02&&Math.abs(l.pitch-state.lastLook.pitch)<0.02)return;
    state.lastLook=l;
    const base=state.pos??poseAt(track,t);if(!base)return;
    const yaw=l.yaw*Math.PI/180,pitch=l.pitch*Math.PI/180;
    send('face_player',{feet_eyes:1,x:base.x-Math.sin(yaw)*Math.cos(pitch)*FAR,y:base.y+EYE-Math.sin(pitch)*FAR,z:base.z+Math.cos(yaw)*Math.cos(pitch)*FAR,isEntity:false});
  }
  function crack(t){
    const d=state.dig;if(!d||!d.time)return;
    const stage=Math.min(9,Math.floor((t-d.start)/d.time*10));
    if(stage!==d.stage){d.stage=stage;send('block_break_animation',{entityId:state.selfId,location:d.location,destroyStage:stage});}
  }
  const done=(async()=>{
    // Everything before the clip, at once: the world, inventory and state as they were at its first frame.
    // The client connects while still loading its resources; a world that arrives before loading finishes
    // crashes it (particle sprites not ready) or leaves it stuck on Connecting. Hold everything until it is done.
    await clientLoaded();
    while(index<records.length&&records[index].t<from){
      const r=records[index++];handle(r,false);
      if(r.kind===0&&r.name==='login'&&!state.joinChecked){
        state.joinChecked=true;await Promise.race([joined,sleep(45000)]);
        if(!state.joined)throw new Error('client never joined the world');
        log('client joined the world');
      }
    }
    log(`prelude: ${index} records`);
    const settleEnd=Date.now()+Number(values.settle)*1000;
    while(Date.now()<settleEnd&&!state.ended){move(from);state.lastLook=null;look(from);await sleep(100);}
    if(state.ended)throw new Error('client never joined the world: it left before capture');
    state.ready=true;
    if(values.topmost)log(`window on top: ${windowOnTop()}`);
    await startCapture();
    state.playing=true;playStartAt=Date.now();const t0=performance.now();
    while(!state.ended){
      const t=from+(performance.now()-t0);state.t=t;
      while(index<records.length&&records[index].t<=t)handle(records[index++],true);
      look(t);crack(t);
      if(performance.now()-state.lastMove>55)move(t);
      if(t>=to)break;
      await sleep(3);
    }
    log(`played to course ${((state.t-course.startT)/1000).toFixed(1)} s`);
  })();
  return {done,state};
}

let ffmpeg=null,firstFrameAt=null,playStartAt=null;
// The raw capture starts during the settle view; its first frame is timestamped from ffmpeg's showinfo line (it
// arrives within a frame of capture), and the final clip is cut from the moment playback began.
async function startCapture(){
  if(!values.capture){log('capture off');return;}
  const raw=path.join(outDir,'capture.mp4');
  // A 1080p window cannot fit on a 1080p screen with its title bar, so the client area is cropped to 16:9 and
  // scaled to the output size (a ~2% upscale).
  const [w,h]=[values.width,values.height];
  const filter=`gfxcapture=window_title=^Minecraft ${VERSION}:capture_cursor=0:max_framerate=${values.fps},hwdownload,format=bgra,showinfo=checksum=0,`+
    `crop=trunc(min(iw\\,ih*${w}/${h})/2)*2:trunc(min(ih\\,iw*${h}/${w})/2)*2,scale=${w}:${h}:flags=lanczos`;
  ffmpeg=spawn('ffmpeg',['-y','-hide_banner','-nostats','-loglevel','info','-filter_complex',filter,'-fps_mode','cfr','-r',values.fps,
    '-c:v','h264_nvenc','-preset','p5','-tune','hq','-rc','vbr','-cq',values.cq,'-b:v','0','-pix_fmt','yuv420p',raw],
    {stdio:['pipe','ignore','pipe'],windowsHide:true});
  let pending='';
  ffmpeg.stderr.on('data',d=>{
    pending+=d;const lines=pending.split(/\r?\n/);pending=lines.pop();
    for(const line of lines){
      if(line.includes('Parsed_showinfo')){if(firstFrameAt===null&&/ n:\s*0 /.test(line))firstFrameAt=Date.now();continue;}
      fs.writeSync(logFile,line+'\n');
    }
  });
  const begun=Date.now();
  while(firstFrameAt===null){if(ffmpeg.exitCode!==null)throw new Error('ffmpeg exited before capturing');if(Date.now()-begun>30000)throw new Error('ffmpeg did not start capturing');await sleep(20);}
  await sleep(1500);
  log(`capturing to ${raw} (first frame ${firstFrameAt})`);
}
async function cut(){
  const offset=(playStartAt-firstFrameAt)/1000,length=(to-from)/1000,out=path.join(outDir,'footage.mp4');
  log(`cutting ${length.toFixed(1)} s from ${offset.toFixed(3)} s of the raw capture`);
  execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-ss',offset.toFixed(3),'-i',path.join(outDir,'capture.mp4'),'-t',length.toFixed(3),
    '-c:v','h264_nvenc','-preset','p6','-tune','hq','-rc','vbr','-cq',String(Number(values.cq)-2),'-b:v','0','-pix_fmt','yuv420p','-movflags','+faststart',out],{stdio:'inherit',windowsHide:true});
  return {offset,out};
}

const L=layout(VERSION);
if(!fs.existsSync(path.join(L.root,`${VERSION}.classpath.json`)))await install(VERSION,log);
await writeOptions(L);
const {java,args}=launchArgs(L,{username,uuid,server:'127.0.0.1',port:Number(values.port),width:Number(values.width),height:Number(values.height)});
const clientLog=fs.openSync(path.join(outDir,'client.log'),'w');
let game=null,clientLogStart=0;
// Windows throttles a window hidden behind others; on top (never focused, so the mouse stays free) it renders at full rate.
const windowOnTop=(release=false)=>{
  const script=fileURLToPath(new URL('./window.ps1',import.meta.url)),title=`^Minecraft ${VERSION.replace(/\./g,'\\.')}`;
  try{return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Title',title,...(release?['-Release']:[])],{encoding:'utf8',windowsHide:true}).trim();}
  catch(error){return String(error.stdout||error.message).trim();}
};
async function clientLoaded(){
  const file=path.join(outDir,'client.log'),begun=Date.now();
  while(Date.now()-begun<120000){
    const text=fs.readFileSync(file,'latin1').slice(clientLogStart);
    if(/mob_effects.png-atlas/.test(text)){await sleep(2000);log('client finished loading');return;}
    if(game?.exitCode!==null&&game?.exitCode!==undefined)throw new Error('client never joined the world: it exited while loading');
    await sleep(200);
  }
  throw new Error('client never joined the world: still loading after 120 s');
}
const stopClient=()=>{if(!game)return;try{execFileSync('taskkill',['/PID',String(game.pid),'/T','/F'],{stdio:'ignore'});}catch{}};
process.once('SIGINT',()=>{ffmpeg?.stdin.end('q');stopClient();process.exit(130);});
try{
  // A client that never gets into the world (seen once: stuck on "Connecting" until its 30 s timeout) is
  // relaunched; nothing has been captured at that point.
  for(let attempt=1;;attempt++){
    session=null;
    clientLogStart=fs.statSync(path.join(outDir,'client.log')).size;
    game=spawn(java,args,{cwd:L.game,stdio:['ignore',clientLog,clientLog]});
    log(`client pid ${game.pid} (attempt ${attempt})`);
    const begun=Date.now();while(!session){if(game.exitCode!==null)throw new Error('Minecraft exited before connecting');if(Date.now()-begun>180000)throw new Error('Minecraft did not connect');await sleep(250);}
    log('client connected');
    try{await session.done;break;}
    catch(error){if(attempt>=3||playStartAt||!/never joined/.test(error.message))throw error;log(`${error.message}; relaunching`);session.state.ended=true;stopClient();await sleep(2000);}
  }
}finally{
  if(ffmpeg){ffmpeg.stdin.end('q');await new Promise(r=>ffmpeg.once('exit',r));log('capture finished');}
  if(!values.keep)stopClient();
  server.close();
}
const clip=ffmpeg&&playStartAt?await cut():null;
const report={run:runId,model:course.manifest.model,recording:recordingDir,video:clip?.out??null,rawCapture:clip?path.join(outDir,'capture.mp4'):null,rawOffsetSeconds:clip?.offset??null,
  videoStartsAtCourseSeconds:(from-course.startT)/1000,courseSeconds:(course.endT-course.startT)/1000,width:Number(values.width),height:Number(values.height),fps:Number(values.fps)};
fs.writeFileSync(path.join(outDir,'footage.json'),JSON.stringify(report,null,2));
log('done');
process.exit(0);
