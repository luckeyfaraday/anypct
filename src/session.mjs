import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA, ROOT, PLAYER, runId, writeJson, sha256, treeHashes, sleep, errorText } from './util.mjs';
import { restoreSnapshot } from './snapshots.mjs';
import { startServer } from './server.mjs';
import { connectBot, Controller } from './controller.mjs';
import { ActionManager, schemas } from './actions.mjs';
import { Referee, readWorldEvidence, grade, ladder } from './referee.mjs';
import { RealClock, PausedClock } from './clock.mjs';
import { RunLog } from './log.mjs';

const CLOCK_POLICY={
  real:'real time from first delivered observation; inference and recovery count; no tick acceleration',
  paused:'game time only: the world is frozen between tool calls (Carpet tick freeze, bot physics off) and runs only inside mutating actions and wait; natural regeneration is off while frozen; a wall-clock cap bounds thinking time'};
const wallLimitSeconds=scenario=>scenario.wallSeconds??Math.min(3*scenario.durationSeconds,10800);

// Setup is privileged and runs before the referee is armed, so nothing it causes is credited.
// `setblock`/`fill` on a chunk that is still loading reports "not loaded"; those retry.
async function setupCommand(server,command){
  for(let attempt=0;;attempt++){
    const reply=String(await server.command(command));
    if(/not loaded/i.test(reply)&&attempt<40){await sleep(250);continue;}
    if(/Unknown|Incorrect argument|Expected|Invalid|not loaded|No player was found|No entity was found|out of the world/i.test(reply))throw new Error(`Setup command failed: ${command}: ${reply.slice(0,200)}`);
    return reply;
  }
}
async function until(predicate,ms,message){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw new Error(message);await sleep(100);}}
// Mineflayer's waitForChunksToLoad can wait on chunks the server never sends after a dimension change;
// the ground under the player is what the first observation needs.
const groundLoaded=bot=>until(()=>!!bot.entity&&bot.blockAt(bot.entity.position.offset(0,-1,0))!==null,20000,'Start chunks did not load');
export async function applyStart({server,bot,scenario}){
  const start=scenario.start??{},command=c=>setupCommand(server,c);
  // A stage can start from another course's world with a different difficulty.
  await command(`difficulty ${scenario.difficulty}`);
  // Commands that edit distant terrain name the areas to keep loaded while they run: [dimension, x1, z1, x2, z2].
  for(const [dimension,...area] of start.load??[])await command(`execute in minecraft:${dimension} run forceload add ${area.join(' ')}`);
  for(const c of start.commands??[])await command(c);
  for(const [dimension,...area] of start.load??[])await command(`execute in minecraft:${dimension} run forceload remove ${area.join(' ')}`);
  if(start.portal){
    // Enter through the portal block itself, as a player would: the End builds its arrival platform.
    const [x,y,z]=start.portal;await command(`tp ${PLAYER} ${x+.5} ${y} ${z+.5}`);
    await until(()=>bot.game.dimension===start.dimension,20000,`Start portal did not reach ${start.dimension}`);
    await groundLoaded(bot);await sleep(1500);
  }else if(start.position){
    const [x,y,z]=start.position,dimension=start.dimension??'overworld';
    await command(`execute in minecraft:${dimension} run tp ${PLAYER} ${x+.5} ${y} ${z+.5} ${start.yaw??0} 0`);
    await until(()=>bot.game.dimension===dimension&&bot.entity.position.distanceTo({x:x+.5,y,z:z+.5})<2,20000,'Start position was not reached');
    await groundLoaded(bot);await sleep(500);
  }
  for(const [slot,item] of start.armor??[])await command(`replaceitem entity ${PLAYER} armor.${slot} minecraft:${item}`);
  for(const [item,count] of start.kit??[])await command(`give ${PLAYER} minecraft:${item} ${count}`);
  if(start.spawnpoint){const {dimension='overworld',position:[x,y,z]}=start.spawnpoint;await command(`execute in minecraft:${dimension} run spawnpoint ${PLAYER} ${x} ${y} ${z}`);}
  const expected=(start.kit??[]).reduce((n,[,count])=>n+count,0);
  if(expected)await until(()=>bot.inventory.items().reduce((n,i)=>n+i.count,0)>=expected,10000,'Start kit did not arrive');
}
export async function createSession({scenario,kind='evaluation',model='external',durationSeconds=scenario.durationSeconds,onStatus=()=>{}}){
  if(!Number.isFinite(durationSeconds)||durationSeconds<1||durationSeconds>3600)throw new Error('Duration must be 1–3600 seconds');
  const id=runId(scenario.id),directory=path.join(DATA,'runs',id),runtime=path.join(directory,'server');
  const snapshot=await restoreSnapshot(scenario,runtime);
  const log=new RunLog(directory);
  const clockKind=scenario.clock??'real',durationMs=durationSeconds*1000;
  const manifest={schemaVersion:1,id,kind,model,scenario,durationSeconds,createdAt:new Date().toISOString(),snapshotHash:snapshot.worldHash,
    controllerHash:sha256(JSON.stringify(await treeHashes(path.join(ROOT,'src')))),dependencyHash:sha256(await fs.readFile(path.join(ROOT,'package-lock.json'))),
    observationPolicy:{radius:scenario.observationRadius,visibility:'raycast-filtered local blocks and entities; accumulated discovered landmarks',pathfinding:'loaded collision map; no automatic digging, building, or parkour',movement:'direct key-hold move (jump/sprint/sneak) and jump-place pillar'},
    clockPolicy:CLOCK_POLICY[clockKind],...(clockKind==='paused'?{wallLimitSeconds:wallLimitSeconds(scenario)}:{}),
    status:'starting'};
  await writeJson(path.join(directory,'manifest.json'),manifest);
  let server,bot;
  try{server=await startServer({directory:runtime,scenario});bot=await connectBot(server.port,{version:scenario.minecraft,onEvent:(t,d)=>log.event(t,d)});}catch(error){
    if(server)await server.stop().catch(()=>{});manifest.status='infrastructure_error';manifest.error=errorText(error);
    const result={id,model,scenario:scenario.id,protocolHash:sha256(JSON.stringify({scenario,snapshotHash:manifest.snapshotHash,controllerHash:manifest.controllerHash,durationSeconds})),...grade({evidence:null,observed:{},last:{},durationMs,elapsedMs:0,infrastructureError:errorText(error),kind,scenario}),reason:'startup_error',metrics:{modelCalls:0,costUsd:null}};
    await writeJson(path.join(directory,'manifest.json'),manifest);await writeJson(path.join(directory,'result.json'),result);await writeJson(path.join(directory,'status.json'),{id,model,status:'infrastructure_error',result});throw error;
  }
  manifest.server={kind:clockKind==='paused'?'fabric-carpet':'vanilla',...(clockKind==='paused'?{fabricLoader:server.installation.fabricLoader,fabricHash:server.installation.fabricHash,carpetSha256:server.installation.carpetSha256}:{sha1:server.installation.sha1})};
  const token=randomBytes(32).toString('hex');
  const clock=clockKind==='paused'?new PausedClock({command:c=>server.command(c),bot}):new RealClock();
  const session={id,directory,runtime,scenario,manifest,log,server,bot,token,clock,abort:new AbortController(),started:false,finished:false,finishing:false,infrastructureError:null,metrics:{modelCalls:0,inputTokens:0,outputTokens:0,inferenceMs:0,costUsd:null,costReportingComplete:true},result:null,agentApi:null};
  const elapsed=()=>clock.elapsed();
  session.controller=new Controller(bot,{radius:scenario.observationRadius,clock:elapsed,onEvent:(t,d)=>log.event(t,d)});
  session.referee=new Referee(server,{scenario,clock:elapsed,onEvent:(t,d)=>log.event(t,d)});
  session.manager=new ActionManager({execute:(...args)=>session.controller.execute(...args),stop:()=>session.controller.stop(),onEvent:(t,d)=>log.event(t,d),onFault:reason=>{if(session.reconnecting){session.manager.poisoned=false;log.event('fault_during_reconnect',{reason});return;}session.infrastructureError=reason;void session.finish('controller_fault');},clock:elapsed,deadline:Infinity,maxSeconds:scenario.maxActionSeconds});
  session.remaining=()=>session.started?Math.max(0,durationMs-elapsed()):durationMs;
  session.observation=()=>({...session.controller.observe(),run:{id,clock:clockKind,remainingMs:session.remaining(),started:session.started,finished:session.finished},actions:session.manager.status()});
  session.begin=async()=>{
    if(session.started)return;if(session.beginning)return session.beginning;
    session.beginning=(async()=>{
      await applyStart(session);
      await session.referee.arm();
      session.started=true;log.start=performance.now();clock.begin();session.manager.deadline=durationMs;
      if(clockKind==='paused')await clock.freeze();
      log.event('run_start',{manifest});
      session.deadlineTimer=setTimeout(()=>void session.finish(clockKind==='paused'?'wall_limit':'deadline'),clockKind==='paused'?wallLimitSeconds(scenario)*1000:durationMs);
      let lastFrame=0;
      session.timer=setInterval(async()=>{
        if(session.finished||session.finishing||session.sampling)return;session.sampling=true;
        try{const observation=session.observation();session.lastObservation=observation;
          // A frozen world does not change; sample it every ten seconds instead of twice a second.
          if(!clock.frozen||performance.now()-lastFrame>10000){log.event('frame',observation);lastFrame=performance.now();}
          await session.referee.poll();session.stallSince=null;
          await writeJson(path.join(directory,'status.json'),{id,model,scenario:scenario.id,status:'running',clock:clockKind,remainingMs:session.remaining(),observation,metrics:session.metrics,milestones:session.referee.milestones,route:ladder(scenario),approach:session.referee.approachSummary(),viewerUrl:session.viewerUrl??null});
          onStatus(session);
          if(session.remaining()<=0)void session.finish('deadline');
          else if((scenario.goal?.type??'dragon')==='dragon'){if(session.referee.observed.exitEnd!==undefined&&session.referee.observed.dragonDead!==undefined)void session.finish('exit');}
          else if(session.referee.observed[scenario.goal.type==='items'?'goal':scenario.goal.name]!==undefined)void session.finish('goal');
        }catch(error){
          // A server stall longer than the RCON timeout is logged and polling resumes; only a server that stays
          // unresponsive for a minute ends the run. Checkpoint ticks come from the server, so ordering is unaffected.
          if(/Timeout for packet/.test(errorText(error))){session.stallSince??=performance.now();session.metrics.refereeStalls=(session.metrics.refereeStalls??0)+1;log.event('referee_stall',{message:errorText(error)});
            if(performance.now()-session.stallSince<60000)return;}
          session.infrastructureError=errorText(error);void session.finish('referee_error');
        }finally{session.sampling=false;}
      },500);
      manifest.status='running';await writeJson(path.join(directory,'manifest.json'),manifest);
    })();return session.beginning;
  };
  // Paused clock: every mutating action runs to completion (or its time slice) with the world running, then
  // the world freezes again and the call returns the result with a fresh observation. `wait` runs the world.
  const pausedTool=async(name,args)=>{
    if(name==='cancel')return session.manager.cancel();
    try{
      const outcome=await clock.run(async()=>{
        if(name==='wait'){await sleep(Math.min(args.seconds*1000,session.remaining()));return {ok:true};}
        const started=session.manager.start(name,args);if(!started.ok)return started;
        return {ok:true,action:await session.manager.active.done};
      });
      if(session.remaining()<=0)void session.finish('deadline');
      return outcome.ok?{...outcome,observation:session.observation()}:outcome;
    }catch(error){
      if(session.finishing||session.finished)return {ok:false,error:'run_finished'};
      session.infrastructureError=`Clock control failed: ${errorText(error)}`;void session.finish('clock_error');return {ok:false,error:'run_finished'};
    }
  };
  session.tool=async(name,args={})=>{
    if(session.finishing||session.finished)return {ok:false,error:'run_finished'};
    if(!schemas[name])return {ok:false,error:'unknown_tool'};
    const parsed=schemas[name].safeParse(args);if(!parsed.success)return {ok:false,error:'invalid_arguments',details:parsed.error.issues};
    await session.begin();
    if(session.remaining()<=0||session.finishing)return {ok:false,error:'run_finished'};
    log.event('tool_call',{name,args:parsed.data});
    if(name==='observe')return session.observation();
    if(name==='recipes')return session.controller.recipes(parsed.data.item);
    if(clockKind==='paused')return pausedTool(name,parsed.data);
    // Waiting ends early when the running action settles, so polling costs no extra game time.
    if(name==='wait'){const active=session.manager.active;await Promise.race([sleep(Math.min(parsed.data.seconds*1000,session.remaining())),...(active?[active.done]:[])]);return session.observation();}
    if(name==='cancel')return session.manager.cancel();
    return session.manager.start(name,parsed.data);
  };
  session.finish=async(reason='stopped')=>{
    if(session.finishPromise)return session.finishPromise;
    session.finishing=true;session.abort.abort('run_finished');clearInterval(session.timer);clearTimeout(session.deadlineTimer);
    session.finishPromise=(async()=>{
      const elapsedMs=elapsed(),wallMs=log.elapsed();
      await session.manager.shutdown();
      // Do not credit events discovered after the deadline. Last known
      // in-window evidence is retained; persistent NBT only corroborates it.
      while(session.sampling||session.referee.polling)await sleep(20);
      if(session.started&&elapsed()<durationMs)try{await session.referee.poll();}catch(error){session.infrastructureError??=errorText(error);}
      try{await server.command('scoreboard players set #armed mb_dragon 0');}catch(error){session.infrastructureError??=errorText(error);}
      await clock.close().catch(()=>{});
      if(session.bot.currentWindow)session.bot.closeWindow(session.bot.currentWindow);
      session.bot.quit();await sleep(200);
      try{await server.stop();}catch(error){session.infrastructureError??=errorText(error);}
      // The server's own "Can't keep up" warnings: a stalled world is part of what the model faced.
      let evidence,serverLag=null;
      try{const lags=[...(await fs.readFile(path.join(runtime,'console.log'),'utf8')).matchAll(/Running (\d+)ms or \d+ ticks behind/g)].map(m=>Number(m[1]));
        serverLag={warnings:lags.length,maxMs:lags.length?Math.max(...lags):0,totalMs:lags.reduce((a,b)=>a+b,0)};}catch{}
      try{evidence=await readWorldEvidence(runtime);}catch(error){session.infrastructureError??=`Evidence unavailable: ${errorText(error)}`;}
      const protocolHash=sha256(JSON.stringify({scenario,snapshotHash:manifest.snapshotHash,controllerHash:manifest.controllerHash,dependencyHash:manifest.dependencyHash,durationSeconds,modelSettings:manifest.modelSettings??null}));
      session.result={id,model,scenario:scenario.id,protocolHash,...grade({evidence,observed:session.referee.observed,last:session.referee.last,durationMs,elapsedMs,infrastructureError:session.infrastructureError,kind,milestones:session.referee.milestones,route:ladder(scenario),approach:session.referee.approachSummary(),scenario}),
        clock:{kind:clockKind,courseMs:Math.round(elapsedMs),wallMs:Math.round(wallMs),...(clockKind==='paused'?{freezes:clock.freezes}:{})},serverLag,reason,metrics:session.metrics};
      session.finished=true;log.event('result',session.result);
      await writeJson(path.join(directory,'result.json'),session.result);
      manifest.status=session.result.outcome;await writeJson(path.join(directory,'manifest.json'),manifest);
      await writeJson(path.join(directory,'status.json'),{id,model,status:session.result.outcome,result:session.result,observation:session.lastObservation??null});
      await session.closeViewer?.();await session.closeApi?.();return session.result;
    })();return session.finishPromise;
  };
  manifest.status='ready';await writeJson(path.join(directory,'manifest.json'),manifest);
  await writeJson(path.join(directory,'status.json'),{id,model,status:'ready',scenario:scenario.id,remainingMs:durationMs});
  // A connection loss is an infrastructure event, not gameplay: this machine can freeze a process long enough for
  // the server to time the client out. The bot logs back in where the player was and the run continues; the
  // clock keeps running (real time) and every reconnect is logged and counted. Five failed attempts end the run.
  const reconnect=async reason=>{
    if(session.reconnecting||session.finishing)return;session.reconnecting=true;
    session.metrics.reconnects=(session.metrics.reconnects??0)+1;log.event('client_reconnect',{reason:String(reason??'')});
    session.manager.active?.abort.abort('client_disconnected');
    for(let attempt=1;attempt<=5&&!session.finishing;attempt++){
      try{
        const next=await connectBot(server.port,{version:scenario.minecraft,onEvent:(t,d)=>log.event(t,d)});
        const previous=session.controller;session.bot=next;clock.bot=next;
        session.controller=new Controller(next,{radius:scenario.observationRadius,clock:elapsed,onEvent:(t,d)=>log.event(t,d)});
        session.controller.discovered=previous.discovered;session.controller.lastSwing=previous.lastSwing;
        if(clock.frozen)next.physicsEnabled=false;
        await session.manager.active?.done;session.manager.poisoned=false;
        next.on('end',reason=>{if(session.started&&!session.finishing)void reconnect(reason);});
        log.event('client_reconnected',{attempt});session.reconnecting=false;return;
      }catch(error){log.event('client_reconnect_failed',{attempt,message:errorText(error)});await sleep(3000);}
    }
    session.reconnecting=false;
    if(!session.finishing){session.infrastructureError='Minecraft client disconnected and could not reconnect';void session.finish('disconnected');}
  };
  bot.on('end',reason=>{if(session.started&&!session.finishing)void reconnect(reason);});
  return session;
}
