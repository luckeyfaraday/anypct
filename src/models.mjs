import { toolDefinitions } from './agent-api.mjs';
import { sleep, errorText, sha256, writeJson, sharedLandmarks } from './util.mjs';
import path from 'node:path';

// The real-clock prompt is unchanged for courses without an objective or hidden landmarks.
const ASYNC='Actions are asynchronous: a successful call returns a running action ID, not proof of completion. Observe the active/last action and actual inventory to determine outcomes. Only one mutating action may run at once. Use observe, wait, recipes, or cancel while an action runs.';
const BLOCKING='Each mutating action runs until it finishes or its time slice ends, then returns its result and a fresh observation; check the result and actual inventory to determine outcomes. Only one action runs at a time.';
const pausedNote=scenario=>`The game clock is paused while you think: the world runs only during actions and wait, and only that game time counts toward the deadline. Thinking is also limited by a wall-clock cap of ${Math.round((scenario.wallSeconds??Math.min(3*scenario.durationSeconds,10800))/60)} minutes.`;
export function systemPrompt(scenario){const paused=scenario.clock==='paused';return `You control one Minecraft Java ${scenario.minecraft} Survival player. Your objective is to ${scenario.objective??'defeat the Ender Dragon and enter its exit portal'} before the ${paused?'game-time':'real-time'} deadline.\n${scenario.description}\nDifficulty: ${scenario.difficulty}. Seed: ${scenario.seed}. Shared landmarks: ${JSON.stringify(sharedLandmarks(scenario))}.\nAll gameplay must use the provided tools. ${paused?BLOCKING:ASYNC} Navigation never mines or builds for you. Mining uses the equipped item. Craft count means recipe executions.\n${paused?pausedNote(scenario):'The world continues while you think.'} Use a brief public intent sentence when useful; do not narrate private reasoning. Avoid repeated failing actions; adapt using tool feedback. The referee determines completion. You have no administrator commands or world-file access. Observations expose local visible blocks/entities and remembered landmarks, not all loaded terrain. Previous exchanges beyond ${scenario.historyTurns} decisions are dropped; the latest observation retains discovered landmarks. The run ends on victory or timeout, not on a claim of success.`;}
export function buildRequest({model,messages,tools,maxTokens,options={},maxTokensField='max_tokens'}){
  const protectedKeys=['model','messages','tools','tool_choice','stream','max_tokens','max_completion_tokens'];
  if(protectedKeys.some(k=>Object.hasOwn(options,k)))throw new Error('Provider options cannot override benchmark tools, model, messages, or budgets');
  return {model,messages,tools,tool_choice:'auto',[maxTokensField]:maxTokens,stream:false,...options};
}
// Provider adapters share one decision loop. Each turns an observation and the kept history into a request,
// reads tool calls and usage from the reply, and records an exchange in its own message format.
function chatCompletions({model,baseUrl,apiKey,options,maxTokensField},scenario){
  const tools=toolDefinitions(scenario).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
  return {
    request(prompt,history,observation){const user={role:'user',content:observation};return {user,body:buildRequest({model,messages:[{role:'system',content:prompt},...history.flat(),user],tools,maxTokens:scenario.maxOutputTokens,options,maxTokensField})};},
    send:(body,signal)=>fetch(`${baseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal}),
    parse(data){
      const raw=data.choices?.[0]?.message,usage=data.usage??{};if(!raw)return null;
      const calls=(raw.tool_calls??[]).map(c=>{let args=null;try{args=JSON.parse(c.function.arguments);}catch{}return {id:c.id,name:c.function.name,args};});
      return {calls,log:{model:data.model,id:data.id,usage,content:raw.content??null,tool_calls:raw.tool_calls??[]},
        assistant:{role:'assistant',content:raw.content??null,...(raw.tool_calls?.length?{tool_calls:raw.tool_calls}:{})},
        usage:{input:usage.prompt_tokens??0,output:usage.completion_tokens??0,reasoning:usage.completion_tokens_details?.reasoning_tokens??0,cached:usage.prompt_tokens_details?.cached_tokens??0,cost:usage.cost}};
    },
    exchange:(user,assistant,results)=>[user,assistant,...results.map(({call,result})=>({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)}))],
  };
}
// Native Anthropic Messages: effort is `output_config.effort`; Claude 5 models think adaptively, and their
// thinking blocks go back unchanged with the tool calls they accompanied. Tool results open the next user
// message, followed by the new observation; a result whose call left the history window is dropped.
function anthropicMessages({model,baseUrl,apiKey,options,version},scenario){
  const protectedKeys=['model','messages','tools','tool_choice','stream','max_tokens','system'];
  if(protectedKeys.some(k=>Object.hasOwn(options,k)))throw new Error('Provider options cannot override benchmark tools, model, messages, or budgets');
  const tools=toolDefinitions(scenario).map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}));
  return {
    request(prompt,history,observation){
      const messages=[];history.forEach((e,i)=>{messages.push({role:'user',content:i===0?e.user.filter(b=>b.type!=='tool_result'):e.user},{role:'assistant',content:e.assistant});});
      const user=[...(history.at(-1)?.results??[]),{type:'text',text:observation}];messages.push({role:'user',content:user});
      return {user,body:{model,max_tokens:scenario.maxOutputTokens,system:prompt,messages,tools,tool_choice:{type:'auto'},...options}};
    },
    send:(body,signal)=>fetch(`${baseUrl.replace(/\/$/,'')}/messages`,{method:'POST',headers:{'x-api-key':apiKey,'anthropic-version':version??'2023-06-01','content-type':'application/json'},body:JSON.stringify(body),signal}),
    parse(data){
      if(!Array.isArray(data.content))return null;const usage=data.usage??{};
      const calls=data.content.filter(b=>b.type==='tool_use').map(b=>({id:b.id,name:b.name,args:b.input&&typeof b.input==='object'?b.input:null}));
      return {calls,log:{model:data.model,id:data.id,usage,stop:data.stop_reason,content:data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')||null,tool_calls:calls},
        assistant:data.content,
        usage:{input:(usage.input_tokens??0)+(usage.cache_creation_input_tokens??0)+(usage.cache_read_input_tokens??0),output:usage.output_tokens??0,reasoning:usage.output_tokens_details?.thinking_tokens??0,cached:usage.cache_read_input_tokens??0,cost:undefined}};
    },
    exchange:(user,assistant,results)=>({user,assistant,results:results.map(({call,result})=>({type:'tool_result',tool_use_id:call.id,content:JSON.stringify(result),...(result?.ok===false?{is_error:true}:{})}))}),
  };
}
// The neutral runner: every model gets the same prompt, tools, observation messages, history window and
// output budget through one decision loop, unlike the Claude Code and Codex apps, which each manage
// context their own way. A profile's pricing gives an estimate when the provider reports no cost.
export async function runModel(session,{api='chat-completions',model,baseUrl,apiKey,options={},pricing=null,maxTokensField,version}){
  if(!apiKey)throw new Error("Set the profile's API key environment variable (BENCH_API_KEY by default) before starting a model run");
  if(!model)throw new Error('Specify --model or BENCH_MODEL');
  if(!['chat-completions','anthropic'].includes(api))throw new Error(`Unknown API ${api}`);
  baseUrl??=api==='anthropic'?'https://api.anthropic.com/v1':'https://openrouter.ai/api/v1';
  const url=new URL(baseUrl);
  if(url.username||url.password||url.search)throw new Error('Base URL must not contain credentials or query parameters');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('Use HTTPS for remote model APIs');
  const adapter=(api==='anthropic'?anthropicMessages:chatCompletions)({model,baseUrl,apiKey,options,maxTokensField,version},session.scenario);
  const prompt=systemPrompt(session.scenario),history=[];
  session.manifest.modelSettings={runner:api,model,baseUrl:url.toString(),options,pricing,...(maxTokensField?{maxTokensField}:{}),...(version?{version}:{}),maxOutputTokens:session.scenario.maxOutputTokens,historyTurns:session.scenario.historyTurns,promptHash:sha256(prompt)};
  // On the paused clock thinking costs no game time, so a request is bounded only by its own timeout.
  const requestMs=()=>session.clock?.kind==='paused'?120000:Math.max(1,Math.min(60000,Math.floor(session.remaining())));
  await writeJson(path.join(session.directory,'manifest.json'),session.manifest);
  let failures=0;
  try{
    await session.begin();
    while(!session.finishing&&session.remaining()>0){
      if(session.metrics.modelCalls>=session.scenario.maxCalls){await session.finish('model_call_limit');break;}
      const {user,body}=adapter.request(prompt,history.slice(-session.scenario.historyTurns),JSON.stringify(session.observation()));
      session.log.event('model_request',{request:body});session.metrics.modelCalls++;
      const start=performance.now();let data;
      try{
        const response=await adapter.send(body,AbortSignal.any([session.abort.signal,AbortSignal.timeout(requestMs())]));
        if(!response.ok)throw new Error(`Model API HTTP ${response.status}`);
        data=await response.json();failures=0;
      }catch(error){
        session.metrics.inferenceMs+=performance.now()-start;
        // A request may have been billed even if its response was lost.
        session.metrics.costReportingComplete=false;session.metrics.costUsd=null;
        session.log.event('model_error',{message:errorText(error)});
        if(session.finishing||session.remaining()<=0)break;
        if(++failures>=3){session.infrastructureError='Model API failed three consecutive requests';await session.finish('provider_error');break;}
        await sleep(Math.min(1000*failures,session.remaining()));continue;
      }
      session.metrics.inferenceMs+=performance.now()-start;
      const reply=adapter.parse(data),m=session.metrics;
      session.log.event('model_response',reply?.log??{model:data.model,id:data.id,usage:data.usage,content:null,tool_calls:[]});
      if(reply){const u=reply.usage;m.inputTokens+=u.input;m.outputTokens+=u.output;m.reasoningOutputTokens=(m.reasoningOutputTokens??0)+u.reasoning;m.cachedInputTokens=(m.cachedInputTokens??0)+u.cached;
        if(pricing)m.estimatedCostUsd=(m.estimatedCostUsd??0)+(u.input*pricing.inputPerMTok+u.output*pricing.outputPerMTok)/1e6;
        if(!Number.isFinite(u.cost)){m.costReportingComplete=false;m.costUsd=null;}else if(m.costReportingComplete)m.costUsd=(m.costUsd??0)+u.cost;}
      else{m.costReportingComplete=false;m.costUsd=null;}
      if(session.finishing||session.remaining()<=0)break;
      if(!reply){session.infrastructureError='Model API returned no assistant message';await session.finish('provider_error');break;}
      const results=[];
      for(const call of reply.calls)results.push({call,result:call.args?await session.tool(call.name,call.args):{ok:false,error:'invalid_arguments_json'}});
      history.push(adapter.exchange(user,reply.assistant,results));
      if(!reply.calls.length)await sleep(Math.min(500,session.remaining()));
    }
  }finally{if(!session.finishing)await session.finish('deadline');else await session.finishPromise;}
  return session.result;
}
