import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA, PLAYER, exists, writeJson, readJson, treeHashes, sha256, runId, safeId, sleep } from './util.mjs';
import { startServer } from './server.mjs';
import { connectBot } from './controller.mjs';
import { installRefereePack } from './datapack.mjs';
import { readWorldEvidence } from './referee.mjs';

export async function prepareSnapshot(scenario){
  const destination=path.join(DATA,'snapshots',safeId(scenario.id));
  if(await exists(destination))throw new Error('Snapshot already exists. Preserve it and use a new scenario ID to prepare another.');
  const directory=path.join(DATA,'preparations',runId(scenario.id));
  await installRefereePack(path.join(directory,'world'),scenario);
  const server=await startServer({directory,scenario});let bot;
  try{
    await server.command('gamerule spawnRadius 0');await server.command('gamerule keepInventory false');
    await server.command('gamerule doDaylightCycle true');await server.command('time set day');await server.command('weather clear');
    bot=await connectBot(server.port,{version:scenario.minecraft});
    await server.command(`clear ${PLAYER}`);
    const p=bot.entity.position;
    await server.command(`tp ${PLAYER} ${p.x} ${p.y} ${p.z} ${scenario.variant.kind==='spawn-yaw'?scenario.variant.degrees:0} 0`);
    await server.command(`spawnpoint ${PLAYER} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    await server.command('scoreboard players set #armed mb_dragon 0');
    const spawn=[p.x,p.y,p.z];bot.quit();await sleep(300);await server.stop();
    await fs.mkdir(destination,{recursive:true});
    await fs.cp(path.join(directory,'world'),path.join(destination,'world'),{recursive:true,errorOnExist:true,force:false});
    const files=await treeHashes(path.join(destination,'world'));
    const manifest={schemaVersion:1,scenario,spawn,createdAt:new Date().toISOString(),files,worldHash:sha256(JSON.stringify(files)),jar:server.installation};
    await writeJson(path.join(destination,'manifest.json'),manifest);return manifest;
  }finally{bot?.quit();await server.stop();}
}
// The snapshot is the world: seed, version and spawn facing. Course rules (deadline, landmarks, start
// state, scoring) are not part of it; they are hashed into each run's protocol instead. A stage course
// starts from another course's frozen world and applies its own start state at run time.
const worldOf=s=>JSON.stringify({seed:s.seed,minecraft:s.minecraft,variant:s.variant});
export async function restoreSnapshot(scenario,directory){
  const base=scenario.snapshot??scenario.id;
  const snapshot=path.join(DATA,'snapshots',safeId(base));
  const manifest=await readJson(path.join(snapshot,'manifest.json')).catch(()=>{throw new Error(`Missing snapshot: npm run bench -- prepare --scenario ${base}`);});
  if(worldOf(manifest.scenario)!==worldOf(scenario))throw new Error('Scenario world differs from its frozen snapshot; prepare a new scenario ID');
  const files=await treeHashes(path.join(snapshot,'world'));
  if(sha256(JSON.stringify(files))!==manifest.worldHash)throw new Error('Snapshot integrity check failed');
  if(await exists(path.join(directory,'world')))throw new Error('Refusing to overwrite an existing run world');
  await fs.mkdir(directory,{recursive:true});await fs.cp(path.join(snapshot,'world'),path.join(directory,'world'),{recursive:true,errorOnExist:true,force:false});
  const initialEvidence=await readWorldEvidence(directory);
  // Vanilla writes DragonKilled=true before the End fight has ever initialized.
  // A real prior kill also has a generated fountain location; the raw bit alone
  // cannot establish either a prior kill or a benchmark win.
  if((initialEvidence.dragonKilled&&initialEvidence.exitPortalLocation)||initialEvidence.seenCredits||initialEvidence.gameType!==0)throw new Error('Starting snapshot is not a fresh Survival attempt');
  // Refresh only the read-only instrumentation, which is covered by controllerHash.
  // The immutable base snapshot and its hashes are never changed.
  await installRefereePack(path.join(directory,'world'),scenario);
  return manifest;
}
