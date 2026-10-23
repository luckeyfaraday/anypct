// `bench submit`: checks a finished local run, stages the files that will be published (prompts withheld on
// request), and uploads them with the screen recording to the community site. The contract is site/API.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DATA, safeId, sha256, sleep, errorText } from '../src/util.mjs';
import { checkBundle, withholdEvent, findSecrets, filesFor } from './bundle.mjs';
import { getGame } from './games/index.mjs';

const VIDEO_SLACK_SECONDS=5;
const exec=promisify(execFile);

async function videoSeconds(file){
  try{const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file]);const s=Number(stdout.trim());return Number.isFinite(s)?s:null;}
  catch{return null;}
}
async function hashFile(file){
  const hash=createHash('sha256');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
// Values of credential-looking environment variables, so a key that leaked into a log is caught by value too.
const environmentSecrets=()=>Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v&&v.length>=12).map(([,v])=>v);

// Builds the publishable bundle in data/submissions/<run id>/ and returns what will be uploaded. Throws with
// every reason when the run cannot be submitted.
export async function stageRun({runId,video,withhold=false,data=DATA,log=console.log}){
  const directory=path.join(data,'runs',safeId(runId));
  const manifestText=await fsp.readFile(path.join(directory,'manifest.json'),'utf8');
  const resultText=await fsp.readFile(path.join(directory,'result.json'),'utf8').catch(()=>null);
  const manifest=JSON.parse(manifestText),result=resultText?JSON.parse(resultText):null;
  const events=(await fsp.readFile(path.join(directory,'events.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const check=checkBundle({manifest,result,events});
  const reasons=[...check.reasons];
  const eventsText=events.map(e=>JSON.stringify(withhold?withholdEvent(e):e)).join('\n')+'\n';
  const secrets=findSecrets([manifestText,resultText??'',eventsText].join('\n'),environmentSecrets());
  if(secrets.length)reasons.push(`the files contain what looks like a credential (${[...new Set(secrets)].join(', ')}); remove it before submitting`);
  const wallSeconds=check.group?getGame(check.game).wallMs(result)/1000:0;
  let seconds=null;
  if(!video)reasons.push('a screen recording is required: pass --video run.mp4');
  else if(!/\.mp4$/i.test(video))reasons.push('the video must be an .mp4 file');
  else if(!fs.existsSync(video))reasons.push(`no video at ${video}`);
  else{
    seconds=await videoSeconds(video);
    if(seconds===null)log('ffprobe was not found or could not read the video; its length will be checked by a moderator.');
    else if(seconds<wallSeconds-VIDEO_SLACK_SECONDS)reasons.push(`the video is ${seconds.toFixed(1)} s but the run took ${wallSeconds.toFixed(1)} s; record the whole run`);
  }
  if(reasons.length)throw new Error(`Run ${runId} cannot be submitted:\n- ${reasons.join('\n- ')}`);
  const staged=path.join(data,'submissions',safeId(runId));
  await fsp.mkdir(staged,{recursive:true});
  // The video comes from --video and the event log is the publishable (possibly withheld) version; every
  // other file the game declares is copied unchanged from the run directory.
  const files=[];
  for(const name of filesFor(check.game,'official')){
    if(name==='events.jsonl')await fsp.writeFile(path.join(staged,name),eventsText);
    else if(name!=='video.mp4')await fsp.copyFile(path.join(directory,safeId(name)),path.join(staged,name));
    const file=name==='video.mp4'?path.resolve(video):path.join(staged,name);
    files.push({name,file,size:(await fsp.stat(file)).size,sha256:name==='video.mp4'?await hashFile(file):sha256(await fsp.readFile(file))});
  }
  return {runId,manifest,result,check,withheld:withhold,videoSeconds:seconds,staged,files};
}

async function call(site,token,method,route,body,{raw=false}={}){
  const headers={authorization:`Bearer ${token}`};
  if(body!==undefined&&!raw)headers['content-type']='application/json';
  const response=await fetch(new URL(route,site),{method,headers,body:body===undefined?undefined:raw?body:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={error:text.slice(0,300)};}
  if(!response.ok)throw Object.assign(new Error(`${method} ${route}: ${response.status} ${data.error??''}`.trim()),{status:response.status});
  return data;
}
async function readPart(file,start,length){
  const handle=await fsp.open(file,'r');
  try{const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,start);return buffer.subarray(0,bytesRead);}
  finally{await handle.close();}
}
// Server errors and dropped connections are retried; a 4xx means the request itself was refused.
async function putPart(site,token,route,body){
  for(let attempt=1;;attempt++){
    try{return await call(site,token,'PUT',route,body,{raw:true});}
    catch(error){if(attempt>=4||(error.status>=400&&error.status<500))throw error;await sleep(1000*2**attempt);}
  }
}

export async function submitRun({runId,system,video,withhold=false,site=process.env.BENCH_SITE_URL,token=process.env.BENCH_SUBMIT_TOKEN,dryRun=false,data=DATA,log=console.log}){
  if(!dryRun){
    if(!site)throw new Error('Set BENCH_SITE_URL or pass --site with the community site address.');
    if(!token)throw new Error('Set BENCH_SUBMIT_TOKEN to a submit token from your profile page.');
    if(!system)throw new Error('Pass --system with the slug of a system registered on your profile.');
    const me=await call(site,token,'GET','/api/me');
    if(!me.user?.termsAccepted)throw new Error(`Accept the submission terms first: ${me.terms?.url??new URL('/terms',site)}`);
    const waitlist=me.user.waitlist,staff=['moderator','admin'].includes(me.user.role);
    if(!staff&&waitlist&&waitlist.status!=='admitted')throw new Error(waitlist.status==='waiting'?`Submissions are open to early-access testers; you are number ${waitlist.place} in line.`:`Join the early-access waitlist first: ${new URL('/',site)}`);
    if(!me.systems?.some(s=>s.slug===system))throw new Error(`System "${system}" is not registered on your account. Yours: ${me.systems?.map(s=>s.slug).join(', ')||'none'}`);
  }
  const stage=await stageRun({runId,video,withhold,data,log});
  const {game,course,clock}=stage.check.group;
  log(`${runId}\n  ${getGame(game).name}, course ${course}, ${clock} clock, score ${stage.check.score}${stage.check.rescored?' (rescored from checkpoints)':''}${withhold?', prompts withheld':''}`);
  for(const f of stage.files)log(`  ${f.name.padEnd(13)} ${(f.size/1e6).toFixed(1).padStart(8)} MB  ${f.sha256.slice(0,12)}`);
  if(dryRun){log(`Checks passed. Staged in ${stage.staged}; nothing was uploaded.`);return {staged:stage.staged,score:stage.check.score};}
  const opened=await call(site,token,'POST','/api/runs',{game:stage.check.game,system,runId,withheld:withhold,videoSeconds:stage.videoSeconds,files:stage.files.map(({name,size,sha256})=>({name,size,sha256}))});
  const parts={};
  for(const f of stage.files){
    parts[f.name]=[];const count=Math.max(1,Math.ceil(f.size/opened.partSize));
    for(let n=1;n<=count;n++){
      const body=await readPart(f.file,(n-1)*opened.partSize,opened.partSize);
      parts[f.name].push(await putPart(site,token,`/api/runs/${opened.id}/files/${encodeURIComponent(f.name)}/parts/${n}`,body));
      if(count>1)log(`  ${f.name}: part ${n}/${count}`);
    }
  }
  const done=await call(site,token,'POST',`/api/runs/${opened.id}/complete`,{parts});
  log(done.status==='rejected'?`Rejected:\n- ${done.reasons.join('\n- ')}`:`Submitted: ${done.status}, score ${done.score}. A moderator will review it.`);
  log(done.url??opened.url);
  return done;
}

// npm run bench:submit -- --run <id> --system <slug> --video run.mp4 [--withhold-prompts] [--dry-run] [--site URL]
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{run:{type:'string'},system:{type:'string'},video:{type:'string'},'withhold-prompts':{type:'boolean'},site:{type:'string'},'dry-run':{type:'boolean'}}});
  try{
    if(!values.run)throw new Error('Usage: npm run bench:submit -- --run <run id> --system <slug> --video run.mp4 [--withhold-prompts] [--dry-run]\nBENCH_SUBMIT_TOKEN and BENCH_SITE_URL are read from the environment.');
    await submitRun({runId:values.run,system:values.system,video:values.video,withhold:values['withhold-prompts'],site:values.site??process.env.BENCH_SITE_URL,dryRun:values['dry-run']});
  }catch(error){console.error(errorText(error));process.exitCode=1;}
}
