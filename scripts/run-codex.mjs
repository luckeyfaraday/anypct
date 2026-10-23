import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createSession } from '../src/session.mjs';
import { startAgentApi } from '../src/agent-api.mjs';
import { startViewer } from '../src/viewer.mjs';
import { schemas } from '../src/actions.mjs';
import { systemPrompt } from '../src/models.mjs';
import { DATA, ROOT, loadScenario, writeJson, sha256, sleep } from '../src/util.mjs';

const {values}=parseArgs({options:{model:{type:'string',default:'gpt-6-astra'},effort:{type:'string',default:'high'},scenario:{type:'string',default:'sprint'},seconds:{type:'string'},fixture:{type:'boolean',default:false},viewer:{type:'boolean',default:true}},allowNegative:true});
const launcher=process.env.BENCH_CODEX||path.join(process.env.APPDATA??'','npm/node_modules/@openai/codex/bin/codex.js');
const codex=(args,options={})=>execFileSync(process.execPath,[launcher,...args],{encoding:'utf8',windowsHide:true,...options}).trim();
const cliVersion=codex(['--version']);
const status=spawnSync(process.execPath,[launcher,'login','status'],{encoding:'utf8',windowsHide:true}),login=`${status.stdout}${status.stderr}`.trim();
if(!/logged in/i.test(login))throw new Error('Codex is not signed in. Run codex login first.');
const scenario=await loadScenario(values.scenario);
// --fixture marks a wiring check that can never enter scores.
const session=await createSession({scenario,kind:values.fixture?'fixture':'evaluation',model:`Codex / ${values.model} / ${values.effort}`,durationSeconds:Number(values.seconds??scenario.durationSeconds)});
const agentDirectory=path.join(DATA,'agents',session.id),workspace=path.join(agentDirectory,'workspace');
await fs.mkdir(workspace,{recursive:true});
const expectedTools=Object.keys(schemas);
const prompt=systemPrompt(scenario).replace(`Previous exchanges beyond ${scenario.historyTurns} decisions are dropped; the latest observation retains discovered landmarks.`,'This agent uses Codex context management; observations retain discovered landmarks.');
const instructionsFile=path.join(agentDirectory,'system-prompt.txt');
await fs.writeFile(instructionsFile,prompt);
const slash=p=>p.replace(/\\/g,'/');
// Built-in tool families that could reach files, the network, images, or other agents.
// User config (other MCP servers, plugins) is ignored; auth still comes from CODEX_HOME.
const disabledFeatures=['shell_tool','unified_exec','view_image','image_generation','multi_agent','multi_agent_v2','agent_message_board','enable_fanout','default_mode_request_user_input','apps','plugins','browser_use','browser_use_external','computer_use','sleep_tool','skill_search','tool_suggest','goals','in_app_browser','hooks'];
const config={model_reasoning_effort:values.effort,approval_policy:'never',web_search:'disabled',project_doc_max_bytes:0,'agents.max_threads':1,model_instructions_file:slash(instructionsFile),
  'mcp_servers.minecraft.command':slash(process.execPath),'mcp_servers.minecraft.args':[slash(path.join(ROOT,'src/mcp.mjs'))],'mcp_servers.minecraft.env_vars':['BENCH_AGENT_URL','BENCH_AGENT_TOKEN'],
  'mcp_servers.minecraft.default_tools_approval_mode':'approve','mcp_servers.minecraft.tool_timeout_sec':30,'mcp_servers.minecraft.startup_timeout_sec':30};
const args=[launcher,'exec','--json','--ignore-user-config','--ephemeral','--skip-git-repo-check','-C',workspace,'-m',values.model,'-s','read-only',
  ...Object.entries(config).flatMap(([k,v])=>['-c',`${k}=${JSON.stringify(v)}`]),...disabledFeatures.flatMap(f=>['--disable',f]),'-'];
session.manifest.modelSettings={runner:'codex-exec-mcp',cliVersion,requestedModel:values.model,effort:values.effort,
  launcherHash:sha256(await fs.readFile(new URL(import.meta.url))),contextPolicy:'Codex native context management',liveViewer:values.viewer,
  promptHash:sha256(prompt),authentication:login.split('\n')[0],mcpTools:expectedTools.map(name=>`mcp__minecraft__${name}`),disabledFeatures,
  // Code mode cannot be disabled without hiding MCP tools in this Codex version. Its exec runtime has no
  // filesystem, process, or network APIs (audited), but it can script sequences of tool calls in one turn.
  residualBuiltins:['code-mode exec/wait (isolated JS that can call the Minecraft tools)','apply_patch (read-only sandbox)','clock','tool_search','MCP resource listing','sub-agent spawn (fails in --ephemeral)']};
