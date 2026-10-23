import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runModel } from '../src/models.mjs';
import { loadScenario, sleep } from '../src/util.mjs';
import { ActionManager } from '../src/actions.mjs';

async function fakeSession(){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minecraft-bench-test-'));let start=0;const events=[],calls=[];const session={
  directory,scenario:await loadScenario('sprint'),manifest:{},abort:new AbortController(),finishing:false,metrics:{modelCalls:0,inputTokens:0,outputTokens:0,inferenceMs:0,costUsd:null,costReportingComplete:true},
  log:{event:(type,data)=>events.push({type,data})},begin:async()=>{start=performance.now();},remaining:()=>Math.max(0,10000-(performance.now()-start)),observation:()=>({health:20,position:[0,70,0]}),
  tool:async(name,args)=>{calls.push({name,args});return {ok:true};},
  finish:async reason=>{session.finishing=true;session.abort.abort();session.result={reason};return session.result;}
};return {session,events,calls};}
async function provider(handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:`http://127.0.0.1:${server.address().port}/v1`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};}
async function removeTestDirectory(directory){const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.join(path.resolve(os.tmpdir()),'minecraft-bench-test-')));await fs.rm(resolved,{recursive:true,force:true});}
test('compatible model adapter executes returned tools and preserves usage without credentials in logs',async()=>{
  const {session,events,calls}=await fakeSession();session.scenario={...session.scenario,maxCalls:1};let request;
  const p=await provider(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;request=JSON.parse(body);assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer test-private-key');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'test/model',choices:[{message:{content:'Inspecting the route.',tool_calls:[{id:'a',type:'function',function:{name:'move_to',arguments:JSON.stringify({position:[2,70,0]})}}]}}],usage:{prompt_tokens:100,completion_tokens:20,cost:0.001}}));});
  try{await runModel(session,{model:'test/model',apiKey:'test-private-key',baseUrl:p.url});assert.equal(calls[0].name,'move_to');assert.ok(request.tools.some(t=>t.function.name==='cancel'));assert.equal(session.metrics.modelCalls,1);assert.equal(session.metrics.costUsd,.001);assert.equal(JSON.stringify(events).includes('test-private-key'),false);}finally{await p.close();await removeTestDirectory(session.directory);}
});
test('malformed tool arguments become feedback, not a privileged operation',async()=>{
  const {session,calls,events}=await fakeSession();session.scenario={...session.scenario,maxCalls:1};
  const p=await provider((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'bad',type:'function',function:{name:'mine',arguments:'not json'}}]}}]}));});
  try{await runModel(session,{model:'test/model',apiKey:'test',baseUrl:p.url});assert.equal(calls.length,0);assert.equal(session.metrics.costUsd,null);assert.ok(events.some(e=>e.type==='model_response'));}finally{await p.close();await removeTestDirectory(session.directory);}
});
test('an unresponsive native operation faults rather than allowing overlap',async()=>{
  let fault=false;const manager=new ActionManager({execute:()=>new Promise(()=>{}),stop:()=>{},onFault:()=>{fault=true;}});
  manager.start('mine',{position:[0,70,0]});await sleep(5);await manager.cancel();assert.equal(fault,true);assert.equal(manager.start('mine',{position:[1,70,0]}).error,'controller_fault');
});
test('native Anthropic adapter returns thinking unchanged, opens each user turn with tool results, and sets effort',async()=>{
  const {session,calls}=await fakeSession();session.scenario={...session.scenario,maxCalls:4,historyTurns:2};const requests=[];
  const p=await provider(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const r=JSON.parse(body);requests.push({r,headers:req.headers});
    assert.equal(req.url,'/v1/messages');const n=requests.length;res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({id:`m${n}`,model:'claude-test',stop_reason:'tool_use',content:[{type:'thinking',thinking:'',signature:`sig${n}`},{type:'text',text:`Turn ${n}.`},{type:'tool_use',id:`t${n}`,name:'wait',input:{seconds:1}}],
      usage:{input_tokens:10,cache_read_input_tokens:90,output_tokens:50,output_tokens_details:{thinking_tokens:30}}}));});
  try{
    await runModel(session,{api:'anthropic',model:'claude-test',apiKey:'secret-key',baseUrl:p.url,options:{output_config:{effort:'high'}}});
    assert.equal(requests.length,4);assert.equal(calls.length,4);
    const first=requests[0];assert.equal(first.headers['x-api-key'],'secret-key');assert.ok(first.headers['anthropic-version']);
    assert.deepEqual(first.r.output_config,{effort:'high'});assert.equal(first.r.tool_choice.type,'auto');assert.ok(first.r.tools.every(t=>t.input_schema&&!t.function));
    assert.equal(typeof first.r.system,'string');assert.equal(first.r.messages.length,1);
    // Turn 2: the previous assistant content comes back verbatim, and the tool result leads the next user message.
    const second=requests[1].r.messages;assert.deepEqual(second[1].content.map(b=>b.type),['thinking','text','tool_use']);assert.equal(second[1].content[0].signature,'sig1');
    assert.equal(second[2].content[0].type,'tool_result');assert.equal(second[2].content[0].tool_use_id,'t1');assert.equal(second[2].content.at(-1).type,'text');
    // Turn 4 keeps two exchanges; the oldest kept user turn loses the result whose call left the window.
    const fourth=requests[3].r.messages;assert.equal(fourth.length,5);assert.ok(fourth[0].content.every(b=>b.type!=='tool_result'));assert.equal(fourth[1].content[2].id,'t2');
    assert.equal(session.metrics.inputTokens,400);assert.equal(session.metrics.cachedInputTokens,360);assert.equal(session.metrics.reasoningOutputTokens,120);assert.equal(session.metrics.costUsd,null);
  }finally{await p.close();await removeTestDirectory(session.directory);}
  const other=(await fakeSession()).session;try{await assert.rejects(runModel(other,{api:'anthropic',model:'m',apiKey:'k',baseUrl:p.url,options:{system:'override'}}),/cannot override/);}finally{await removeTestDirectory(other.directory);}
});
