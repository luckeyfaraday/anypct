// Score v2 for the community submit check and the public site, which runs in a Worker and cannot import the
// referee (it reads worlds with Node APIs). These functions are copies of src/referee.mjs; a test keeps them
// identical. They stay copies only while src/ must keep its controller hash for a running batch.
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
// Rescores a saved result from its own checkpoints, approach distances and dragon health. Used to rescore runs
// recorded before score v2 and by the site to recheck a submitted score. `scenario` is the manifest's course.
export function rescoreResult(scenario,result){
  const last={dragonSeen:result.dragonHealthMin!==null&&result.dragonHealthMin!==undefined?1:0,dragonHealthMin:result.dragonHealthMin,goalItems:result.goalItems,crystalsDestroyed:result.crystalsDestroyed};
  return scoreRun({scenario,milestones:result.milestones,durationMs:result.durationMs,last,approach:result.approach??[]});
}
