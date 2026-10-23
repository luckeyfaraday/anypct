import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { loadScenario, sleep, PLAYER } from '../src/util.mjs';
import { createSession } from '../src/session.mjs';
import { entityData } from '../src/referee.mjs';
import fs from 'node:fs';

// Fixtures only: privileged commands check stage start states, the new referee checkpoints, score v2 and
// the paused clock against real servers. Every result is a fixture and can never enter scores.
const {values}=parseArgs({options:{only:{type:'string'}}});
const wanted=name=>!values.only||values.only.split(',').includes(name);
const until=async(predicate,ms,message)=>{const end=Date.now()+ms;while(!(await predicate())){if(Date.now()>end)assert.fail(message);await sleep(250);}};
async function stage(id,body){
  const scenario=await loadScenario(id);
  const session=await createSession({scenario,kind:'fixture',model:'stage-test'});
  const cmd=c=>session.server.command(c),observe=()=>session.observation();
  try{await body({session,cmd,observe,scenario});console.log(`PASS ${id}`);}
  finally{await session.finish('fixture_cleanup');}
  return session.result;
}
const position=async cmd=>entityData(await cmd(`data get entity ${PLAYER} Pos`));

if(wanted('dragon'))await stage('speedrun-dragon',async({session,cmd,observe})=>{
  await session.begin();
  const o=observe();
  assert.equal(o.dimension,'the_end','Starts in the End');
  for(const item of ['iron_sword','iron_pickaxe','bow','arrow','cobblestone','white_bed','bread'])assert.ok(o.inventory.some(i=>i.name===item),`Kit has ${item}`);
  assert.ok(Math.abs(o.position[0]-100.5)<2&&Math.abs(o.position[2]-0.5)<2,`On the arrival platform: ${o.position}`);
  // The End clock counts only while alive in the End.
  await sleep(2500);await session.referee.poll();assert.ok(session.referee.last.endTicks>=30,`End ticks ${session.referee.last.endTicks}`);
  assert.equal(session.referee.milestones.enteredEnd,undefined,'The setup portal entry is not credited');
  // A crystal counts once its pillar is loaded and the crystal is gone.
  await cmd(`effect give ${PLAYER} minecraft:resistance 60 4 true`);
  await cmd(`execute in minecraft:the_end run tp ${PLAYER} 0.5 90 0.5`);await sleep(3000);
  await session.referee.poll();assert.equal(session.referee.last.crystalsDestroyed,0,'No crystal destroyed before any is removed');
  await cmd('execute in minecraft:the_end run kill @e[type=minecraft:end_crystal,x=42.5,y=77,z=0.5,distance=..2]');
  await until(async()=>(await session.referee.poll()).crystalsDestroyed===1,5000,'One destroyed crystal recorded');
  // Death respawns beside the stronghold portal in the Overworld.
  await cmd(`kill ${PLAYER}`);await sleep(1500);
  const r=await session.tool('respawn',{});assert.equal(r.ok,true,JSON.stringify(r));
  await until(()=>observe().dimension==='overworld',15000,'Respawned in the Overworld');
  const p=observe().position;assert.ok(Math.hypot(p[0]-1006.5,p[2]-1152.5)<2&&Math.abs(p[1]-25)<2,`Respawned on the portal frame: ${p}`);
  await session.referee.poll();
  const result=await session.finish('fixture_complete');
  assert.equal(result.crystalsDestroyed,1);assert.equal(result.deaths,1);assert.equal(result.eligible,false);
  assert.equal(result.score.version,2);assert.deepEqual(result.score.segments.map(s=>s.checkpoint),['dragonDead','exitEnd']);
  console.log('dragon stage score',JSON.stringify(result.score),'end seconds',result.endSeconds);
});

