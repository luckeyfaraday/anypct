import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createSession } from '../src/session.mjs';
import { startAgentApi } from '../src/agent-api.mjs';
import { startViewer } from '../src/viewer.mjs';
import { schemas } from '../src/actions.mjs';
import { systemPrompt } from '../src/models.mjs';
import { applyFinalClaudeUsage } from '../src/claude-usage.mjs';
import { DATA, ROOT, loadScenario, writeJson, sha256, sleep } from '../src/util.mjs';

const {values}=parseArgs({options:{model:{type:'string',default:'opus'},effort:{type:'string',default:'high'},scenario:{type:'string',default:'sprint'},seconds:{type:'string'},viewer:{type:'boolean',default:true}},allowNegative:true});
const executable=process.env.BENCH_CLAUDE||(process.platform==='win32'?path.join(process.env.APPDATA,'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'):'claude');
const cliVersion=execFileSync(executable,['--version'],{encoding:'utf8',windowsHide:true}).trim();
const auth=JSON.parse(execFileSync(executable,['auth','status'],{encoding:'utf8',windowsHide:true}));
if(!auth.loggedIn)throw new Error('Claude Code is not signed in. Run claude auth login first.');
const scenario=await loadScenario(values.scenario);
const session=await createSession({scenario,model:`Claude Code / ${values.model} / ${values.effort}`,durationSeconds:Number(values.seconds??scenario.durationSeconds)});
const agentDirectory=path.join(DATA,'agents',session.id),workspace=path.join(agentDirectory,'workspace');
await fs.mkdir(workspace,{recursive:true});
const expectedTools=Object.keys(schemas).map(name=>`mcp__minecraft__${name}`);
const prompt=systemPrompt(scenario).replace(`Previous exchanges beyond ${scenario.historyTurns} decisions are dropped; the latest observation retains discovered landmarks.`,'This agent uses Claude Code context management; observations retain discovered landmarks.');
const settings={disableAllHooks:true,autoMemoryEnabled:false,permissions:{defaultMode:'dontAsk'}};
const config={mcpServers:{minecraft:{type:'stdio',command:process.execPath,args:[path.join(ROOT,'src/mcp.mjs')]}}};
const args=['--print','--verbose','--output-format','stream-json','--model',values.model,'--effort',values.effort,
  '--restricted','--tools','','--allowedTools',expectedTools.join(','),'--permission-mode','dontAsk',
  '--strict-mcp-config','--mcp-config',JSON.stringify(config),'--settings',JSON.stringify(settings),
  '--setting-sources','','--disable-slash-commands','--no-chrome','--no-session-persistence',
  '--max-turns',String(scenario.maxCalls),'--system-prompt',prompt];
session.manifest.modelSettings={runner:'claude-code-mcp',cliVersion,requestedModel:values.model,effort:values.effort,
  launcherHash:sha256(await fs.readFile(new URL(import.meta.url))),
  contextPolicy:'Claude Code native context management',maxOutputTokens:'Claude Code default (the course budget applies to the neutral runner)',maxTurns:scenario.maxCalls,
  promptHash:sha256(prompt),authentication:auth.authMethod,builtinTools:[],mcpTools:expectedTools,liveViewer:values.viewer};
