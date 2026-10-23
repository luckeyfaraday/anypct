import fs from 'node:fs/promises';
import path from 'node:path';
import { PLAYER, writeJson } from './util.mjs';
import { ITEM_MILESTONES, LANDMARK_RADIUS } from './referee.mjs';

// This pack records observations only. It never changes health, AI, items, or movement.
// All objectives are <= 16 characters for Java 1.16.
export async function installRefereePack(world, scenario) {
  const base = path.join(world, 'datapacks', 'minecraft_bench');
  const put = async (name, text) => { const p = path.join(base,name); await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,text+'\n'); };
  const landmarks = (scenario.landmarks ?? []).map((l,i)=>({...l,objective:`mb_lm${i}`}));
  // Record a player checkpoint once, at the referee tick it first happened.
  const once = objective => `execute if score #armed mb_dragon matches 1 unless score @s ${objective} matches 1.. run scoreboard players operation @s ${objective} = #ticks mb_clock`;
  await writeJson(path.join(base,'pack.mcmeta'), { pack:{ pack_format:scenario.minecraft==='1.16.1'?5:6, description:'Minecraft Bench independent event recorder v2' } });
  await writeJson(path.join(base,'data/minecraft/tags/functions/load.json'), { values:['bench:load'] });
  await writeJson(path.join(base,'data/minecraft/tags/functions/tick.json'), { values:['bench:tick'] });
  const crystals = scenario.endCrystals ?? [], goal = scenario.goal ?? { type:'dragon' };
  await put('data/bench/functions/load.mcfunction', [
    ...['mb_clock','mb_dragon','mb_end','mb_exit','mb_nether','mb_endt','mb_esafe','mb_goal','mb_goalok',...Object.values(ITEM_MILESTONES).map(m=>m.objective),...landmarks.map(l=>l.objective)].map(o=>`scoreboard objectives add ${o} dummy`),
    'scoreboard objectives add mb_deaths deathCount',
    'scoreboard players add #ticks mb_clock 0',
    ...['#seen','#dying','#dead','#dead_tick','#armed','#crystals','#goal_max',...crystals.map((_,i)=>`#cr${i}`)].map(n=>`scoreboard players add ${n} mb_dragon 0`),
  ].join('\n'));
  await put('data/bench/functions/tick.mcfunction', [
    'execute if score #armed mb_dragon matches 1 run scoreboard players add #ticks mb_clock 1',
    'execute if score #armed mb_dragon matches 1 in minecraft:the_end if entity @e[type=minecraft:ender_dragon] run scoreboard players set #seen mb_dragon 1',
    'execute if score #armed mb_dragon matches 1 in minecraft:the_end if entity @e[type=minecraft:ender_dragon,nbt={DragonPhase:9}] run scoreboard players set #dying mb_dragon 1',
    'execute if score #armed mb_dragon matches 1 if score #seen mb_dragon matches 1 if score #dead mb_dragon matches 0 in minecraft:the_end unless entity @e[type=minecraft:ender_dragon] run function bench:check_exit',
    // Lowest observed dragon health. Crystals can heal it; the minimum still records damage dealt.
    // A failed read must not count as 0: after the player dies beside a perched dragon, the
    // dragon still matches `if entity` but `data get` fails, and `store result` would store 0.
    'scoreboard players set #hp_ok mb_dragon 0',
    'execute if score #armed mb_dragon matches 1 in minecraft:the_end if entity @e[type=minecraft:ender_dragon] store success score #hp_ok mb_dragon store result score #hp_read mb_dragon run data get entity @e[type=minecraft:ender_dragon,limit=1] Health',
    'execute if score #hp_ok mb_dragon matches 1 run scoreboard players operation #hp mb_dragon = #hp_read mb_dragon',
    'execute if score #armed mb_dragon matches 1 if score #hp_ok mb_dragon matches 1 if score #hp mb_dragon < #hp_min mb_dragon run scoreboard players operation #hp_min mb_dragon = #hp mb_dragon',
    // Landmark areas are full-height columns around each supplied position.
    ...landmarks.map(l=>`execute in minecraft:${l.dimension} as @a[name=${PLAYER},x=${l.position[0]-LANDMARK_RADIUS},y=0,z=${l.position[2]-LANDMARK_RADIUS},dx=${2*LANDMARK_RADIUS},dy=255,dz=${2*LANDMARK_RADIUS}] run ${once(l.objective)}`),
    // Ticks spent alive in the End (@e excludes a dead player; a position argument limits it to the End).
    // Five seconds alive there is the endSafe checkpoint: arriving through the portal without dying of the fall.
    `execute if score #armed mb_dragon matches 1 in minecraft:the_end as @e[type=minecraft:player,name=${PLAYER},x=0,y=0,z=0,distance=0..] run scoreboard players add @s mb_endt 1`,
    `execute as @a[name=${PLAYER},scores={mb_endt=100..}] run ${once('mb_esafe')}`,
    // A crystal is destroyed once its bedrock base is loaded and nothing stands on it. `if block` fails on an
    // unloaded position, so an unloaded pillar never counts.
    ...crystals.map(({base,position},i)=>`execute if score #armed mb_dragon matches 1 unless score #cr${i} mb_dragon matches 1 in minecraft:the_end if block ${base.join(' ')} minecraft:bedrock unless entity @e[type=minecraft:end_crystal,x=${position[0]},y=${position[1]},z=${position[2]},distance=..2] run scoreboard players set #cr${i} mb_dragon 1`),
    ...(crystals.length?['scoreboard players set #crystals mb_dragon 0',...crystals.map((_,i)=>`scoreboard players operation #crystals mb_dragon += #cr${i} mb_dragon`)]:[]),
    // Goal items held (the most held at once); `clear` with a count of 0 only counts.
    ...(goal.type==='items'?[
      `execute if score #armed mb_dragon matches 1 as @a[name=${PLAYER}] store result score @s mb_goal run clear @s minecraft:${goal.item} 0`,
      `execute if score #armed mb_dragon matches 1 as @a[name=${PLAYER}] if score @s mb_goal > #goal_max mb_dragon run scoreboard players operation #goal_max mb_dragon = @s mb_goal`,
      `execute if score #goal_max mb_dragon matches ${goal.count}.. as @a[name=${PLAYER}] run ${once('mb_goalok')}`]:[]),
  ].join('\n'));
  // A perched dragon can die without entering the flying DYING phase, and dead
  // entities are excluded by selectors. Require the naturally generated exit
  // portal as well as absence; a dragon merely leaving loaded chunks is not a kill.
  await put('data/bench/functions/check_exit.mcfunction', Array.from({length:256},(_,y)=>`execute if score #dead mb_dragon matches 0 if block 1 ${y} 0 minecraft:end_portal run function bench:dragon_dead`).join('\n'));
  await put('data/bench/functions/dragon_dead.mcfunction', 'scoreboard players set #dead mb_dragon 1\nscoreboard players operation #dead_tick mb_dragon = #ticks mb_clock');
  for (const [name, dimension, from] of [['end','the_end'],['nether','the_nether'],['exit','overworld','the_end']]) {
    await writeJson(path.join(base,`data/bench/advancements/${name}.json`), {
      criteria:{event:{trigger:'minecraft:changed_dimension',conditions:{to:`minecraft:${dimension}`,...(from?{from:`minecraft:${from}`}:{})}}},
      rewards:{function:`bench:${name}`}
    });
    await put(`data/bench/functions/${name}.mcfunction`, [once(`mb_${name}`),`advancement revoke @s only bench:${name}`].join('\n'));
  }
  // Any one listed item entering the inventory completes an item checkpoint.
  for (const [name, {objective, items}] of Object.entries(ITEM_MILESTONES)) {
    const criteria = Object.fromEntries(items.map((item,i)=>[`c${i}`,{trigger:'minecraft:inventory_changed',conditions:{items:[item]}}]));
    await writeJson(path.join(base,`data/bench/advancements/item_${name.toLowerCase()}.json`), {criteria,requirements:[Object.keys(criteria)],rewards:{function:`bench:item_${name.toLowerCase()}`}});
    await put(`data/bench/functions/item_${name.toLowerCase()}.mcfunction`, [once(objective),`advancement revoke @s only bench:item_${name.toLowerCase()}`].join('\n'));
  }
}
