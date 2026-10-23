import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { Rcon } from 'rcon-client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA, PLAYER, PLAYER_UUID, exists, readJson, writeJson, sleep, sha256, treeHashes } from './util.mjs';

export const VERSIONS = ['1.16.1', '1.16.5'];
export async function installServer({ acceptEula = false, version = '1.16.5' } = {}) {
  if (!VERSIONS.includes(version)) throw new Error(`Unsupported Minecraft version ${version}`);
  const dir = path.join(DATA, 'server'); await fs.mkdir(dir, { recursive: true });
  if (acceptEula) await writeJson(path.join(dir,'eula-acceptance.json'),{accepted:true,at:new Date().toISOString(),url:'https://aka.ms/MinecraftEULA'});
  const jar = path.join(dir,`minecraft-${version}.jar`);
  // 1.16.5 predates multi-version support and keeps its original metadata file.
  const metaFile = path.join(dir,version==='1.16.5'?'download.json':`download-${version}.json`);
  if (await exists(jar) && await exists(metaFile)) {
    const info = await readJson(metaFile);
    if (createHash('sha1').update(await fs.readFile(jar)).digest('hex') === info.sha1) return {jar,...info};
    throw new Error('Server JAR checksum mismatch; move the modified JAR aside before reinstalling');
  }
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const entry = manifest.versions.find(v=>v.id===version);
  if (!entry) throw new Error(`Official Minecraft ${version} manifest missing`);
  const release = await fetchJson(entry.url);
  const download = release.downloads.server;
  const response = await fetch(download.url,{signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`Server download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha1').update(data).digest('hex')!==download.sha1) throw new Error('Official JAR checksum verification failed');
  await fs.writeFile(jar,data); await writeJson(metaFile,{version,...download});
  return {jar,version,...download};
}
// The paused clock needs a server that can stop the world between tool calls: Fabric with Carpet, whose
// `tick freeze` stops every entity, block and the day cycle while players (and the referee's datapack
// clock) keep ticking. Pinned builds; the installer's libraries are hashed into the installation record.
const FABRIC={loader:'0.19.5',installer:{url:'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar',sha256:'61e035bf7bf70153e127440ce34de47c9036f0a2d0c65d1529454bd35ceefe4f'}};
const CARPET={
  '1.16.1':{url:'https://github.com/gnembon/fabric-carpet/releases/download/v1.4-homebound/fabric-carpet-1.16.1-1.4.0%2Bv200623_build2.jar',sha256:'f4b3440067eb44725034aed9751626c834d51577bc3b0a86231a5efd4e102f71'},
  '1.16.5':{url:'https://github.com/gnembon/fabric-carpet/releases/download/1.4.44/fabric-carpet-1.16.5-1.4.44%2Bv210714.jar',sha256:'480e4afe497bab4c9a43637d159e3f8b395ea767af725ec714f0ecfeaee63625'}};
async function download(url,sha,file){
  if(await exists(file)){if(sha256(await fs.readFile(file))===sha)return file;throw new Error(`Checksum mismatch for ${file}; move it aside before reinstalling`);}
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`Download ${response.status}: ${url}`);
  const data=Buffer.from(await response.arrayBuffer());if(sha256(data)!==sha)throw new Error(`Checksum verification failed: ${url}`);
  await fs.writeFile(file,data);return file;
}
export async function installCarpet(version){
  const vanilla=await installServer({version});if(!CARPET[version])throw new Error(`No pinned Carpet build for ${version}`);
  const dir=path.join(DATA,'server',`fabric-${version}-${FABRIC.loader}`),record=path.join(dir,'installation.json');
  const carpet=await download(CARPET[version].url,CARPET[version].sha256,path.join(DATA,'server',`carpet-${version}.jar`));
  if(!await exists(record)){
    await fs.mkdir(dir,{recursive:true});
    const installer=await download(FABRIC.installer.url,FABRIC.installer.sha256,path.join(DATA,'server','fabric-installer.jar'));
    await promisify(execFile)(process.env.BENCH_JAVA||'java',['-jar',installer,'server','-dir',dir,'-mcversion',version,'-loader',FABRIC.loader],{windowsHide:true,timeout:300000});
    const files=await treeHashes(dir);await writeJson(record,{version,loader:FABRIC.loader,installer:FABRIC.installer,files,hash:sha256(JSON.stringify(files))});
  }
  const installation=await readJson(record);const files=await treeHashes(dir);delete files['installation.json'];
  if(sha256(JSON.stringify(files))!==installation.hash)throw new Error('Fabric installation changed since it was recorded; reinstall it');
  return {jar:vanilla.jar,vanilla,launcher:path.join(dir,'fabric-server-launch.jar'),carpet,carpetSha256:CARPET[version].sha256,fabricLoader:FABRIC.loader,fabricHash:installation.hash};
}
async function fetchJson(url) { const r=await fetch(url,{signal:AbortSignal.timeout(30000)}); if(!r.ok)throw new Error(`Download ${r.status}: ${url}`); return r.json(); }
async function killTree(child){if(process.platform==='win32')await promisify(execFile)('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});else child.kill('SIGKILL');}
export async function freePort(preferred = 0) {
  return new Promise((resolve,reject)=>{ const s=net.createServer();s.once('error',reject);s.listen(preferred,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); });
}
export async function startServer({ directory, scenario, port = 0, rconPort = 0 }) {
  const acceptance=await readJson(path.join(DATA,'server/eula-acceptance.json')).catch(()=>null);
  if (!acceptance?.accepted) throw new Error('Minecraft EULA acceptance required: npm run bench -- setup --accept-eula');
  const paused=scenario.clock==='paused';
  const installation=paused?await installCarpet(scenario.minecraft):await installServer({version:scenario.minecraft});
  port=await freePort(port); rconPort=await freePort(rconPort);
  const password=randomBytes(24).toString('hex');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'eula.txt'),'eula=true\n');
  const properties={
    'server-ip':'127.0.0.1','server-port':port,'level-name':'world','level-seed':scenario.seed,
    'level-type':'default','gamemode':'survival',difficulty:scenario.difficulty,'hardcore':false,
    'online-mode':false,'white-list':true,'enforce-whitelist':true,'max-players':1,
    'spawn-protection':0,'view-distance':6,'allow-nether':true,'generate-structures':true,
    'enable-command-block':false,'enable-rcon':true,'rcon.port':rconPort,'rcon.password':password,
    'broadcast-rcon-to-ops':false,'broadcast-console-to-ops':false,'enable-query':false,
    // Keep synchronous chunk writes: with them off, the final save-all flush waited on the write queue past the
    // 60 s watchdog on this machine and crashed the server. Stalls are absorbed by the referee instead.
    'max-tick-time':60000,'network-compression-threshold':256,'sync-chunk-writes':true,
    // The floating kick is anti-cheat for untrusted clients; the bot cannot fly. It kicked a player frozen
    // mid-air on the paused clock, and one lying dead below the world while the model decided to respawn.
    'allow-flight':true,
    'motd':'Minecraft Sprint Bench — isolated evaluation'
  };
  await fs.writeFile(path.join(directory,'server.properties'),Object.entries(properties).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  await writeJson(path.join(directory,'whitelist.json'),[{uuid:PLAYER_UUID,name:PLAYER}]);
  await writeJson(path.join(directory,'ops.json'),[]);
  const log=await fs.open(path.join(directory,'console.log'),'a');
  // Backslashes are escapes in a .properties file.
  if(paused)await fs.writeFile(path.join(directory,'fabric-server-launcher.properties'),`serverJar=${installation.jar.replaceAll('\\','/')}\n`);
  const java=paused?['-Xms512M','-Xmx2G',`-Dfabric.addMods=${installation.carpet}`,'-jar',installation.launcher,'nogui']:['-Xms512M','-Xmx2G','-jar',installation.jar,'nogui'];
  const child=spawn(process.env.BENCH_JAVA||'java',java,{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='', exited=false, spawnError;
  child.on('error',e=>{spawnError=e;}); child.on('exit',()=>{exited=true;});
  for(const stream of [child.stdout,child.stderr]) stream.on('data',data=>{output=(output+data).slice(-12000);void log.write(data).catch(()=>{});});
  const deadline=Date.now()+180000;
  let rcon;
  try {
    while(!output.includes('Done (')) {
      if(spawnError)throw spawnError;
      if(exited)throw new Error(`Minecraft exited during startup:\n${output}`);
      if(Date.now()>deadline)throw new Error(`Minecraft startup timed out:\n${output}`);
      await sleep(200);
    }
    // A busy server can stall for seconds (chunk loading, a long GC); replies wait rather than fail.
    for(let i=0;i<20;i++){try{rcon=await Rcon.connect({host:'127.0.0.1',port:rconPort,password,timeout:30000});break;}catch(e){if(i===19)throw e;await sleep(200);}}
  } catch(error) { await killTree(child); await log.close(); throw error; }
  let stopped=false;
  const server={child,port,directory,installation,
    command:command=>{if(stopped)throw new Error('Server is stopped');return rcon.send(command);},
    async stop(){
      if(stopped)return;stopped=true;
      // `stop` saves every world itself. A slow flush (a generated End, many loaded chunks) can outlast the
      // RCON reply timeout; that must not skip the stop. `java` may be a launcher stub on Windows, so a
      // forced stop kills the whole tree rather than leave the real server running.
      try{await rcon.send('save-all flush');}catch{}
      try{await rcon.send('stop');}catch{}
      const end=Date.now()+60000;while(!exited&&Date.now()<end)await sleep(100);
      if(!exited){await killTree(child);await sleep(500);}
      await rcon.end().catch(()=>{});await log.close().catch(()=>{});
      if(!exited)throw new Error('Minecraft did not shut down cleanly');
    }
  };
  return server;
}
