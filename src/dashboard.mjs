import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA, safeId, readJson, loadScenario } from './util.mjs';
import { scoreRun } from './referee.mjs';
import { json } from './agent-api.mjs';
import { summarize } from './report.mjs';

// Runs recorded before score v2 are scored from their saved checkpoints, approach distances and dragon
// health, using the course's current segments when the saved course had none. Marked as rescored.
const segments=new Map();
async function rescore(manifest,result){
  if(!result||result.score||!result.progress?.route?.length)return result;
  const id=manifest.scenario.id;if(!segments.has(id))segments.set(id,await loadScenario(id).then(s=>s.score).catch(()=>undefined));
  const scenario={...manifest.scenario,score:manifest.scenario.score??segments.get(id)};
  const last={dragonSeen:result.dragonHealthMin!==null&&result.dragonHealthMin!==undefined?1:0,dragonHealthMin:result.dragonHealthMin,goalItems:result.goalItems,crystalsDestroyed:result.crystalsDestroyed};
  try{return {...result,score:{...scoreRun({scenario,milestones:result.milestones,durationMs:result.durationMs,last,approach:result.approach??[]}),rescored:true}};}catch{return result;}
}
export async function listRuns(){
  const root=path.join(DATA,'runs');const names=await fs.readdir(root).catch(()=>[]);
  const runs=await Promise.all(names.map(async id=>{
    try{safeId(id);const manifest=await readJson(path.join(root,id,'manifest.json'));const result=await rescore(manifest,await readJson(path.join(root,id,'result.json')).catch(()=>null));const status=await readJson(path.join(root,id,'status.json')).catch(()=>null);return {id,manifest,result,status};}catch{return null;}
  }));return runs.filter(Boolean).sort((a,b)=>b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}
export async function startDashboard({port=8123}={}){
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='GET')return json(res,405,{error:'read_only'});
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/api/runs'){const runs=await listRuns();return json(res,200,{runs,leaderboard:summarize(runs.map(r=>r.result).filter(Boolean))});}
      const match=url.pathname.match(/^\/api\/runs\/([^/]+)\/(frames|events|manifest|result)$/);
      if(match){
        const id=safeId(decodeURIComponent(match[1])),kind=match[2],dir=path.join(DATA,'runs',id);
        if(kind==='manifest'||kind==='result')return json(res,200,await readJson(path.join(dir,`${kind}.json`)));
        const text=await fs.readFile(path.join(dir,'events.jsonl'),'utf8').catch(async error=>{if(error.code==='ENOENT'){await readJson(path.join(dir,'manifest.json'));return '';}throw error;});
        const events=text.split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
        if(kind==='frames')return json(res,200,events.filter(e=>e.type==='frame').map(e=>({elapsedMs:e.elapsedMs,dimension:e.data.dimension,position:e.data.position,health:e.data.health,food:e.data.food,inventory:e.data.inventory,entities:e.data.entities,blocks:e.data.blocks,actions:e.data.actions})));
        // Public export has gameplay and model traffic, but never private connection files.
        res.writeHead(200,{'Content-Type':'application/x-ndjson','Content-Disposition':`attachment; filename="${id}.jsonl"`,'Cache-Control':'no-store'});return res.end(text);
      }
      const file={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}[url.pathname];
      if(!file)return json(res,404,{error:'not_found'});
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(await fs.readFile(path.join(ROOT,'public',file)));
    }catch(error){json(res,error.code==='ENOENT'?404:400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,url:`http://127.0.0.1:${server.address().port}`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const i=process.argv.indexOf('--port');const port=Number(i>=0?process.argv[i+1]:process.env.PORT||8123);
  const dashboard=await startDashboard({port});console.log(`Minecraft Bench dashboard: ${dashboard.url}`);
}
