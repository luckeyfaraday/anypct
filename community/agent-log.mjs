// Validates a community-game agent log (agent-log.md): every action must trace to an earlier model response,
// and the clock must run forward. No Node APIs: the site imports this in a Worker.
const TYPES=new Set(['run_start','model_request','model_response','action','observation','error','run_end']);
const CLOCK_SLACK_MS=2000,VIDEO_SLACK_SECONDS=5,MAX_REASONS=20;

export function parseAgentLog(text){
  const events=[],reasons=[];
  text.split('\n').forEach((line,i)=>{if(!line.trim())return;try{events.push(JSON.parse(line));}catch{reasons.push(`line ${i+1} is not JSON`);}});
  return {events,reasons};
}

// Returns the reasons the log cannot be accepted (at most 20, empty when it can) and its counts.
export function validateAgentLog(events,{game,category,videoSeconds=null}={}){
  const reasons=[],add=r=>{if(reasons.length<MAX_REASONS)reasons.push(r);};
  if(!events.length)return {reasons:['the log is empty'],stats:null};
  const start=events[0],end=events.at(-1),t0=Date.parse(start?.at);
  if(start?.type!=='run_start')add('the first event is not run_start');
  else{
    const d=start.data??{};
    if(game&&d.game!==game)add(`run_start names game ${JSON.stringify(d.game)}, not ${game}`);
    if(category&&d.category!==category)add(`run_start names category ${JSON.stringify(d.category)}, not ${category}`);
    if(typeof d.model!=='string'||!d.model.trim())add('run_start does not disclose the model');
    if(typeof d.scaffold?.name!=='string'||!d.scaffold.name.trim())add('run_start does not disclose the scaffold name');
  }
  if(end?.type!=='run_end')add('the last event is not run_end');
  const responses=new Set();let modelCalls=0,actions=0,prevAt=-Infinity,prevElapsed=-Infinity;
  events.forEach((e,i)=>{
    const at=Date.parse(e?.at),where=`event ${i}`;
    if(!e||typeof e!=='object'||Array.isArray(e))return add(`${where} is not an object`);
    if(e.seq!==i)add(`${where} has seq ${e.seq}, expected ${i}`);
    if(!TYPES.has(e.type))add(`${where} has unknown type ${JSON.stringify(e.type)}`);
    if(!e.data||typeof e.data!=='object'||Array.isArray(e.data))add(`${where} has no data object`);
    if(!Number.isFinite(at))add(`${where} has no valid time`);
    else if(at<prevAt)add(`${where} is earlier than the event before it`);
    if(!Number.isFinite(e.elapsedMs)||e.elapsedMs<0)add(`${where} has no valid elapsedMs`);
    else if(e.elapsedMs<prevElapsed)add(`${where} has elapsedMs smaller than the event before it`);
    else if(Number.isFinite(at)&&Number.isFinite(t0)&&Math.abs(at-t0-e.elapsedMs)>CLOCK_SLACK_MS)add(`${where}: elapsedMs disagrees with its time by more than 2 s`);
    if(i>0&&e.type==='run_start')add(`${where} is a second run_start`);
    if(i<events.length-1&&e.type==='run_end')add(`${where} is a run_end before the last line`);
    if(e.type==='model_response'){
      modelCalls++;const id=e.data?.id;
      if(typeof id!=='string'||!id)add(`${where}: model_response has no id`);
      else if(responses.has(id))add(`${where}: model_response id ${JSON.stringify(id)} is repeated`);
      else responses.add(id);
    }
    if(e.type==='action'){
      actions++;
      if(!responses.has(e.data?.call))add(`${where}: action does not name an earlier model_response in call`);
      if(typeof e.data?.name!=='string'||!e.data.name)add(`${where}: action has no name`);
    }
    if(Number.isFinite(at))prevAt=at;if(Number.isFinite(e.elapsedMs))prevElapsed=e.elapsedMs;
  });
  if(!modelCalls)add('the log has no model_response');
  if(!actions)add('the log has no action');
  const durationMs=Number.isFinite(end?.elapsedMs)?end.elapsedMs:null;
  if(videoSeconds!==null&&durationMs!==null&&videoSeconds<durationMs/1000-VIDEO_SLACK_SECONDS)
    add(`the video is ${videoSeconds.toFixed(1)} s but the run took ${(durationMs/1000).toFixed(1)} s`);
  return {reasons,stats:{modelCalls,actions,durationMs,model:start?.data?.model??null,scaffold:start?.data?.scaffold??null}};
}

// Model responses, actions and errors on the run page's timeline, timed from run_start. A model response
// shows the start of its text, or "Model call" when the text was withheld or empty.
const clip=(text,n=80)=>text.length>n?`${text.slice(0,n-1).trimEnd()}…`:text;
export function agentLogTimeline(events){
  return events.filter(e=>['model_response','action','error'].includes(e.type)&&Number.isFinite(e.elapsedMs)).map(e=>({
    kind:e.type==='model_response'?'model':e.type,ms:Math.round(e.elapsedMs),
    label:e.type==='action'?e.data?.name:e.type==='error'?e.data?.message:typeof e.data?.text==='string'&&e.data.text.trim()?clip(e.data.text.trim().replace(/\s+/g,' ')):'Model call'}));
}
