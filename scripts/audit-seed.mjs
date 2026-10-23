import path from 'node:path';
import { parseArgs } from 'node:util';
import { DATA, PLAYER, runId, writeJson, sleep } from '../src/util.mjs';
import { startServer } from '../src/server.mjs';
import { connectBot } from '../src/controller.mjs';

// Seed calibration only. Privileged locate/teleport commands run in a throwaway
// world under data/audits; it is never a snapshot and never a model result.
const {values}=parseArgs({options:{seed:{type:'string'},version:{type:'string',default:'1.16.1'}}});
if(!/^-?\d+$/.test(values.seed??''))throw new Error('Usage: node scripts/audit-seed.mjs --seed <seed> [--version 1.16.1]');
const scenario={id:'audit',minecraft:values.version,seed:values.seed,difficulty:'peaceful'};
const directory=path.join(DATA,'audits',runId(`seed-${values.version}`));
const server=await startServer({directory,scenario});let bot;
const round=v=>[Math.round(v.x),Math.round(v.y),Math.round(v.z)];
async function locate(structure,dimension,[x,z]){
  const response=await server.command(`execute in minecraft:${dimension} positioned ${x} 64 ${z} run locate ${structure}`);
  const m=response.match(/at \[(-?\d+), (~|-?\d+), (-?\d+)\] \((\d+) blocks away\)/);
  return m?{structure,dimension,position:[+m[1],m[2]==='~'?null:+m[2],+m[3]],distance:+m[4]}:{structure,dimension,error:response};
}
async function visit(dimension,[x,y,z]){
  await server.command(`execute in minecraft:${dimension} run tp ${PLAYER} ${x} ${y} ${z}`);
  const end=Date.now()+20000;
  while(Date.now()<end&&(!String(bot.game.dimension).endsWith(dimension)||Math.hypot(bot.entity.position.x-x,bot.entity.position.z-z)>8))await sleep(200);
  await sleep(4000);await bot.waitForChunksToLoad();
}
function survey(pattern,radius=96){
  const found={};
  for(const p of bot.findBlocks({matching:b=>pattern.test(b.name),maxDistance:radius,count:4000})){const b=bot.blockAt(p);(found[b.name]??=[]).push(round(p));}
  return Object.fromEntries(Object.entries(found).map(([name,list])=>[name,{count:list.length,nearest:list.slice(0,4)}]));
}
const entities=()=>Object.values(bot.entities).filter(e=>e!==bot.entity).reduce((n,e)=>(n[e.name]=(n[e.name]??0)+1,n),{});
try{
  bot=await connectBot(server.port,{version:values.version});
  const spawn=round(bot.spawnPoint??bot.entity.position);
  await server.command(`gamemode spectator ${PLAYER}`);
  const overworld=['village','ruined_portal','stronghold','shipwreck','buried_treasure','desert_pyramid','mineshaft'];
  const nether=['bastion_remnant','fortress','ruined_portal'];
  const structures=[...await Promise.all(overworld.map(s=>locate(s,'overworld',[spawn[0],spawn[2]]))),
    ...await Promise.all(nether.map(s=>locate(s,'the_nether',[Math.floor(spawn[0]/8),Math.floor(spawn[2]/8)])))];
  const useful=/chest$|bed$|bell|obsidian|lava|iron_block|hay_block|end_portal|spawner/;
  const sites={};
  sites.spawn={...await visit('overworld',[spawn[0],100,spawn[2]]).then(()=>({blocks:survey(useful,64),entities:entities()}))};
  for(const s of structures.filter(s=>s.position&&s.distance<600)){
    const key=`${s.dimension}:${s.structure}`;
    await visit(s.dimension,[s.position[0],s.dimension==='overworld'&&s.structure!=='stronghold'?100:s.structure==='stronghold'?30:64,s.position[2]]);
    sites[key]={blocks:survey(s.structure==='stronghold'?/end_portal|spawner|chest$/:useful,s.structure==='stronghold'?128:64),entities:entities()};
  }
  const stronghold=structures.find(s=>s.structure==='stronghold'&&s.position);
  if(stronghold){
    await visit('overworld',[stronghold.position[0],30,stronghold.position[2]]);
    const frames=bot.findBlocks({matching:b=>b.name==='end_portal_frame',maxDistance:128,count:24}).map(p=>({position:round(p),eye:bot.blockAt(p).getProperties().eye}));
    const active=bot.findBlocks({matching:b=>b.name==='end_portal',maxDistance:128,count:16}).map(round);
    sites.endPortal={frames:frames.length,eyes:frames.filter(f=>f.eye===true||f.eye==='true').length,activeBlocks:active.length,activePositions:active,framePositions:frames};
    // Entry check: a Survival player standing in an active portal block reaches the End.
    if(active.length){
      const [x,y,z]=active[0];await server.command(`gamemode survival ${PLAYER}`);await server.command(`effect give ${PLAYER} minecraft:resistance 60 4 true`);
      await server.command(`tp ${PLAYER} ${x+.5} ${y} ${z+.5}`);const end=Date.now()+15000;
      while(Date.now()<end&&!String(bot.game.dimension).endsWith('the_end'))await sleep(200);
      sites.endPortal.entryReachesEnd=String(bot.game.dimension).endsWith('the_end');
    }
  }
  const report={at:new Date().toISOString(),kind:'seed-audit',version:values.version,seed:values.seed,spawn,structures,sites};
  const file=path.join(DATA,'calibration',`seed-${values.seed}-${values.version}.json`);
  await writeJson(file,report);console.log(JSON.stringify(report,null,2));console.log(`Saved ${file}`);
}finally{bot?.quit();await sleep(300);await server.stop();}
