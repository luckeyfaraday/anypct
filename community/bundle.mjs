// Submissions: the files each tier uploads, prompt withholding, credential scanning and the checks shared by
// `bench:submit`, the web upload page and the site. Official games are rechecked by their module in games/;
// community games get the generic check below and a score or time entered by a moderator. No Node APIs: the
// site imports this in a Worker and the upload page in the browser.
import { getGame, gameOf } from './games/index.mjs';
import { parseAgentLog, validateAgentLog } from './agent-log.mjs';

// Official games declare their own run files; community games all upload the agent log and the video.
export const COMMUNITY_FILES=['agent-log.jsonl','video.mp4'];
export const filesFor=(game,tier)=>tier==='community'?COMMUNITY_FILES:getGame(game).files;
export const TERMS_VERSION='2026-10-22';

// Withheld prompts: model requests go entirely (tool results are logged separately); responses keep
// usage and the tool calls they made, which are actions, and lose their text and reasoning.
const callOf=block=>block&&(block.type==='tool_use'||block.type==='mcp_tool_call'||block.type==='function_call');
function keepCalls(data){
  const out={withheld:true};
  for(const key of ['runner','id','model','usage','stop'])if(data[key]!==undefined)out[key]=data[key];
  if(Array.isArray(data.tool_calls))out.tool_calls=data.tool_calls;
  if(Array.isArray(data.actions))out.actions=data.actions;
  if(Array.isArray(data.content))out.content=data.content.filter(callOf).map(b=>({type:b.type,name:b.name,input:b.input}));
  if(data.item){const i=data.item;out.item=i.type==='mcp_tool_call'?{id:i.id,type:i.type,server:i.server,tool:i.tool,arguments:i.arguments}:{id:i.id,type:i.type};}
  return out;
}
export function withholdEvent(event){
  if(event.type==='model_request')return {...event,data:{withheld:true}};
  if(event.type==='model_response')return {...event,data:keepCalls(event.data??{})};
  if(event.type==='agent_result')return {...event,data:{...event.data,result:undefined,withheld:true}};
  return event;
}

// Patterns for credentials that must never be published. A match blocks the submission.
const SECRETS=[/sk-ant-[A-Za-z0-9_-]{20,}/,/sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/,/AKIA[0-9A-Z]{16}/,/gh[pousr]_[A-Za-z0-9]{36}/,/xox[abpr]-[A-Za-z0-9-]{10,}/,/AIza[0-9A-Za-z_-]{35}/,/Bearer [A-Za-z0-9._~+/-]{24,}/];
export function findSecrets(text,extra=[]){
  const hits=SECRETS.filter(p=>p.test(text)).map(p=>p.source);
  for(const value of extra)if(value&&value.length>=12&&text.includes(value))hits.push('a value from this machine\'s environment');
  return hits;
}

// Checks a run bundle. Returns the reasons it cannot be accepted (empty when it can) and what the board needs.
// `events` is the parsed events.jsonl. The site runs the same checks on what was uploaded.
export function checkBundle({manifest,result,events}){
  const id=gameOf(manifest);let game;
  try{game=getGame(id);}catch{return {game:id,reasons:[`game ${id} is not on the community board`],score:null,rescored:false,group:null,startStateHash:null};}
  const reasons=[];
  if(manifest.kind!=='evaluation')reasons.push(`run kind is ${manifest.kind}; only evaluations can be submitted`);
  if(!game.courses.some(c=>c.id===manifest.scenario?.id))reasons.push(`course ${manifest.scenario?.id} is not on the ${game.name} board`);
  if(!result)reasons.push('the run has no result');
  if(result&&result.id!==manifest.id)reasons.push('result.json belongs to a different run');
  if(reasons.length)return {game:id,reasons,score:null,rescored:false,group:null,startStateHash:null};
  const checked=game.check({manifest,result,events});
  return {game:id,...checked,reasons:[...reasons,...checked.reasons],group:{game:id,...game.group(manifest)},startStateHash:game.startStateHash(manifest)??null};
}

// A community-game run: the agent log must be valid, disclose its model and scaffold, contain no credentials,
// and be covered by the video. Nothing is scored here; a moderator of that game enters the score or time.
export function checkCommunityBundle({game,category,logText,videoSeconds=null}){
  const parsed=parseAgentLog(logText);
  const checked=validateAgentLog(parsed.events,{game,category,videoSeconds});
  const reasons=[...parsed.reasons,...checked.reasons];
  const secrets=findSecrets(logText);
  if(secrets.length)reasons.push(`the log contains what looks like a credential (${[...new Set(secrets)].join(', ')})`);
  return {reasons,stats:checked.stats,events:parsed.events};
}
