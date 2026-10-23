import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { DATA, readJson } from './util.mjs';
import { schemas, descriptions } from './actions.mjs';

const connection=process.env.BENCH_AGENT_URL?{url:process.env.BENCH_AGENT_URL,token:process.env.BENCH_AGENT_TOKEN}:await readJson(path.join(DATA,'control.json'));
if(!connection.token)throw new Error('BENCH_AGENT_TOKEN is required');
// The run's own tool descriptions: they differ on the paused clock, where actions run to completion.
const listed=await fetch(`${connection.url}/tools`,{headers:{Authorization:`Bearer ${connection.token}`},signal:AbortSignal.timeout(10000)}).then(r=>r.ok?r.json():null).catch(()=>null);
const described=Object.fromEntries((listed?.tools??[]).map(t=>[t.name,t.description]));
const server=new McpServer({name:'minecraft-sprint-bench',version:'0.1.0'});
for(const [name,schema] of Object.entries(schemas)){
  server.registerTool(name,{description:described[name]??descriptions[name],inputSchema:schema.shape},async args=>{
    const response=await fetch(`${connection.url}/tool`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args}),signal:AbortSignal.timeout(20000)});
    const result=await response.json();return {content:[{type:'text',text:JSON.stringify(result)}],isError:!response.ok||result.ok===false};
  });
}
await server.connect(new StdioServerTransport());
