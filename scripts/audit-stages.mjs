import path from 'node:path';
import { parseArgs } from 'node:util';
import { Vec3 } from 'vec3';
import { DATA, PLAYER, runId, writeJson, sleep } from '../src/util.mjs';
import { startServer } from '../src/server.mjs';
import { connectBot } from '../src/controller.mjs';

// Stage calibration only. Privileged teleports run in a throwaway world under data/audits; it is never a
// snapshot and never a model result. Records what stage courses need: safe standing spots beside the End
// portal and near a fortress spawner, the surface above the portal, and the End crystal positions.
const {values}=parseArgs({options:{seed:{type:'string'},version:{type:'string',default:'1.16.1'},portal:{type:'string'},nether:{type:'string'}}});
const triple=s=>s?.split(',').map(Number);
const portal=triple(values.portal),nether=triple(values.nether);
if(!/^-?\d+$/.test(values.seed??'')||portal?.length!==3)throw new Error('Usage: node scripts/audit-stages.mjs --seed <seed> --portal x,y,z [--nether x,y,z] [--version 1.16.1]');
const scenario={id:'audit',minecraft:values.version,seed:values.seed,difficulty:'peaceful'};
const directory=path.join(DATA,'audits',runId(`stages-${values.version}`));
const server=await startServer({directory,scenario});let bot;
async function visit(dimension,[x,y,z]){
  await server.command(`execute in minecraft:${dimension} run tp ${PLAYER} ${x} ${y} ${z}`);
  const end=Date.now()+20000;
  while(Date.now()<end&&(!String(bot.game.dimension).endsWith(dimension)||Math.hypot(bot.entity.position.x-x,bot.entity.position.z-z)>8))await sleep(200);
  await sleep(4000);await bot.waitForChunksToLoad();
}
const name=p=>bot.blockAt(new Vec3(...p))?.name??null;
const solid=p=>{const b=bot.blockAt(new Vec3(...p));return !!b&&b.boundingBox==='block';};
const clear=p=>{const b=bot.blockAt(new Vec3(...p));return !!b&&b.boundingBox==='empty'&&!/lava|water|fire|portal/.test(b.name);};
// A spot is standable with a solid block below, two clear blocks above, and no lava or fire within two blocks.
function standable([x,y,z]){
  if(!solid([x,y-1,z])||!clear([x,y,z])||!clear([x,y+1,z]))return false;
  for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)for(let dz=-2;dz<=2;dz++)if(/lava|fire/.test(name([x+dx,y+dy,z+dz])??''))return false;
  return true;
}
function spots(center,radius,height=6){
  const found=[];
  for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++)for(let dy=-height;dy<=height;dy++){const p=[center[0]+dx,center[1]+dy,center[2]+dz];if(standable(p))found.push({position:p,distance:Number(Math.hypot(dx,dy,dz).toFixed(1))});}
  return found.sort((a,b)=>a.distance-b.distance);
}
try{
  bot=await connectBot(server.port,{version:values.version});
  await server.command(`gamemode spectator ${PLAYER}`);
  const report={at:new Date().toISOString(),kind:'stage-audit',version:values.version,seed:values.seed,portal};
  // Portal room: where a player can stand beside the portal, and the block layout around it.
  await visit('overworld',[portal[0],portal[1]+3,portal[2]]);
  report.portalBlock=name(portal);
  report.portalRoomSpots=spots(portal,6,3).slice(0,12);
  const layout={};for(let dy=-1;dy<=2;dy++)layout[portal[1]+dy]=Array.from({length:9},(_,i)=>Array.from({length:9},(_,j)=>(name([portal[0]-4+j,portal[1]+dy,portal[2]-4+i])??'?').replace('minecraft:','').slice(0,10)).join(' '));
  report.portalRoomLayout=layout;
  // The column above the portal, from the surface down: what a shaft dug straight down passes through.
  await visit('overworld',[portal[0],110,portal[2]]);
  let top=null;for(let y=150;y>portal[1];y--){if(solid([portal[0],y,portal[2]])){top=y;break;}}
  report.surfaceAbovePortal=top;report.columnAbovePortal=[];
  for(let y=top;y>portal[1];y--)report.columnAbovePortal.push(`${y}:${name([portal[0],y,portal[2]])}`);
  report.surfaceSpots=top?spots([portal[0],top+1,portal[2]],3,3).slice(0,8):[];
  // End crystals sit on bedrock atop the obsidian pillars; the referee counts a crystal destroyed when its
  // bedrock is loaded and no crystal stands on it.
  await visit('the_end',[0,100,0]);await sleep(4000);
  report.endCrystals=Object.values(bot.entities).filter(e=>e.name==='end_crystal').map(e=>({position:[e.position.x,e.position.y,e.position.z].map(v=>Number(v.toFixed(2))),base:[Math.floor(e.position.x),Math.round(e.position.y)-1,Math.floor(e.position.z)]}))
    .map(c=>({...c,baseBlock:name(c.base)}));
  report.endPlatformBlock=name([100,48,0]);
  if(nether){
    await visit('the_nether',[nether[0],nether[1]+2,nether[2]]);
    report.netherTarget={position:nether,block:name(nether)};
    report.netherSpots=spots(nether,24,8).filter(s=>s.distance>=8).slice(0,16);
  }
  const file=path.join(DATA,'calibration',`stages-${values.seed}-${values.version}.json`);
  await writeJson(file,report);console.log(JSON.stringify(report,null,2));console.log(`Saved ${file}`);
}finally{bot?.quit();await sleep(300);await server.stop();}
