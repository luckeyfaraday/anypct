import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { loadScenario, sleep, PLAYER } from '../src/util.mjs';
import { createSession } from '../src/session.mjs';
import { landmarkName } from '../src/referee.mjs';

// Fixture only: privileged give/teleport/data commands exercise the server-owned
// checkpoint recorders. Fixture results are permanently excluded from scores.
const {values}=parseArgs({options:{scenario:{type:'string',default:'sprint'}}});
const scenario=await loadScenario(values.scenario);
const session=await createSession({scenario,kind:'fixture',model:'milestone-recorder-test',durationSeconds:120});
const until=async(names,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end&&names.some(n=>session.referee.milestones[n]===undefined))await sleep(200);
  const missing=names.filter(n=>session.referee.milestones[n]===undefined);assert.deepEqual(missing,[],`Missing checkpoints ${missing.join(', ')}; last=${JSON.stringify(session.referee.last)}`);};
try{
  await session.begin();
  await session.server.command(`effect give ${PLAYER} minecraft:resistance 120 4 true`);
  await session.server.command(`effect give ${PLAYER} minecraft:slow_falling 120 0 true`);
  for(const item of ['oak_log','crafting_table','wooden_pickaxe','stone_pickaxe','iron_ingot','white_bed'])await session.server.command(`give ${PLAYER} minecraft:${item}`);
  await until(['wood','craftingTable','pickaxe','stonePickaxe','ironIngot','bed']);
  assert.equal(session.referee.milestones.flintAndSteel,undefined,'Unheld items are not credited');
  // The supplied End portal landmark is an active portal block: standing in it also enters the End.
  const index=scenario.landmarks.length-1,[x,y,z]=scenario.landmarks[index].position;
  // Closest approach is sampled at the referee's 2 Hz poll, so pause above the landmark first.
  await session.server.command(`tp ${PLAYER} ${x+.5} 200 ${z+.5}`);await sleep(1500);
  await session.server.command(`tp ${PLAYER} ${x+.5} ${y} ${z+.5}`);
  await until([landmarkName(index),'enteredEnd'],30000);
  assert.ok(session.referee.approachSummary()[index].closestDistance<=1,JSON.stringify(session.referee.approachSummary()));
  await session.server.command(`execute in minecraft:the_end run tp ${PLAYER} 0 75 0`);
  await until(['dragonSeen']);
  await session.server.command('execute in minecraft:the_end as @e[type=minecraft:ender_dragon,limit=1] run data merge entity @s {Health:90.0f}');
  await until(['dragonDamaged','dragonHalf']);
  const result=await session.finish('fixture_complete');
  assert.equal(result.success,false);assert.equal(result.eligible,false);assert.equal(result.infrastructureError,null);
  assert.ok(result.dragonHealthMin<=90,`dragonHealthMin=${result.dragonHealthMin}`);
  for(const name of ['wood','craftingTable','pickaxe',landmarkName(index),'enteredEnd','dragonDamaged','dragonHalf'])if(result.progress.route.includes(name))assert.ok(result.progress.reached.includes(name),name);
  console.log(`PASS ${scenario.id} (${scenario.minecraft}): item, landmark, End and dragon-health checkpoints recorded by the server; route progress ${result.progress.reached.length}/${result.progress.route.length}; fixture excluded.`);
}finally{await session.finish('fixture_cleanup');}
