// Installs a vanilla Minecraft client (default 1.16.1, the benchmark's version) into its own folder for
// footage capture: client jar, libraries, natives and assets from Mojang's servers, each checked by SHA-1.
// Asset objects already in the user's .minecraft are copied rather than downloaded; .minecraft is only read.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT_DIR=process.env.BENCH_CLIENT_DIR||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','data','client');
const MANIFEST='https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const USER_ASSETS=path.join(process.env.APPDATA??'','.minecraft','assets','objects');

const sha1=data=>createHash('sha1').update(data).digest('hex');
const exists=file=>fs.access(file).then(()=>true,()=>false);
async function download(url,file,hash){
  if(await exists(file)&&(!hash||sha1(await fs.readFile(file))===hash))return false;
  await fs.mkdir(path.dirname(file),{recursive:true});
  for(let attempt=1;;attempt++){
    try{
      const response=await fetch(url);if(!response.ok)throw new Error(`${response.status} ${url}`);
      const data=Buffer.from(await response.arrayBuffer());
      if(hash&&sha1(data)!==hash)throw new Error(`SHA-1 mismatch for ${url}`);
      await fs.writeFile(file,data);return true;
    }catch(error){if(attempt>=4)throw error;await new Promise(r=>setTimeout(r,1000*attempt));}
  }
}
async function pool(items,limit,fn){let next=0;await Promise.all(Array.from({length:limit},async()=>{while(next<items.length)await fn(items[next++]);}));}
const allowed=rules=>{
  if(!rules)return true;let ok=false;
  for(const rule of rules){if(rule.os&&rule.os.name!=='windows')continue;ok=rule.action==='allow';}
  return ok;
};

export function layout(version='1.16.1'){
  return {version,root:CLIENT_DIR,versionJson:path.join(CLIENT_DIR,'versions',version,`${version}.json`),jar:path.join(CLIENT_DIR,'versions',version,`${version}.jar`),
    libraries:path.join(CLIENT_DIR,'libraries'),natives:path.join(CLIENT_DIR,'natives',version),assets:path.join(CLIENT_DIR,'assets'),game:path.join(CLIENT_DIR,'game')};
}

export async function install(version='1.16.1',log=console.log){
  const L=layout(version);
  const manifest=await (await fetch(MANIFEST)).json();
  const entry=manifest.versions.find(v=>v.id===version);if(!entry)throw new Error(`Unknown version ${version}`);
  await download(entry.url,L.versionJson,entry.sha1);
  const meta=JSON.parse(await fs.readFile(L.versionJson,'utf8'));
  if(await download(meta.downloads.client.url,L.jar,meta.downloads.client.sha1))log(`client ${version}`);
  const classpath=[],natives=[];
  for(const lib of meta.libraries){
    if(!allowed(lib.rules))continue;
    const artifact=lib.downloads?.artifact;
    if(artifact){const file=path.join(L.libraries,artifact.path);await download(artifact.url,file,artifact.sha1);classpath.push(file);}
    const key=lib.natives?.windows?.replace('${arch}','64');const native=key&&lib.downloads?.classifiers?.[key];
    if(native){const file=path.join(L.libraries,native.path);await download(native.url,file,native.sha1);natives.push(file);}
  }
  await fs.mkdir(L.natives,{recursive:true});
  for(const file of natives)execFileSync(path.join(process.env.SystemRoot??'C:/Windows','System32','tar.exe'),['-xf',file,'-C',L.natives,'--exclude','META-INF'],{windowsHide:true});
  log(`${classpath.length} libraries, ${natives.length} native archives`);
  const indexFile=path.join(L.assets,'indexes',`${meta.assetIndex.id}.json`);
  await download(meta.assetIndex.url,indexFile,meta.assetIndex.sha1);
  const objects=Object.values(JSON.parse(await fs.readFile(indexFile,'utf8')).objects);
  let copied=0,fetched=0;
  await pool(objects,16,async({hash})=>{
    const rel=path.join(hash.slice(0,2),hash),file=path.join(L.assets,'objects',rel);
    if(await exists(file))return;
    await fs.mkdir(path.dirname(file),{recursive:true});
    const local=path.join(USER_ASSETS,rel);
    if(await exists(local)&&sha1(await fs.readFile(local))===hash){await fs.copyFile(local,file);copied++;return;}
    await download(`https://resources.download.minecraft.net/${hash.slice(0,2)}/${hash}`,file,hash);fetched++;
  });
  log(`assets: ${objects.length} objects (${copied} copied from .minecraft, ${fetched} downloaded)`);
  await fs.writeFile(path.join(CLIENT_DIR,`${version}.classpath.json`),JSON.stringify({classpath:[...classpath,L.jar],mainClass:meta.mainClass,assetIndex:meta.assetIndex.id}));
  return L;
}

// Options for footage: no tutorial, no sound, no pause on focus loss, fixed render and GUI settings. No frame cap:
// the 60 fps limiter waits in ~15.6 ms Windows timer steps and delivered ~32 fps; the capture takes 60.
export async function writeOptions(L,{renderDistance=12,guiScale=3,fov=0}={}){
  await fs.mkdir(L.game,{recursive:true});
  const options={version:2567,renderDistance,guiScale,fov,maxFps:260,enableVsync:false,graphicsMode:1,ao:2,renderClouds:'true',entityShadows:true,
    pauseOnLostFocus:false,tutorialStep:'none',skipMultiplayerWarning:true,realmsNotifications:false,chatVisibility:0,narrator:0,fullscreen:false,
    bobView:true,gamma:0.5,particles:0,mipmapLevels:4,soundCategory_master:0.0,lang:'en_us'};
  await fs.writeFile(path.join(L.game,'options.txt'),Object.entries(options).map(([k,v])=>`${k}:${v}`).join('\n')+'\n');
}

export function launchArgs(L,{username,uuid,server,port,width=1920,height=1080,java='java'}){
  const {classpath,mainClass,assetIndex}=JSON.parse(fsSync.readFileSync(path.join(CLIENT_DIR,`${L.version}.classpath.json`),'utf8'));
  return {java,args:['-Xmx3G','-Xms1G',`-Djava.library.path=${L.natives}`,'-cp',classpath.join(';'),mainClass,
    '--username',username,'--uuid',uuid.replace(/-/g,''),'--accessToken','0','--userType','legacy','--version',L.version,'--versionType','release',
    '--gameDir',L.game,'--assetsDir',L.assets,'--assetIndex',assetIndex,'--width',String(width),'--height',String(height),'--server',server,'--port',String(port)]};
}

if(import.meta.url===`file:///${process.argv[1]?.replace(/\\/g,'/')}`){
  const {values}=parseArgs({options:{version:{type:'string',default:'1.16.1'}}});
  const L=await install(values.version);await writeOptions(L);console.log(`Client ready in ${L.root}`);
}