if(wanted('reentry'))await stage('speedrun-reentry',async({session,cmd,observe})=>{
  await session.begin();
  const o=observe();
  assert.equal(o.dimension,'overworld');assert.ok(Math.hypot(o.position[0]-1008.5,o.position[2]-1152.5)<1.5&&o.position[1]>=77,`Starts beside the shaft: ${o.position}`);
  assert.match(String(await cmd('execute if block 1007 40 1152 minecraft:air')),/passed/i,'The shaft is dug');
  assert.ok(o.inventory.some(i=>i.name==='stone_pickaxe'),'Kit has a pickaxe');
  // Falling the whole shaft into the portal kills on arrival (1.16.1 keeps fall distance through the portal).
  await cmd(`tp ${PLAYER} 1007.5 78 1152.5`);
  await until(async()=>(await session.referee.poll()).deaths>=1,30000,'A full-height drop into the portal is fatal');
  assert.equal(session.referee.milestones.endSafe,undefined,'Dying on arrival is not endSafe');
  assert.ok(session.referee.milestones.enteredEnd,'Entering is still recorded');
  const r=await session.tool('respawn',{});assert.equal(r.ok,true,JSON.stringify(r));
  await until(()=>observe().dimension==='overworld'&&observe().position[1]>70,15000,'Respawned at the start');
  // A short drop into the portal arrives alive; five seconds there completes the course.
  await cmd(`tp ${PLAYER} 1007.5 28 1152.5`);
  await until(()=>session.finishing,30000,'endSafe ends the course');
  const result=await session.finishPromise;
  assert.equal(result.outcome,'fixture_verified',JSON.stringify(result.checks));assert.equal(result.success,false);assert.equal(result.deaths,1);
  assert.ok(result.milestones.endSafe);
  console.log('reentry stage score',JSON.stringify(result.score));
});

if(wanted('nether'))await stage('speedrun-nether',async({session,cmd,observe})=>{
  await session.begin();
  const o=observe();
  assert.equal(o.dimension,'the_nether');
  assert.ok(o.inventory.some(i=>i.name==='iron_sword'),'Kit has a sword');
  assert.match(String(await cmd(`data get entity ${PLAYER} Inventory[{Slot:103b}].id`)),/iron_helmet/,'Helmet is worn');
  assert.match(String(await cmd('difficulty')),/easy/i,'Stage difficulty applied');
  await cmd(`give ${PLAYER} minecraft:blaze_rod 3`);
  await until(async()=>(await session.referee.poll()).goalItems===3,5000,'Held goal items counted');
  await cmd(`give ${PLAYER} minecraft:blaze_rod 3`);
  await until(()=>session.finishing,10000,'Six rods end the course');
  const result=await session.finishPromise;
  assert.equal(result.outcome,'fixture_verified');assert.equal(result.goalItems,6);
  console.log('nether stage score',JSON.stringify(result.score));
});

