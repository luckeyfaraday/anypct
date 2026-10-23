import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { writeJson, DATA } from './util.mjs';
import path from 'node:path';
import { descriptionsFor, schemas } from './actions.mjs';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const toolDefinitions=(scenario={})=>{const descriptions=descriptionsFor(scenario.clock);return Object.entries(schemas).map(([name,schema])=>({name,description:descriptions[name],inputSchema:zodToJsonSchema(schema,{$refStrategy:'none'})}));};
export function authorized(header,token){const a=Buffer.from(header??''),b=Buffer.from(`Bearer ${token}`);return a.length===b.length&&timingSafeEqual(a,b);}
export async function readBody(req){let bytes=0;const chunks=[];for await(const c of req){bytes+=c.length;if(bytes>65536)throw new Error('Request too large');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
export function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
export async function startAgentApi(session,{port=0,publishConnection=true}={}){
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.origin)return json(res,403,{error:'Browser origins are not allowed on the agent control API'});
      if(!authorized(req.headers.authorization,session.token))return json(res,401,{error:'unauthorized'});
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&pathname==='/tools')return json(res,200,{tools:toolDefinitions(session.scenario),scenario:session.scenario});
      if(req.method==='GET'&&pathname==='/observe')return json(res,200,await session.tool('observe',{}));
      if(req.method==='POST'&&pathname==='/tool'){const body=await readBody(req);return json(res,200,await session.tool(body.name,body.arguments??{}));}
      return json(res,404,{error:'not_found'});
    }catch(error){if(!res.headersSent)json(res,400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  session.agentApi=url;session.closeApi=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  // This private connection file is never exposed by the dashboard or run artifacts API.
  if(publishConnection)await writeJson(path.join(DATA,'control.json'),{runId:session.id,url,token:session.token});
  return {url,token:session.token};
}
