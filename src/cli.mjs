import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadScenario, readJson, DATA, sleep, errorText } from './util.mjs';
import { installServer } from './server.mjs';
import { prepareSnapshot } from './snapshots.mjs';
import { createSession } from './session.mjs';
import { startAgentApi } from './agent-api.mjs';
import { runModel } from './models.mjs';
import { startViewer } from './viewer.mjs';
import { listRuns } from './dashboard.mjs';
import { summarize } from './report.mjs';

const {positionals,values}=parseArgs({allowPositionals:true,options:{
  'accept-eula':{type:'boolean'},scenario:{type:'string',default:'sprint'},model:{type:'string'},'base-url':{type:'string'},external:{type:'boolean'},viewer:{type:'boolean'},seconds:{type:'string'},port:{type:'string'},profiles:{type:'string'},repeats:{type:'string',default:'5'},help:{type:'boolean'}
}});
const command=positionals[0]??'help';let active;
process.on('SIGINT',()=>{if(active)void active.finish('operator_stop').then(()=>process.exit(130));else process.exit(130);});
process.on('SIGTERM',()=>{if(active)void active.finish('operator_stop').then(()=>process.exit(143));else process.exit(143);});
async function run(profile={}){
  const scenario=await loadScenario(values.scenario);
  const model=profile.model??values.model??process.env.BENCH_MODEL;
  const apiKey=process.env[profile.keyEnv??'BENCH_API_KEY'];
  if(!values.external&&(!model||!apiKey))throw new Error('Use --external for an MCP/HTTP agent, or specify --model and set BENCH_API_KEY.');
  active=await createSession({scenario,model:values.external?'external-agent':`API / ${profile.name??model}`,durationSeconds:values.seconds?Number(values.seconds):scenario.durationSeconds});
  console.log(`Run: ${active.id}`);
  try{
    if(values.viewer)console.log(`Live Minecraft: ${await startViewer(active)}`);
    if(values.external){
      const connection=await startAgentApi(active,{port:Number(values.port??0)});
      console.log(`Agent API: ${connection.url}\nPrivate connection details: ${path.join(DATA,'control.json')}\nMCP: node src/mcp.mjs\nThe clock starts with the first observe/action call. Waiting up to 180 seconds for an agent.`);
      const readyDeadline=Date.now()+180000;
      while(!active.finished){if(!active.started&&Date.now()>readyDeadline){active.infrastructureError='Agent did not connect before the startup deadline';await active.finish('agent_not_connected');break;}await sleep(200);}
    }else await runModel(active,{api:profile.api,model,apiKey,baseUrl:profile.baseUrl??values['base-url']??process.env.BENCH_BASE_URL,options:profile.options??{},pricing:profile.pricing??null,maxTokensField:profile.maxTokensField,version:profile.version});
    console.log(JSON.stringify(active.result,null,2));return active.result;
  }finally{await active.finish('stopped');active=null;}
}
try{
  if(command==='setup'){const result=await installServer({acceptEula:values['accept-eula']});console.log(`Verified official Minecraft ${result.version}: ${result.sha1}\n${result.jar}`);}
  else if(command==='prepare'){const scenario=await loadScenario(values.scenario);console.log(`Preparing ${scenario.id}; the original snapshot will be retained.`);const result=await prepareSnapshot(scenario);console.log(`Snapshot ready: ${result.worldHash}\nSpawn: ${result.spawn.join(', ')}`);}
  else if(command==='run')await run();
  else if(command==='batch'){
    if(!values.profiles)throw new Error('Provide --profiles profiles.json');
    if(values.external)throw new Error('Batch mode requires model profiles');
    const profiles=await readJson(path.resolve(values.profiles));const repeats=Number(values.repeats);
    if(!Array.isArray(profiles)||!profiles.length||!Number.isInteger(repeats)||repeats<1||repeats>100)throw new Error('Use a non-empty profiles array and 1–100 repetitions');
    // Round robin avoids running all trials for one model before the others.
    for(let i=0;i<repeats;i++)for(const profile of profiles){console.log(`Trial ${i+1}/${repeats}: ${profile.model}`);await run(profile);}
  }
  else if(command==='report')console.log(JSON.stringify(summarize((await listRuns()).map(r=>r.result).filter(Boolean)),null,2));
  else console.log(`Minecraft Sprint Bench\n\n  setup [--accept-eula]                Download and checksum the official pinned server\n  prepare [--scenario sprint]          Create an immutable starting snapshot\n  run --external [--viewer]            Connect an agent through HTTP or MCP\n  run --model provider/model           Run a model through a chat-completions API\n      [--base-url URL] [--viewer]      BENCH_API_KEY is read only from the environment\n      [--scenario sprint] [--seconds 600]\n  batch --profiles profiles.json --repeats 5\n  report                              Aggregate comparable evaluations\n\n  npm test                            Contract and referee tests\n  npm run smoke                       Real-server fixture tests (never benchmark results)\n  npm run ui                          Local results and replay dashboard\n\nEULA: https://aka.ms/MinecraftEULA\nSettings and starting snapshots are hashed. Course completion time has not yet been calibrated.`);
}catch(error){console.error(errorText(error));if(active)await active.finish('error').catch(()=>{});process.exitCode=1;}