if(wanted('paused'))await stage('speedrun-dragon-paused',async({session,cmd,observe})=>{
  await session.begin();
  assert.equal(session.clock.frozen,true,'Frozen once the run starts');
  const dragon=async()=>entityData(await cmd('execute in minecraft:the_end run data get entity @e[type=minecraft:ender_dragon,limit=1] Pos'));
  await until(async()=>Array.isArray(await dragon()),15000,'Dragon loaded');
  const before=await dragon(),me=await position(cmd);
  await sleep(6000);
  assert.deepEqual(await dragon(),before,'The dragon does not move while frozen');
  assert.deepEqual(await position(cmd),me,'The player does not move while frozen');
  assert.match(String(await cmd('gamerule naturalRegeneration')),/false/,'No regeneration while frozen');
  assert.ok(session.clock.elapsed()<200,`Course clock stood still: ${session.clock.elapsed()}`);
  const waited=await session.tool('wait',{seconds:2});assert.equal(waited.ok,true);
  assert.notDeepEqual(await dragon(),before,'The dragon moves during wait');
  const course=session.clock.elapsed();assert.ok(course>=1900&&course<3000,`Course clock counted the wait: ${course}`);
  // An action runs to completion inside its call and returns the result with an observation.
  const jump=await session.tool('move',{direction:'none',jump:true,seconds:0.15});
  assert.equal(jump.ok,true,JSON.stringify(jump));assert.equal(jump.action.name,'move');assert.ok(jump.observation.position);
  // Frozen mid-air for longer than the floating limit must not kick the player.
  await sleep(6000);assert.equal(session.finishing,false,'Still connected after a long freeze mid-air');
  const mined=await session.tool('mine',{position:[0,0,0]});assert.equal(mined.ok,true);assert.equal(mined.action.ok,false,'A failed action is reported in the call result');
  const result=await session.finish('fixture_complete');
  assert.equal(result.clock.kind,'paused');assert.ok(result.clock.wallMs>result.clock.courseMs+10000,JSON.stringify(result.clock));
  console.log('paused clock',JSON.stringify(result.clock));
});
if(wanted('eye'))await stage('speedrun-overworld',async({session,cmd})=>{
  await session.begin();
  await cmd(`give ${PLAYER} minecraft:ender_eye 2`);await sleep(1000);
  await session.tool('equip',{item:'ender_eye'});await sleep(500);
  await session.tool('use',{seconds:5});await session.manager.active?.done;
  const {eye}=session.manager.last.value??{};assert.ok(eye?.seen,JSON.stringify(session.manager.last));
  // The stronghold portal room is at (1007, 1152), south-east of spawn (-224, 256).
  const [sx,,sz]=eye.from,want=[1007-sx,1152-sz],n=Math.hypot(...want),dot=(eye.heading[0]*want[0]+eye.heading[1]*want[1])/n;
  assert.ok(dot>0.95,`Eye heads toward the stronghold: ${JSON.stringify(eye)}`);
  console.log('eye of ender',JSON.stringify(eye));
});
// Regression: Mineflayer dropped all-air chunks as unloaded, so a player who left the island hung in mid-air
// over the void (client physics stalled) and the next look never finished, faulting the controller.
if(wanted('void'))await stage('speedrun-dragon',async({session,cmd})=>{
  await session.begin();
  // Just past the island's edge, where a real run walked off: the empty chunk was sent but dropped.
  await until(()=>!!session.bot.world.getColumn(8,0),15000,'The empty void column beside the island is kept');
  await cmd(`execute in minecraft:the_end run tp ${PLAYER} 135.5 60 0.5`);
  const look=await session.tool('look_at',{position:[135,0,10]});assert.equal(look.ok,true);
  await until(async()=>(await session.referee.poll()).deaths>=1,30000,'Falling into the void kills instead of hanging in mid-air');
  await session.manager.active?.done;assert.equal(session.manager.poisoned,false,'No controller fault');
  // Lying dead below the world while the model decides to respawn must not get the player kicked for floating.
  await sleep(6000);assert.equal(session.finishing,false,'Still connected while dead in the void');
  const respawned=await session.tool('respawn',{});assert.equal(respawned.ok,true,JSON.stringify(respawned));
});
// A lost connection (here a kick) reconnects and the run goes on where the player was.
if(wanted('reconnect'))await stage('speedrun-dragon',async({session,cmd,observe})=>{
  await session.begin();const before=observe().position;
  await cmd(`kick ${PLAYER} connection test`);
  await until(()=>session.metrics.reconnects===1&&!session.reconnecting,60000,'Reconnected after the kick');
  assert.equal(session.finishing,false,'The run continues');
  const o=observe();assert.equal(o.dimension,'the_end');assert.ok(Math.hypot(o.position[0]-before[0],o.position[2]-before[2])<2,`Same place: ${o.position} vs ${before}`);
  const look=await session.tool('look_at',{position:[0,64,0]});assert.equal(look.ok,true);await session.manager.active?.done;assert.equal(session.manager.last.ok,true,JSON.stringify(session.manager.last));
  const result=await session.finish('fixture_complete');assert.equal(result.metrics.reconnects,1);assert.equal(result.infrastructureError,null);
});
// The held-out course is unpublished: the public harness doesn't have it, so the stage is skipped there.
if(wanted('heldout')&&fs.existsSync(new URL('../scenarios/heldout-1-locate.json',import.meta.url)))await stage('heldout-1-locate',async({session,cmd,observe})=>{
  await session.begin();
  // Setup released its forced chunk; load it again to inspect the portal.
  await cmd('forceload add 921 1114 925 1118');await until(async()=>!/not loaded/.test(String(await cmd('execute if block 923 34 1116 minecraft:end_portal'))),15000,'Portal chunk loads');
  for(const [x,z] of [[922,1115],[923,1116],[924,1117]])assert.match(String(await cmd(`execute if block ${x} 34 ${z} minecraft:end_portal`)),/passed/i,`Portal lit at ${x},${z}`);
  assert.match(String(await cmd('execute if block 921 34 1116 minecraft:end_portal_frame[eye=true,facing=east]')),/passed/i,'Frames hold eyes');await cmd('forceload remove 921 1114 925 1118');
  assert.ok(observe().inventory.some(i=>i.name==='ender_eye'&&i.count===8),'Eight eyes of ender');
  await session.tool('equip',{item:'ender_eye'});await sleep(500);
  await session.tool('use',{seconds:5});await session.manager.active?.done;
  const {eye}=session.manager.last.value??{};assert.ok(eye?.seen,JSON.stringify(session.manager.last));
  const [sx,,sz]=eye.from,want=[923-sx,1116-sz],dot=(eye.heading[0]*want[0]+eye.heading[1]*want[1])/Math.hypot(...want);
  assert.ok(dot>0.95,`Eye heads toward the hidden stronghold: ${JSON.stringify(eye)}`);
  console.log('held-out eye of ender',JSON.stringify(eye));
});
console.log('PASS stage smoke: start states, End time, crystals, endSafe, goal items, score v2, paused clock; fixtures excluded.');