session.metrics.inferenceMs=undefined;session.metrics.costReportingComplete=false;session.metrics.tokenUsageComplete=false;session.metrics.modelCalls=null;session.metrics.toolCalls=0;
await writeJson(path.join(session.directory,'manifest.json'),session.manifest);
await fs.copyFile(new URL(import.meta.url),path.join(agentDirectory,'runner.mjs'));
let child,exited=false,exitCode,stderr='',threadSeen=false,streamError,turnUsage=null;
const stop=()=>{if(child&&!exited)child.kill();};
session.abort.signal.addEventListener('abort',stop,{once:true});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void session.finish('operator_stop'));
const violation=reason=>{if(session.finishing)return;session.infrastructureError=`Codex tool contract violation: ${reason}`;void session.finish('agent_configuration_error');};
function record(event){
  if(event.type==='thread.started'){threadSeen=true;session.log.event('agent_init',{runner:'codex',threadId:event.thread_id,cliVersion,model:values.model});}
  else if(event.type==='item.started'||event.type==='item.completed'){
    const item=event.item??{};
    if(event.type==='item.completed')session.log.event('model_response',{runner:'codex',item});
    if(item.type==='agent_message'&&event.type==='item.completed')console.log(`Codex: ${item.text}`);
    else if(item.type==='mcp_tool_call'){if(item.server!=='minecraft')violation(`MCP server ${item.server}`);else if(event.type==='item.started')session.metrics.toolCalls++;}
    else if(['command_execution','file_change','web_search'].includes(item.type))violation(item.type);
  }else if(event.type==='turn.completed'){
    turnUsage=event.usage??null;session.log.event('agent_result',{runner:'codex',usage:turnUsage});
    session.metrics.inputTokens=turnUsage?.input_tokens??null;session.metrics.cachedInputTokens=turnUsage?.cached_input_tokens??null;
    session.metrics.outputTokens=turnUsage?.output_tokens??null;session.metrics.reasoningOutputTokens=turnUsage?.reasoning_output_tokens??null;
    session.metrics.tokenUsageComplete=!!turnUsage;session.metrics.usageSource='codex_turn_completed';
  }else if(event.type==='turn.failed'||event.type==='error'){streamError=event.error?.message??event.message??JSON.stringify(event);session.log.event('agent_error',{runner:'codex',event});}
}
try{
  const connection=await startAgentApi(session,{publishConnection:false});
  // --no-viewer skips the live Prismarine viewer to save memory; telemetry replay is unaffected.
  const viewerUrl=values.viewer?await startViewer(session):null;
  console.log(`Run: ${session.id}\nDashboard: http://127.0.0.1:8123/?run=${session.id}&live=1\nLive Minecraft: ${viewerUrl}`);
  await writeJson(path.join(DATA,'codex-run.json'),{id:session.id,dashboard:`http://127.0.0.1:8123/?run=${session.id}&live=1`,viewerUrl});
  const env={...process.env,BENCH_AGENT_URL:connection.url,BENCH_AGENT_TOKEN:connection.token};
  child=spawn(process.execPath,args,{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{if(!line.startsWith('{'))return;try{record(JSON.parse(line));}catch(error){streamError=`Unreadable Codex event: ${error.message}`;}});
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8000);fsSync.appendFileSync(path.join(agentDirectory,'stderr.log'),data);});
  child.on('error',error=>{streamError=error.message;exited=true;});
  child.on('close',code=>{exitCode=code;exited=true;});
  child.stdin.end(`Begin the benchmark now. Call observe first, then play using only the supplied Minecraft tools until the run finishes. The run has a ${scenario.clock==='paused'?'game-time':'real-time'} deadline of ${Math.round(session.remaining()/1000)} seconds.`);
  const startupDeadline=Date.now()+180000;
  while(!session.finished&&!exited){
    if(!session.started&&Date.now()>startupDeadline){session.infrastructureError='Codex did not start gameplay within 180 seconds';await session.finish('agent_startup_timeout');break;}
    await sleep(250);
  }
  if(!session.finishing){
    if(!threadSeen||streamError||exitCode!==0)session.infrastructureError=String(streamError||stderr||`Codex exited with code ${exitCode}`).slice(0,2000);
    await session.finish(session.infrastructureError?'agent_error':'agent_stopped');
  }else await session.finishPromise;
  console.log(JSON.stringify(session.result,null,2));
}catch(error){session.infrastructureError??=error.message;await session.finish('agent_runner_error');throw error;}
finally{stop();await session.finish('stopped');}
