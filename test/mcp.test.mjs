import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startAgentApi } from '../src/agent-api.mjs';
import { ROOT } from '../src/util.mjs';

test('MCP bridge lists tools and forwards validated calls through authenticated HTTP',async()=>{
  const calls=[];const session={id:'test',token:'unit-test-token',scenario:{id:'test'},tool:async(name,args)=>{calls.push({name,args});return {ok:true,health:20};}};
  const api=await startAgentApi(session,{publishConnection:false});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'src/mcp.mjs')],env:{...process.env,BENCH_AGENT_URL:api.url,BENCH_AGENT_TOKEN:api.token},stderr:'pipe'});
  const client=new Client({name:'benchmark-test-client',version:'1.0.0'});
  try{await client.connect(transport);const result=await client.listTools();assert.ok(result.tools.some(t=>t.name==='mine'));assert.ok(result.tools.some(t=>t.name==='cancel'));assert.equal(result.tools.some(t=>t.name==='execute'),false);const observation=await client.callTool({name:'observe',arguments:{}});assert.equal(JSON.parse(observation.content[0].text).health,20);assert.equal(calls[0].name,'observe');}
  finally{await client.close();await session.closeApi();}
});
