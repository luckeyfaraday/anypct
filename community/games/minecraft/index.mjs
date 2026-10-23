// Minecraft on the community board: its courses, how a run is grouped and checked, and the generic timeline
// the site shows. Reads only the run's own files and the bundled course files (no Node APIs; runs in a Worker).
import { rescoreResult } from './score.mjs';
import speedrun from '../../../scenarios/speedrun.json' with { type: 'json' };
import speedrunPaused from '../../../scenarios/speedrun-paused.json' with { type: 'json' };
import speedrunDragon from '../../../scenarios/speedrun-dragon.json' with { type: 'json' };
import speedrunDragonPaused from '../../../scenarios/speedrun-dragon-paused.json' with { type: 'json' };
import speedrunReentry from '../../../scenarios/speedrun-reentry.json' with { type: 'json' };
import speedrunOverworld from '../../../scenarios/speedrun-overworld.json' with { type: 'json' };
import speedrunNether from '../../../scenarios/speedrun-nether.json' with { type: 'json' };

// The speedrun family on the documented 1.16.1 set seed, each with its paused-clock twin where one exists.
const FILES=Object.fromEntries([speedrun,speedrunPaused,speedrunDragon,speedrunDragonPaused,speedrunReentry,speedrunOverworld,speedrunNether].map(s=>[s.id,s]));
const course=id=>{const own=FILES[id];return own?.extends?{...course(own.extends),...own}:own;};
const DIMENSIONS={overworld:'Overworld',the_nether:'Nether',the_end:'The End'};

// A paused twin ranks with its base course on the paused track.
function group(manifest){
  const s=manifest.scenario,clock=s.clock==='paused'?'paused':'real';
  return {course:clock==='paused'?s.id.replace(/-paused$/,''):s.id,clock};
}

// The saved score must equal the one recomputed from the result's own checkpoints. Results from before
// score v2 are scored from their checkpoints with the course's current segments and marked rescored.
function check({manifest,result,events}){
  const reasons=[];let score=null,segments=null;const rescored=!!result&&!result.score;
  if(result){
    // Reports leave these out of score statistics, so the board does too.
    if(!result.eligible)reasons.push('the referee marked this run ineligible');
    if(result.outcome==='infrastructure_error')reasons.push(`the run ended with an infrastructure error, so it does not count (${result.infrastructureError??'no detail'})`);
    const scenario={...manifest.scenario,score:manifest.scenario.score??course(manifest.scenario.id)?.score};
    try{({value:score,segments}=rescoreResult(scenario,result));}catch(error){reasons.push(`the score cannot be recomputed: ${error.message}`);}
    if(!rescored&&score!==null&&score!==result.score.value)reasons.push(`the saved score ${result.score.value} does not match the recomputed ${score}`);
    const logged=new Map(events.filter(e=>e.type==='milestone').map(e=>[e.data?.name,e.data?.wallMs]));
    for(const [name,m] of Object.entries(result.milestones??{}))
      if(m.wallMs<=result.durationMs&&logged.get(name)!==m.wallMs)reasons.push(`checkpoint ${name} is not in the event log at the same time`);
  }
  if(!events.some(e=>e.type==='run_start'))reasons.push('the event log has no run start');
  return {reasons,score,rescored,segments:segments?.map(s=>({...s,label:checkpointLabel(s.checkpoint,manifest.scenario.landmarks)}))};
}

const CHECKPOINTS={wood:'Wood',craftingTable:'Crafting table',pickaxe:'Pickaxe',stonePickaxe:'Stone pickaxe',ironIngot:'Iron ingot',
  bucket:'Bucket',flintAndSteel:'Flint and steel',bed:'Bed',blazeRod:'Blaze rod',enderPearl:'Ender pearl',enderEye:'Eye of ender',
  enteredEnd:'Entered the End',endSafe:'Safe in the End',dragonSeen:'Dragon seen',dragonDamaged:'Dragon damaged',
  dragonHalf:'Dragon at half health',dragonDead:'Dragon killed',exitEnd:'Left the End',goal:'Goal reached'};
// Landmark checkpoints are named after the course's landmark, without its parenthesised notes.
function checkpointLabel(name,landmarks=[]){
  const landmark=/^landmark(\d+)$/.exec(name??'');
  if(landmark){const l=landmarks.at(Number(landmark[1]));return `Reached ${l?.name?.split(/ \(|:/)[0]??`landmark ${Number(landmark[1])+1}`}`;}
  return CHECKPOINTS[name]??String(name).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
}

// Checkpoints, deaths and dimension changes, timed from the start of the run as the video shows it.
// The bot reports its dimension again on reconnects, so only actual changes are kept.
function timeline(events){
  const out=[];let area=null;
  const landmarks=events.find(e=>e.type==='run_start')?.data?.manifest?.scenario?.landmarks;
  for(const e of events){
    if(e.type==='dimension'){
      const d=e.data?.dimension;
      if(d!==area&&Number.isFinite(e.elapsedMs))out.push({kind:'area',ms:Math.round(e.elapsedMs),label:DIMENSIONS[d]??d});
      area=d;continue;
    }
    if(!Number.isFinite(e.elapsedMs))continue;
    if(e.type==='milestone')out.push({kind:'checkpoint',ms:Math.round(e.elapsedMs),label:checkpointLabel(e.data?.name,landmarks)});
    else if(e.type==='death')out.push({kind:'death',ms:Math.round(e.elapsedMs),label:'Died'});
  }
  return out;
}

export default {
  id:'minecraft',
  name:'Minecraft',
  disclaimer:'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.',
  files:['manifest.json','result.json','events.jsonl','video.mp4'],
  courses:Object.keys(FILES).map(id=>({id,...group({scenario:course(id)})})),
  group,
  startStateHash:manifest=>manifest.snapshotHash,
  wallMs:result=>result?.clock?.wallMs??result?.elapsedMs??0,
  check,
  timeline,
};
