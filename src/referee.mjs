import fs from 'node:fs/promises';
import path from 'node:path';
import nbt from 'prismarine-nbt';
import { PLAYER, PLAYER_UUID } from './util.mjs';

const tiers=list=>list.map(material=>({item:`minecraft:${material}_pickaxe`}));
const colors=['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'];
// Item checkpoints are recorded when vanilla inventory_changed advancements fire
// on the server. Objective names stay within the 16-character 1.16 limit.
export const ITEM_MILESTONES={
  wood:{objective:'mb_wood',items:[{tag:'minecraft:logs'}]},
  craftingTable:{objective:'mb_table',items:[{item:'minecraft:crafting_table'}]},
  pickaxe:{objective:'mb_pick',items:tiers(['wooden','stone','golden','iron','diamond','netherite'])},
  stonePickaxe:{objective:'mb_spick',items:tiers(['stone','iron','diamond','netherite'])},
  ironIngot:{objective:'mb_iron',items:[{item:'minecraft:iron_ingot'}]},
  bucket:{objective:'mb_bucket',items:['bucket','water_bucket','lava_bucket'].map(i=>({item:`minecraft:${i}`}))},
  flintAndSteel:{objective:'mb_flint',items:[{item:'minecraft:flint_and_steel'}]},
  bed:{objective:'mb_bed',items:colors.map(c=>({item:`minecraft:${c}_bed`}))},
  blazeRod:{objective:'mb_blaze',items:[{item:'minecraft:blaze_rod'}]},
  enderPearl:{objective:'mb_pearl',items:[{item:'minecraft:ender_pearl'}]},
  enderEye:{objective:'mb_eye',items:[{item:'minecraft:ender_eye'}]},
};
export const LANDMARK_RADIUS=16;
export const landmarkName=index=>`landmark${index}`;
// Progress is secondary to success: the share of route checkpoints reached inside
// the deadline. The route lists only checkpoints every strategy must pass; optional
// items (beds, iron, buckets) are still recorded but do not score. A scenario may
// name its own route when some supplied landmarks are optional.
export function ladder(scenario){
  return scenario.ladder??['wood','craftingTable','pickaxe',...(scenario.landmarks??[]).map((_,i)=>landmarkName(i)),'enteredEnd','dragonDamaged','dragonHalf','dragonDead','exitEnd'];
}
export function scoreValue(response){const match=String(response).match(/has (-?\d+) \[/);if(!match)throw new Error(`Referee could not read a server score: ${String(response).slice(0,180)}`);return Number(match[1]);}
// Server-side player position, for closest approach to supplied landmarks.
export function entityData(response){const text=String(response),i=text.indexOf('entity data: ');if(i<0)return null;const value=text.slice(i+13).trim();
  if(value.startsWith('['))return value.slice(1,-1).split(',').map(v=>Number.parseFloat(v));return value.replace(/^"|"$/g,'');}
export class Referee {
  constructor(server,{scenario={},clock=()=>0,onEvent=()=>{}}={}){this.server=server;this.scenario=scenario;this.clock=clock;this.onEvent=onEvent;this.observed={};this.milestones={};this.errors=[];this.last={};
    this.landmarks=(scenario.landmarks??[]).map((l,i)=>({name:l.name,dimension:l.dimension,position:l.position,startDistance:null,closestDistance:null,index:i}));}
  playerScores(){return {enteredEnd:'mb_end',exitEnd:'mb_exit',enteredNether:'mb_nether',deaths:'mb_deaths',endTicks:'mb_endt',endSafe:'mb_esafe',goal:'mb_goalok',...Object.fromEntries(Object.entries(ITEM_MILESTONES).map(([k,v])=>[k,v.objective])),...Object.fromEntries(this.landmarks.map(l=>[landmarkName(l.index),`mb_lm${l.index}`]))};}
  async arm(){
    for(const [who,obj] of [['#ticks','mb_clock'],['#seen','mb_dragon'],['#dying','mb_dragon'],['#dead','mb_dragon'],['#dead_tick','mb_dragon'],['#crystals','mb_dragon'],['#goal_max','mb_dragon'],...(this.scenario.endCrystals??[]).map((_,i)=>[`#cr${i}`,'mb_dragon']),...Object.values(this.playerScores()).map(o=>[PLAYER,o])])await this.server.command(`scoreboard players set ${who} ${obj} 0`);
    for(const who of ['#hp','#hp_min'])await this.server.command(`scoreboard players set ${who} mb_dragon 200`);
    // A checkpoint stores the tick it happened at, and 0 means "not reached": the clock starts at 1 so an
    // event in the arming tick still counts (a single-item inventory trigger does not fire again).
    await this.server.command('scoreboard players set #ticks mb_clock 1');
    await this.server.command('scoreboard players set #armed mb_dragon 1');
  }
  async poll(){
    if(this.polling)return this.last;this.polling=true;
    try{
      const specs={ticks:['#ticks','mb_clock'],dragonSeen:['#seen','mb_dragon'],dragonDying:['#dying','mb_dragon'],dragonDead:['#dead','mb_dragon'],dragonDeadTick:['#dead_tick','mb_dragon'],dragonHealthMin:['#hp_min','mb_dragon'],crystalsDestroyed:['#crystals','mb_dragon'],goalItems:['#goal_max','mb_dragon'],...Object.fromEntries(Object.entries(this.playerScores()).map(([k,o])=>[k,[PLAYER,o]]))};
      const current={};for(const [k,[who,obj]] of Object.entries(specs))current[k]=scoreValue(await this.server.command(`scoreboard players get ${who} ${obj}`));
      const record=(name,tick)=>{if(this.observed[name]!==undefined)return;this.observed[name]=this.clock();this.milestones[name]={wallMs:this.clock(),tick};this.onEvent('milestone',{name,...this.milestones[name]});};
      for(const name of ['enteredNether','enteredEnd','endSafe','goal','dragonSeen','dragonDead','exitEnd',...Object.keys(ITEM_MILESTONES),...this.landmarks.map(l=>landmarkName(l.index))])if(current[name]>0)record(name,name==='dragonDead'?current.dragonDeadTick:current[name]);
      if(current.dragonSeen>0&&current.dragonHealthMin<200)record('dragonDamaged',current.ticks);
      if(current.dragonSeen>0&&current.dragonHealthMin<=100)record('dragonHalf',current.ticks);
      if(this.landmarks.length)await this.approach();
      this.last=current;return current;
    }finally{this.polling=false;}
  }
  async approach(){
    // A dead or disconnected player has no entity data; that is not a referee failure.
    const position=entityData(await this.server.command(`data get entity ${PLAYER} Pos`)),dimension=entityData(await this.server.command(`data get entity ${PLAYER} Dimension`));
    if(!Array.isArray(position)||position.length!==3||position.some(v=>!Number.isFinite(v)))return;
    for(const l of this.landmarks){if(dimension!==`minecraft:${l.dimension}`)continue;const d=Math.round(Math.hypot(position[0]-l.position[0],position[2]-l.position[2])),d3=Math.round(Math.hypot(position[0]-l.position[0],position[1]-l.position[1],position[2]-l.position[2]));
      l.startDistance??=d;l.closestDistance=Math.min(l.closestDistance??d,d);l.start3d??=d3;l.closest3d=Math.min(l.closest3d??d3,d3);}
  }
  approachSummary(){return this.landmarks.map(({name,dimension,position,startDistance,closestDistance,start3d,closest3d})=>({name,dimension,position,startDistance,closestDistance,start3d,closest3d}));}
}
export async function readWorldEvidence(directory){
  const read=async file=>nbt.simplify((await nbt.parse(await fs.readFile(file))).parsed);
  const world=await read(path.join(directory,'world','level.dat'));
  const player=await read(path.join(directory,'world','playerdata',`${PLAYER_UUID}.dat`));
  const fight=world.Data.DragonFight??world.Data.DimensionData?.['1']?.DragonFight;
  return {dragonKilled:!!fight?.DragonKilled,previouslyKilled:!!fight?.PreviouslyKilled,exitPortalLocation:fight?.ExitPortalLocation??null,seenCredits:!!player.seenCredits,playerDimension:player.Dimension,playerHealth:player.Health,gameType:player.playerGameType};
}
// Score v2: each course segment earns 1 at the start of the course falling to 0.5 at the deadline, so
// reaching a checkpoint always beats any partial credit and reaching it sooner scores higher. A segment
// not reached earns half its partial progress: distance closed toward a landmark, dragon health removed,
// or goal items held. The value is the mean over segments. Like route progress, it never implies success.
export function scoreSegments(scenario={}){
  if(scenario.score)return scenario.score;
  const goal=scenario.goal??{type:'dragon'};
  if(goal.type==='milestone')return [{checkpoint:goal.name}];
  if(goal.type==='items')return [{checkpoint:'goal',partial:'goalItems'}];
  return [{checkpoint:'enteredEnd'},{checkpoint:'dragonDead',partial:'dragonDamage'},{checkpoint:'exitEnd'}];
}
export function partialProgress(spec,{last={},approach=[],scenario={}}={}){
  if(!spec)return 0;
  if(spec==='dragonDamage')return last.dragonSeen>0&&Number.isFinite(last.dragonHealthMin)?(200-last.dragonHealthMin)/200:0;
  if(spec==='goalItems')return (last.goalItems??0)/(scenario.goal?.count??1);
  if(spec==='crystals')return (last.crystalsDestroyed??0)/Math.max(1,scenario.endCrystals?.length??10);
  if(spec.approach!==undefined){const a=approach[spec.approach];if(!a)return 0;const [start,closest]=spec.metric==='3d'?[a.start3d,a.closest3d]:[a.startDistance,a.closestDistance];return start>0&&Number.isFinite(closest)?1-closest/start:0;}
  throw new Error(`Unknown partial progress ${JSON.stringify(spec)}`);
}
export function scoreRun({scenario={},milestones={},durationMs,last={},approach=[]}){
  const segments=scoreSegments(scenario).map(segment=>{
    const m=milestones[segment.checkpoint],reached=!!m&&m.wallMs<=durationMs;
    const partial=reached?1:Math.min(1,Math.max(0,partialProgress(segment.partial,{last,approach,scenario})));
    return {checkpoint:segment.checkpoint,reachedMs:reached?m.wallMs:null,partial:reached?null:Number(partial.toFixed(4)),credit:Number((reached?1-0.5*m.wallMs/durationMs:0.5*partial).toFixed(4))};
  });
  return {version:2,value:Number((segments.reduce((n,s)=>n+s.credit,0)/segments.length).toFixed(4)),segments};
}
// Client telemetry and model claims are deliberately not inputs to this predicate. The dragon goal needs the
// saved kill, credits and ordering; milestone and item goals need their server-recorded checkpoint in time.
export function grade({evidence,observed,last,durationMs,elapsedMs,infrastructureError=null,kind='evaluation',milestones={},route=[],approach=[],scenario={}}){
  const goal=scenario.goal??{type:'dragon'};
  let verified,completionMs,checks;
  if(goal.type==='dragon'){
    const completedInTime=Number.isFinite(observed.dragonDead)&&Number.isFinite(observed.exitEnd)&&observed.dragonDead<=durationMs&&observed.exitEnd<=durationMs;
    const ordering=last.dragonDeadTick>0&&last.exitEnd>=last.dragonDeadTick&&observed.dragonSeen!==undefined;
    verified=!!evidence?.dragonKilled&&!!evidence?.seenCredits&&evidence?.gameType===0&&completedInTime&&ordering;
    completionMs=verified?observed.exitEnd:null;
    checks={persistentDragonKill:!!evidence?.dragonKilled&&Number.isFinite(observed.dragonDead),playerSawCredits:!!evidence?.seenCredits,survivalPlayer:evidence?.gameType===0,completedInTime,eventOrdering:ordering};
  }else{
    const name=goal.type==='items'?'goal':goal.name,at=observed[name];
    const completedInTime=Number.isFinite(at)&&at<=durationMs;
    verified=completedInTime&&evidence?.gameType===0;completionMs=verified?at:null;
    checks={goalRecorded:Number.isFinite(at),survivalPlayer:evidence?.gameType===0,completedInTime};
  }
  const success=verified&&!infrastructureError&&kind==='evaluation';
  const reached=Object.keys(milestones);
  const onRoute=route.filter(name=>milestones[name]&&milestones[name].wallMs<=durationMs);
  return {success,verifiedGameplay:verified,eligible:kind==='evaluation',kind,goal,
    outcome:infrastructureError?'infrastructure_error':verified?(kind==='evaluation'?'success':'fixture_verified'):elapsedMs>=durationMs?'timeout':'stopped',
    completionMs,elapsedMs,durationMs,deaths:last.deaths??0,simulationTicks:last.ticks??0,
    milestones,reached,progress:{route,reached:onRoute,score:route.length?onRoute.length/route.length:null},
    score:scoreRun({scenario,milestones,durationMs,last,approach}),
    dragonHealthMin:last.dragonSeen>0?last.dragonHealthMin:null,crystalsDestroyed:scenario.endCrystals?.length?last.crystalsDestroyed??0:null,
    endSeconds:Number.isFinite(last.endTicks)?Number((last.endTicks/20).toFixed(1)):null,goalItems:goal.type==='items'?last.goalItems??0:null,
    approach,infrastructureError,evidence:evidence??null,checks};
}
