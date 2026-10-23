import assert from 'node:assert/strict';
import path from 'node:path';
import { loadScenario, sleep, PLAYER, DATA, writeJson } from '../src/util.mjs';
import { createSession } from '../src/session.mjs';
import { startAgentApi } from '../src/agent-api.mjs';

const scenario=await loadScenario('sprint');
const results=[];let session;
async function action(name,args){const started=await session.tool(name,args);assert.equal(started.ok,true,JSON.stringify(started));if(started.action){await session.manager.active?.done;const result=session.manager.last;assert.equal(result.ok,true,JSON.stringify(result));return result.value;}return started;}
try{
  if(!process.argv.includes('--victory-only')){
  session=await createSession({scenario,kind:'fixture',model:'tool-integration-test',durationSeconds:60});
  // Privileged commands below are fixture setup in an isolated copied world.
  // No model evaluations use this path, and fixture results cannot enter scores.
  await session.server.command(`tp ${PLAYER} 0.5 90 0.5`);
  await sleep(1000);await session.bot.waitForChunksToLoad();
  await session.server.command('fill -5 70 -5 5 95 5 air');
  await session.server.command('fill -5 70 -5 5 70 5 stone');
  await session.server.command(`tp ${PLAYER} 0.5 71 0.5`);
  await session.server.command('setblock 2 71 0 oak_log');
  await session.server.command('setblock 3 71 1 chest{Items:[{Slot:0b,id:"minecraft:apple",Count:2b}]}');
  await sleep(500);
  const api=await startAgentApi(session);
  assert.equal((await fetch(`${api.url}/observe`)).status,401);
  const observed=await fetch(`${api.url}/observe`,{headers:{Authorization:`Bearer ${api.token}`}}).then(r=>r.json());
  assert.equal(observed.inventory.length,0);assert.ok(observed.blocks.some(b=>b.name==='oak_log'));
  await action('mine',{position:[2,71,0]});
  await action('move_to',{position:[2.5,71,.5],seconds:2,radius:.5});
  await sleep(500);
  assert.ok(session.bot.inventory.items().some(i=>i.name==='oak_log'),'Mined log was picked up');
  await action('craft',{item:'oak_planks',count:1});
  assert.equal(session.bot.inventory.items().find(i=>i.name==='oak_planks')?.count,4);
  await action('craft',{item:'crafting_table',count:1});
  await action('equip',{item:'crafting_table'});
  await action('place',{item:'crafting_table',reference:[1,70,-2],face:'up'});
  await action('open',{position:[3,71,1]});
  await action('transfer',{direction:'withdraw',item:'apple',count:2});
  await action('close',{});
  assert.equal(session.bot.inventory.items().find(i=>i.name==='apple')?.count,2);
  // Free movement: sprint, tower up, sneak safely at the edge, then walk off and fall.
  await session.server.command(`give ${PLAYER} minecraft:cobblestone 4`);
  await session.server.command(`tp ${PLAYER} 0.5 71 0.5`);await sleep(500);
  const sprint=await action('move',{toward:[-4.5,71,.5],sprint:true,seconds:.6});assert.ok(sprint.position[0]<-1,JSON.stringify(sprint));
  const tower=await action('pillar',{item:'cobblestone',count:3});assert.equal(tower.placed,3,JSON.stringify(tower));assert.ok(tower.position[1]>=73.9,JSON.stringify(tower));
  const edge=await action('move',{toward:[-4.5,74,.5],sneak:true,seconds:1});assert.ok(edge.position[1]>=73.9,`Sneaking walked off the pillar: ${JSON.stringify(edge)}`);
  const drop=await action('move',{toward:[4.5,74,.5],seconds:1.2});await sleep(300);assert.ok(session.bot.entity.position.y<71.5,JSON.stringify(drop));
  const missing=await session.tool('craft',{item:'diamond_sword',count:1,table:[1,71,-2]});assert.ok(missing.ok);await session.manager.active?.done;assert.equal(session.manager.last.ok,false);
  const move=await session.tool('move_to',{position:[-4,71,-4],seconds:10});assert.ok(move.ok);await sleep(100);await session.tool('cancel',{});assert.equal(session.manager.active,null);
  const negative=await session.finish('fixture_complete');assert.equal(negative.success,false);assert.equal(negative.eligible,false);assert.equal(negative.infrastructureError,null);results.push(negative);
  console.log('PASS: real mining, pickup, crafting, placing, chest transfer, free movement, pillaring, cancellation, API auth, and negative grading.');
  }

  session=await createSession({scenario,kind:'fixture',model:'victory-verifier-test',durationSeconds:90});
  await session.server.command('execute in minecraft:overworld run forceload add -1130 856');await sleep(1000);
  const portal=await session.server.command('execute in minecraft:overworld if block -1130 34 856 minecraft:end_portal');
  const portalVerified=/Test passed/.test(portal);
  await writeJson(path.join(DATA,'calibration','sprint-audit.json'),{at:new Date().toISOString(),portalVerified,response:portal,completionCalibrated:false,kind:'fixture-audit'});
  console.log(`Natural portal audit: ${portal}`);
  await session.server.command('execute in minecraft:overworld run forceload remove -1130 856');
  await session.server.command(`effect give ${PLAYER} minecraft:resistance 120 4 true`);
  await session.server.command(`effect give ${PLAYER} minecraft:slow_falling 120 0 true`);
  await session.begin();
  await session.server.command(`execute in minecraft:the_end run tp ${PLAYER} 0 75 0`);
  const dragonDeadline=Date.now()+20000;
  while(!session.referee.observed.dragonSeen&&Date.now()<dragonDeadline)await sleep(200);
  assert.notEqual(session.referee.observed.dragonSeen,undefined,'Referee observed live dragon');
  console.log(await session.server.command('execute in minecraft:the_end as @e[type=minecraft:ender_dragon,limit=1] run data merge entity @s {Health:0.0f,DragonPhase:9}'));
  const deathDeadline=Date.now()+30000;
  while(session.referee.observed.dragonDead===undefined&&Date.now()<deathDeadline)await sleep(200);
  if(session.referee.observed.dragonDead===undefined){console.log('Referee:',session.referee.last);console.log(await session.server.command('execute in minecraft:the_end run data get entity @e[type=minecraft:ender_dragon,limit=1]'));}
  assert.notEqual(session.referee.observed.dragonDead,undefined,'Referee observed dragon death');
  let y;
  for(let candidate=45;candidate<=85;candidate++){
    const response=await session.server.command(`execute in minecraft:the_end if block 1 ${candidate} 0 minecraft:end_portal`);
    if(/Test passed/.test(response)){y=candidate;break;}
  }
  assert.notEqual(y,undefined,'Exit portal generated');
  await session.server.command(`execute in minecraft:the_end run tp ${PLAYER} 1.5 ${y+.1} 0.5`);
  const exitDeadline=Date.now()+15000;
  while(!session.finishing&&Date.now()<exitDeadline)await sleep(200);
  const positive=await session.finish('fixture_complete');
  assert.equal(positive.verifiedGameplay,true,JSON.stringify(positive));
  assert.equal(positive.success,false,'Fixture must never count as a model win');assert.equal(positive.eligible,false);
  results.push(positive);console.log('PASS: server dragon-death + exit evidence, saved world/player corroboration, fixture exclusion.');
  await writeJson(path.join(DATA,'smoke-result.json'),{passed:true,at:new Date().toISOString(),runs:results.map(r=>r.id),portalVerified});
}finally{if(session)await session.finish('fixture_cleanup');}
