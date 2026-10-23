import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { loadScenario, sleep, PLAYER } from '../src/util.mjs';
import { createSession } from '../src/session.mjs';

// Fixture only: privileged effects, items, teleports and a forced landing set up a dragon
// fight so that perception and the shared attack tool can be checked against the server.
const {values}=parseArgs({options:{scenario:{type:'string',default:'speedrun'}}});
const scenario=await loadScenario(values.scenario);
const session=await createSession({scenario,kind:'fixture',model:'dragon-perception-test',durationSeconds:150});
const cmd=c=>session.server.command(c),observe=()=>session.observation();
const until=async(predicate,ms,message)=>{const end=Date.now()+ms;let last;while(Date.now()<end){last=observe();if(predicate(last))return last;await sleep(250);}assert.fail(`${message}; dragon=${JSON.stringify(last?.dragon)}`);};
try{
  await session.begin();
  for(const effect of ['resistance 150 4','slow_falling 150 0','regeneration 150 4'])await cmd(`effect give ${PLAYER} minecraft:${effect} true`);
  await cmd(`give ${PLAYER} minecraft:iron_sword`);
  assert.equal(observe().dragon,undefined,'No dragon report outside the End');
  // Regression: a dig still running when the player changed dimension never settled and faulted the controller.
  const [fx,fy,fz]=observe().position.map(Math.floor),beside=[fx+2,fy,fz];
  await cmd(`fill ${fx-3} ${fy} ${fz-3} ${fx+3} ${fy+4} ${fz+3} minecraft:air`);await cmd(`fill ${fx-3} ${fy-1} ${fz-3} ${fx+3} ${fy-1} ${fz+3} minecraft:stone`);
  await cmd(`tp ${PLAYER} ${fx+.5} ${fy} ${fz+.5}`);await cmd(`setblock ${beside.join(' ')} minecraft:dirt`);await sleep(1000);
  const dig=await session.tool('mine',{position:beside});assert.equal(dig.ok,true,JSON.stringify(dig));
  await cmd(`execute in minecraft:the_end run tp ${PLAYER} 0.5 75 14.5`);
  await session.manager.active?.done;
  assert.equal(session.manager.last.error,'dimension_changed',JSON.stringify(session.manager.last));assert.equal(session.manager.poisoned,false);
  const far=await until(o=>o.dimension==='the_end'&&o.dragon?.health===200,20000,'Boss-bar health in the End');
  const seen=await until(o=>o.dragon?.visible&&o.dragon.distance>24,40000,'Dragon visible beyond the 24-block entity radius');
  console.log(`seen at ${seen.dragon.distance} blocks, state ${seen.dragon.state}; health first reported ${far.dragon.health}`);
  await session.controller.execute('equip',{item:'iron_sword',destination:'hand'},new AbortController().signal);
  await cmd('execute in minecraft:the_end as @e[type=minecraft:ender_dragon,limit=1] run data merge entity @s {DragonPhase:3}');
  const perched=await until(o=>/^perched/.test(o.dragon?.state??''),45000,'Dragon perched after forced landing');
  console.log(`perched at ${perched.dragon.position}, head ${perched.dragon.head}`);
  // Stand beside the head on a fixture block, facing it. A perched dragon turns its head, so a swing that finds
  // no part in reach re-places the player beside the current head (fixture positioning, not the attack tool).
  let swing;
  for(let attempt=0;attempt<3;attempt++){
    const [hx,hy,hz]=(attempt?observe().dragon?.head:null)??perched.dragon.head;
    await cmd(`execute in minecraft:the_end run setblock ${Math.floor(hx)} ${Math.floor(hy)-2} ${Math.floor(hz)+3} minecraft:obsidian`);
    await cmd(`execute in minecraft:the_end run tp ${PLAYER} ${Math.floor(hx)+.5} ${Math.floor(hy)-1} ${Math.floor(hz)+3.5}`);
    await sleep(1000);
    const started=await session.tool('attack',{entity:perched.dragon.id,seconds:3});assert.equal(started.ok,true,JSON.stringify(started));
    await session.manager.active?.done;swing=session.manager.last;if(swing.error!=='out_of_reach')break;
  }
  console.log('attack',JSON.stringify(swing));
  assert.equal(swing.ok,true,JSON.stringify(swing));
  await until(()=>session.referee.milestones.dragonDamaged!==undefined,5000,'Server recorded dragon damage from the attack tool');
  const after=observe();assert.ok(after.dragon.health<200||session.referee.last.dragonHealthMin<200,JSON.stringify(after.dragon));
  // Regression: dying beside a perched dragon once made a failed health read record as 0.
  await sleep(1500);await session.referee.poll();const lowest=session.referee.last.dragonHealthMin; // after the last hit is polled
  await cmd(`kill ${PLAYER}`);await sleep(3000);await session.referee.poll();
  assert.equal(session.referee.last.dragonHealthMin,lowest,`Health minimum changed after the player died: ${lowest} -> ${session.referee.last.dragonHealthMin}`);
  assert.equal(session.referee.milestones.dragonHalf,undefined,'No half-health checkpoint without real damage');
  const result=await session.finish('fixture_complete');
  assert.equal(result.success,false);assert.equal(result.eligible,false);assert.ok(result.dragonHealthMin<200,`dragonHealthMin=${result.dragonHealthMin}`);
  console.log(`PASS ${scenario.id} (${scenario.minecraft}): dig interrupted by a dimension change, boss-bar health, long-range dragon sighting, perch state, and melee damage through part targeting (min health ${result.dragonHealthMin}); fixture excluded.`);
}finally{await session.finish('fixture_cleanup');}
