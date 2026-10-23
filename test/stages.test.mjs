import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { grade, scoreRun, scoreSegments } from '../src/referee.mjs';
import { loadScenario, validateScenario, sharedLandmarks, sha256, sleep } from '../src/util.mjs';
import { systemPrompt } from '../src/models.mjs';
import { toolDefinitions } from '../src/agent-api.mjs';
import { PausedClock } from '../src/clock.mjs';
import { Controller } from '../src/controller.mjs';
import { installRefereePack } from '../src/datapack.mjs';

const T=600000;
test('score v2 rewards earlier checkpoints, and any checkpoint beats partial progress',()=>{
  const scenario={score:[{checkpoint:'landmark0',partial:{approach:0}},{checkpoint:'dragonDead',partial:'dragonDamage'}]};
  const approach=[{startDistance:1000,closestDistance:250}];
  const early=scoreRun({scenario,durationMs:T,milestones:{landmark0:{wallMs:60000}},approach});
  const late=scoreRun({scenario,durationMs:T,milestones:{landmark0:{wallMs:540000}},approach});
  const partial=scoreRun({scenario,durationMs:T,milestones:{},approach});
  assert.ok(early.value>late.value&&late.value>partial.value,JSON.stringify([early.value,late.value,partial.value]));
  assert.equal(early.segments[0].credit,0.95);assert.equal(late.segments[0].credit,0.55);
  assert.equal(partial.segments[0].credit,0.375,'Three quarters of the distance closed is worth 0.375');
  // A reached checkpoint at the deadline (0.5) is never below the best partial credit (just under 0.5).
  assert.equal(scoreRun({scenario,durationMs:T,milestones:{landmark0:{wallMs:T}},approach}).segments[0].credit,0.5);
  // Dragon damage is partial credit for the kill; a late checkpoint after the deadline does not count.
  const damaged=scoreRun({scenario,durationMs:T,milestones:{landmark0:{wallMs:T+1}},approach,last:{dragonSeen:1,dragonHealthMin:150}});
  assert.equal(damaged.segments[0].reachedMs,null);assert.equal(damaged.segments[1].credit,0.125);
});
test('score v2 defaults follow the course goal and 3D approach is available',()=>{
  assert.deepEqual(scoreSegments({}).map(s=>s.checkpoint),['enteredEnd','dragonDead','exitEnd']);
  assert.deepEqual(scoreSegments({goal:{type:'milestone',name:'endSafe'}}),[{checkpoint:'endSafe'}]);
  assert.deepEqual(scoreSegments({goal:{type:'items',item:'blaze_rod',count:6}}),[{checkpoint:'goal',partial:'goalItems'}]);
  const r=scoreRun({scenario:{score:[{checkpoint:'endSafe',partial:{approach:0,metric:'3d'}}]},durationMs:T,approach:[{startDistance:1,closestDistance:1,start3d:54,closest3d:27}]});
  assert.equal(r.segments[0].partial,0.5);
  const items=scoreRun({scenario:{goal:{type:'items',item:'blaze_rod',count:6}},durationMs:T,last:{goalItems:3}});
  assert.equal(items.value,0.25);
});
test('milestone and item goals need their server checkpoint in time and a Survival player',()=>{
  const scenario={goal:{type:'milestone',name:'endSafe'}};
  const ok=grade({evidence:{gameType:0},observed:{endSafe:30000},last:{},durationMs:T,elapsedMs:30000,milestones:{endSafe:{wallMs:30000}},scenario});
  assert.equal(ok.success,true);assert.equal(ok.completionMs,30000);assert.equal(ok.outcome,'success');
  assert.equal(grade({evidence:{gameType:0},observed:{endSafe:T+1},last:{},durationMs:T,elapsedMs:T,scenario}).success,false,'Late');
  assert.equal(grade({evidence:{gameType:1},observed:{endSafe:30000},last:{},durationMs:T,elapsedMs:30000,scenario}).success,false,'Creative');
  assert.equal(grade({evidence:{gameType:0},observed:{endSafe:30000},last:{},durationMs:T,elapsedMs:30000,scenario,kind:'fixture'}).success,false,'Fixture');
  const items=grade({evidence:{gameType:0},observed:{goal:5000},last:{goalItems:6},durationMs:T,elapsedMs:5000,scenario:{goal:{type:'items',item:'blaze_rod',count:6}}});
  assert.equal(items.success,true);assert.equal(items.goalItems,6);
  // The dragon goal still needs the saved kill: a milestone alone is not a win.
  assert.equal(grade({evidence:{gameType:0},observed:{dragonDead:1000,exitEnd:2000},last:{},durationMs:T,elapsedMs:2000,scenario:{}}).success,false);
});
test('every course loads; invalid goals, kits, setup commands and load areas are rejected',async()=>{
  for(const file of await fs.readdir(new URL('../scenarios/',import.meta.url)))await loadScenario(file.replace(/\.json$/,''));
  const base=await loadScenario('speedrun');
  for(const bad of [{goal:{type:'win'}},{goal:{type:'items',item:'Blaze Rod',count:6}},{goal:{type:'milestone'}},{start:{kit:[['iron_sword',65]]}},
    {start:{commands:['op BenchAgent']}},{start:{commands:['stop']}},{start:{load:[['overworld',0,0,1]]}},{clock:'fast'}])
    assert.throws(()=>validateScenario({...base,...bad}),undefined,JSON.stringify(bad));
  assert.deepEqual(sharedLandmarks({landmarks:[{name:'a',position:[0,0,0]},{name:'b',hidden:true,position:[1,1,1]}]}),[{name:'a',position:[0,0,0]}]);
});
test('the real-clock prompt is unchanged; the paused prompt and tools describe blocking actions',async()=>{
  const speedrun=await loadScenario('speedrun');
  assert.equal(sha256(systemPrompt(speedrun)),'39204d0ca7f361de437577b9736fd8a526fab356d859d3afebda114769f78f38');
  const paused=systemPrompt(await loadScenario('speedrun-paused'));
  assert.match(paused,/game-time deadline/);assert.match(paused,/paused while you think/);assert.doesNotMatch(paused,/asynchronous/);
  const stage=systemPrompt(await loadScenario('speedrun-reentry'));assert.match(stage,/objective is to get back into the End alive/);
  const tools=Object.fromEntries(toolDefinitions({clock:'paused'}).map(t=>[t.name,t.description]));
  assert.doesNotMatch(tools.move_to,/Return immediately/);assert.match(toolDefinitions({})[1].description,/Return immediately/);
});
function fakeClockServer(){
  const state={frozen:false,regen:true,log:[]};
  const command=async c=>{state.log.push(c);
    if(c==='tick freeze'){state.frozen=!state.frozen;return state.frozen?'Game is frozen':'Game runs normally';}
    if(c.startsWith('gamerule naturalRegeneration')){state.regen=c.endsWith('true');return 'Gamerule updated';}
    return '';};
  return {state,command,bot:{physicsEnabled:true,clearControlStates(){}}};
}
test('the paused clock counts only time inside tool calls and keeps the world frozen between them',async()=>{
  const {state,command,bot}=fakeClockServer();const clock=new PausedClock({command,bot});
  await clock.freeze();assert.equal(state.frozen,true);assert.equal(bot.physicsEnabled,false);assert.equal(state.regen,false);
  await sleep(120);assert.ok(clock.elapsed()<5,'Frozen time does not count');
  await clock.run(()=>sleep(100));
  assert.ok(clock.elapsed()>=90&&clock.elapsed()<200,String(clock.elapsed()));assert.equal(state.frozen,true);assert.equal(state.regen,false);assert.equal(bot.physicsEnabled,false);
  // Overlapping calls run one after another, each with the world running.
  let inside=0,overlap=false;
  await Promise.all([1,2,3].map(()=>clock.run(async()=>{inside++;if(inside>1)overlap=true;assert.equal(state.frozen,false);await sleep(20);inside--;})));
  assert.equal(overlap,false);assert.equal(state.frozen,true);
  // A toggle that lands in the wrong state is corrected; a failing action still refreezes.
  state.frozen=false;clock.frozen=false;await clock.freeze();assert.equal(state.frozen,true);
  await assert.rejects(clock.run(async()=>{throw new Error('boom');}),/boom/);assert.equal(state.frozen,true);
});
test('attacks are spaced by course time across calls, so short calls cannot outpace the cooldown',async()=>{
  const bot=Object.assign(new EventEmitter(),{_client:new EventEmitter(),game:{dimension:'overworld'},health:20,
    entity:{position:new Vec3(0,64,0),height:1.8},world:{raycast:()=>null},lookAt:async()=>{},swings:[]});
  bot.entities={7:{id:7,name:'zombie',position:new Vec3(2,64,0),height:1.9}};bot.attack=()=>bot.swings.push(performance.now());
  const controller=new Controller(bot,{clock:()=>performance.now()}),signal=new AbortController().signal;
  for(let i=0;i<4;i++)await controller.perform('attack',{entity:7,seconds:0.2},signal);
  assert.ok(bot.swings.length<=2,`swings ${bot.swings.length}`);
  for(let i=1;i<bot.swings.length;i++)assert.ok(bot.swings[i]-bot.swings[i-1]>=640,`gap ${bot.swings[i]-bot.swings[i-1]}`);
});
test('stage datapack tracks End time, crystals and goal items within objective limits',async()=>{
  const world=await fs.mkdtemp(path.join(os.tmpdir(),'bench-pack-'));
  try{
    for(const id of ['speedrun-dragon','speedrun-nether']){
      await installRefereePack(world,await loadScenario(id));
      const base=path.join(world,'datapacks','minecraft_bench'),load=await fs.readFile(path.join(base,'data/bench/functions/load.mcfunction'),'utf8'),tick=await fs.readFile(path.join(base,'data/bench/functions/tick.mcfunction'),'utf8');
      for(const name of load.match(/objectives add (\S+)/g).map(s=>s.split(' ')[2]))assert.ok(name.length<=16,name);
      assert.match(tick,/@e\[type=minecraft:player,name=BenchAgent,x=0,y=0,z=0,distance=0\.\.\] run scoreboard players add @s mb_endt 1/);
      if(id==='speedrun-dragon'){assert.equal(tick.match(/minecraft:end_crystal/g).length,10);assert.match(tick,/if block 42 76 0 minecraft:bedrock unless entity @e\[type=minecraft:end_crystal,x=42.5,y=77,z=0.5/);}
      else{assert.match(tick,/store result score @s mb_goal run clear @s minecraft:blaze_rod 0/);assert.match(tick,/#goal_max mb_dragon matches 6\.\./);assert.doesNotMatch(tick,/end_crystal/);}
    }
  }finally{await fs.rm(world,{recursive:true,force:true});}
});
