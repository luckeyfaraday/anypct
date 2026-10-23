import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadScenario } from '../src/util.mjs';
import { createSession } from '../src/session.mjs';
import { runModel } from '../src/models.mjs';

// Fixture only: the neutral chat-completions runner against a scripted local "model" on a real paused-clock
// server. Checks the loop, the paused tool contract, usage accounting and estimated cost. Never scored.
const script=[
  {name:'observe',arguments:{}},
  {name:'move',arguments:{direction:'none',jump:true,seconds:0.2}},
  {name:'wait',arguments:{seconds:5}},
  {name:'wait',arguments:{seconds:5}},
  {name:'wait',arguments:{seconds:5}},
];
const requests=[];
const provider=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);requests.push(request);
  const step=script[Math.min(requests.length-1,script.length-1)];
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({model:'scripted/test',choices:[{message:{content:`Step ${requests.length}.`,tool_calls:[{id:`c${requests.length}`,type:'function',function:{name:step.name,arguments:JSON.stringify(step.arguments)}}]}}],
    usage:{prompt_tokens:1000,completion_tokens:100,completion_tokens_details:{reasoning_tokens:40},prompt_tokens_details:{cached_tokens:800}}}));
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const scenario=await loadScenario('speedrun-dragon-paused');
const session=await createSession({scenario,kind:'fixture',model:'API / scripted-test',durationSeconds:12});
try{
  const result=await runModel(session,{model:'scripted/test',apiKey:'fixture-key',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,pricing:{inputPerMTok:1,outputPerMTok:10}});
  assert.equal(result.reason,'deadline',JSON.stringify(result));assert.equal(result.clock.kind,'paused');
  assert.ok(result.clock.courseMs>=12000&&result.clock.courseMs<14000,JSON.stringify(result.clock));
  assert.ok(requests.length>=4,`requests ${requests.length}`);
  const tools=Object.fromEntries(requests[0].tools.map(t=>[t.function.name,t.function.description]));
  assert.doesNotMatch(tools.move_to,/Return immediately/,'Paused tool descriptions');
  assert.match(requests[0].messages[0].content,/game-time deadline/);
  // The tool result for a mutating call carries the action outcome and an observation.
  const toolMessage=requests[2].messages.find(m=>m.role==='tool'&&m.tool_call_id==='c2');
  const moved=JSON.parse(toolMessage.content);assert.equal(moved.ok,true);assert.equal(moved.action.name,'move');assert.ok(moved.observation.position);
  const m=result.metrics;assert.equal(m.modelCalls,requests.length);assert.equal(m.reasoningOutputTokens,40*requests.length);assert.equal(m.cachedInputTokens,800*requests.length);
  assert.ok(Math.abs(m.estimatedCostUsd-requests.length*(1000*1+100*10)/1e6)<1e-12);assert.equal(m.costUsd,null,'No provider-reported cost');
  const events=await fs.readFile(path.join(session.directory,'events.jsonl'),'utf8');assert.equal(events.includes('fixture-key'),false,'No key in logs');
  console.log(`PASS neutral runner: ${requests.length} scripted calls, paused clock ${JSON.stringify(result.clock)}, estimated cost $${m.estimatedCostUsd.toFixed(6)}; fixture excluded.`);
}finally{await session.finish('fixture_cleanup');provider.close();}