session.metrics.inferenceMs=undefined;
session.metrics.costReportingComplete=false;
session.metrics.tokenUsageComplete=false;
await writeJson(path.join(session.directory,'manifest.json'),session.manifest);
await fs.writeFile(path.join(agentDirectory,'system-prompt.txt'),prompt);
await fs.copyFile(new URL(import.meta.url),path.join(agentDirectory,'runner.mjs'));
let child,exited=false,exitCode,stderr='',initSeen=false,streamError,metadataWrite=Promise.resolve();
const messages=new Map();
const stop=()=>{if(child&&!exited)child.kill();};
session.abort.signal.addEventListener('abort',stop,{once:true});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void session.finish('operator_stop'));
function record(event){
  if(event.type==='assistant'){
    const message=event.message;
    if(message?.id){
      messages.set(message.id,message.usage??{});
      session.metrics.modelCalls=messages.size;
      session.metrics.inputTokens=[...messages.values()].reduce((n,u)=>n+(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0),0);
      session.metrics.outputTokens=[...messages.values()].reduce((n,u)=>n+(u.output_tokens??0),0);
    }
    const content=(message?.content??[]).filter(block=>['text','tool_use'].includes(block.type));
    session.log.event('model_response',{runner:'claude-code',id:message?.id,model:message?.model,usage:message?.usage,content});
    if(message?.model)session.manifest.modelSettings.resolvedModel=message.model;
    for(const block of content)if(block.type==='text')console.log(`Claude: ${block.text}`);
    if(event.error)streamError=event.error;
  }else if(event.type==='system'&&event.subtype==='init'){
    initSeen=true;
    const extra=(event.tools??[]).filter(tool=>!expectedTools.includes(tool));
    const missing=expectedTools.filter(tool=>!(event.tools??[]).includes(tool));
    session.log.event('agent_init',{model:event.model,tools:event.tools,mcpServers:event.mcp_servers,cliVersion});
    session.manifest.modelSettings.resolvedModel=event.model;
    metadataWrite=writeJson(path.join(session.directory,'manifest.json'),session.manifest);
    console.log(`Claude model: ${event.model}; Minecraft tools: ${(event.tools??[]).length}`);
    if(extra.length||missing.length){session.infrastructureError=`Claude tool contract mismatch: extra=${extra.join(',')}; missing=${missing.join(',')}`;void session.finish('agent_configuration_error');}
  }else if(event.type==='result'){
    session.log.event('agent_result',{subtype:event.subtype,isError:event.is_error,result:event.result,errors:event.errors,usage:event.usage,modelUsage:event.modelUsage,estimatedCostUsd:event.total_cost_usd,durationApiMs:event.duration_api_ms});
    // Subscription cost estimates are not an invoice or reported API charge.
    session.metrics.estimatedCostUsd=event.total_cost_usd??null;
    applyFinalClaudeUsage(session.metrics,event.usage);
    if(Number.isFinite(event.duration_api_ms))session.metrics.inferenceMs=event.duration_api_ms;
    if(event.is_error)streamError=event.errors?.join('; ')||event.result||event.subtype;
  }
}
try{
  const connection=await startAgentApi(session,{publishConnection:false});
  // --no-viewer skips the live Prismarine viewer to save memory; telemetry replay is unaffected.
  const viewerUrl=values.viewer?await startViewer(session):null;
  console.log(`Run: ${session.id}\nDashboard: http://127.0.0.1:8123/?run=${session.id}&live=1\nLive Minecraft: ${viewerUrl}`);
  await writeJson(path.join(DATA,'claude-run.json'),{id:session.id,dashboard:`http://127.0.0.1:8123/?run=${session.id}&live=1`,viewerUrl});
  const env={...process.env,BENCH_AGENT_URL:connection.url,BENCH_AGENT_TOKEN:connection.token,
    ENABLE_TOOL_SEARCH:'false',MCP_CONNECTION_NONBLOCKING:'0',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1',
    // No output cap: the app track runs each app with its own limits, as the Codex runner does. A 2,048-token
    // cap aborted a whole Claude Code session when one adaptive-thinking turn ran over it.
    CLAUDE_CODE_MAX_RETRIES:'2',CLAUDE_CODE_EFFORT_LEVEL:values.effort};
  child=spawn(executable,args,{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{record(JSON.parse(line));}catch(error){streamError=`Unreadable Claude event: ${error.message}`;}});
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8000);fsSync.appendFileSync(path.join(agentDirectory,'stderr.log'),data);});
  child.on('error',error=>{streamError=error.message;exited=true;});
  child.on('close',code=>{exitCode=code;exited=true;});
  child.stdin.end(`Begin the benchmark now. Call observe first, then play using only the supplied Minecraft tools until the run finishes. The run has a ${scenario.clock==='paused'?'game-time':'real-time'} deadline of ${Math.round(session.remaining()/1000)} seconds.`);
  const startupDeadline=Date.now()+180000;
  while(!session.finished&&!exited){
    if(!session.started&&Date.now()>startupDeadline){session.infrastructureError='Claude did not start gameplay within 180 seconds';await session.finish('agent_startup_timeout');break;}
    await sleep(250);
  }
  await metadataWrite;
  if(!session.finishing){
    if(!initSeen||streamError||exitCode!==0)session.infrastructureError=String(streamError||stderr||`Claude exited with code ${exitCode}`).slice(0,2000);
    await session.finish(session.infrastructureError?'agent_error':'agent_stopped');
  }else await session.finishPromise;
  console.log(JSON.stringify(session.result,null,2));
}catch(error){session.infrastructureError??=error.message;await session.finish('agent_runner_error');throw error;}
finally{stop();await session.finish('stopped');}
