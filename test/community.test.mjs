import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkBundle, withholdEvent, findSecrets } from '../community/bundle.mjs';
import { getGame, gameOf, listCourses } from '../community/games/index.mjs';
import * as score from '../community/games/minecraft/score.mjs';
import * as referee from '../src/referee.mjs';
import { submitRun } from '../community/submit.mjs';

const { rescoreResult }=score;

const ID='speedrun-dragon-2026-10-22T00-00-00-000Z-0000test';
const scenario={id:'speedrun-dragon',score:[{checkpoint:'dragonDead',partial:'dragonDamage'},{checkpoint:'exitEnd'}]};
function fixture(){
  const manifest={id:ID,kind:'evaluation',model:'Test / model',snapshotHash:'abc123',scenario};
  const result={id:ID,eligible:true,outcome:'agent_stopped',durationMs:600000,elapsedMs:20000,milestones:{dragonDead:{wallMs:300000,tick:6000}},dragonHealthMin:0,approach:[]};
  result.score=rescoreResult(scenario,result);
  const events=[
    {seq:0,type:'run_start',elapsedMs:0,data:{}},
    {seq:1,type:'model_request',data:{request:{system:'secret strategy',messages:[{role:'user',content:'go'}]}}},
    {seq:2,type:'model_response',data:{runner:'claude-code',id:'msg_1',model:'m',usage:{output_tokens:9},content:[{type:'thinking',thinking:'private plan'},{type:'text',text:'private words'},{type:'tool_use',name:'mcp__minecraft__observe',input:{}}]}},
    {seq:3,type:'model_response',data:{runner:'codex',item:{id:'i1',type:'reasoning',text:'private reasoning'}}},
    {seq:4,type:'dimension',elapsedMs:1200,data:{dimension:'the_end'}},
    {seq:5,type:'death',elapsedMs:150000,data:{}},
    {seq:6,type:'milestone',elapsedMs:300000.4,data:{name:'dragonDead',wallMs:300000,tick:6000}},
  ];
  return {manifest,result,events};
}

test('the community copy of score v2 is identical to the referee', () => {
  const text=f=>f.toString().replace(/\r\n/g,'\n');
  for(const name of ['scoreSegments','partialProgress','scoreRun'])assert.equal(text(score[name]),text(referee[name]),name);
});

test('withheld prompts keep tool calls and usage, drop text and reasoning', () => {
  const out=JSON.stringify(fixture().events.map(withholdEvent));
  for(const word of ['secret strategy','private plan','private words','private reasoning'])assert.ok(!out.includes(word),word);
  assert.ok(out.includes('mcp__minecraft__observe'));
  assert.ok(out.includes('"output_tokens":9'));
});

test('credentials are found by pattern and by environment value', () => {
  assert.deepEqual(findSecrets('nothing here'),[]);
  assert.equal(findSecrets(`key sk-ant-${'a'.repeat(30)}`).length,1);
  assert.equal(findSecrets('uses hunter2-long-value ok',['hunter2-long-value']).length,1);
});

test('a bundle passes only when its score and checkpoints agree', () => {
  const ok=checkBundle(fixture());
  assert.deepEqual(ok.reasons,[]);
  assert.equal(ok.score,0.375);
  assert.deepEqual(ok.group,{game:'minecraft',course:'speedrun-dragon',clock:'real'});
  assert.equal(ok.startStateHash,'abc123');
  const tampered=fixture();tampered.result.score={...tampered.result.score,value:0.9};
  assert.match(checkBundle(tampered).reasons.join(),/does not match/);
  const unlogged=fixture();unlogged.events=unlogged.events.filter(e=>e.type!=='milestone');
  assert.match(checkBundle(unlogged).reasons.join(),/dragonDead is not in the event log/);
  const fixtureRun=fixture();fixtureRun.manifest.kind='fixture';
  assert.match(checkBundle(fixtureRun).reasons.join(),/only evaluations/);
  const other=fixture();other.manifest.scenario={...scenario,id:'heldout-1'};
  assert.match(checkBundle(other).reasons.join(),/not on the Minecraft board/);
  const crashed=fixture();crashed.result.outcome='infrastructure_error';crashed.result.infrastructureError='disk full';
  assert.match(checkBundle(crashed).reasons.join(),/infrastructure error, so it does not count \(disk full\)/);
  assert.deepEqual(ok.segments.map(s=>s.label),['Dragon killed','Left the End']);
  const unknown=fixture();unknown.manifest.game='tetris';
  assert.match(checkBundle(unknown).reasons.join(),/game tetris is not on the community board/);
  const old=fixture();delete old.result.score;
  const rescored=checkBundle(old);
  assert.equal(rescored.rescored,true);assert.equal(rescored.score,0.375);
});

test('courses carry their game, and a paused twin ranks with its base course on the paused track', () => {
  const courses=listCourses();
  assert.ok(courses.every(c=>c.game==='minecraft'));
  assert.deepEqual(courses.find(c=>c.id==='speedrun-dragon-paused'),{game:'minecraft',id:'speedrun-dragon-paused',course:'speedrun-dragon',clock:'paused'});
  assert.equal(gameOf({}),'minecraft');
  const minecraft=getGame('minecraft');
  assert.match(minecraft.disclaimer,/NOT AN OFFICIAL MINECRAFT PRODUCT/);
  assert.ok(minecraft.files.includes('video.mp4')&&minecraft.files.includes('events.jsonl'));
  assert.throws(()=>getGame('constructor'),/unknown game/);
});

test('the Minecraft timeline is generic checkpoints, deaths and areas', () => {
  assert.deepEqual(getGame('minecraft').timeline(fixture().events),[
    {kind:'area',ms:1200,label:'The End'},{kind:'death',ms:150000,label:'Died'},{kind:'checkpoint',ms:300000,label:'Dragon killed'}]);
  const repeated=[...fixture().events,{seq:7,type:'dimension',elapsedMs:310000,data:{dimension:'the_end'}}];
  assert.equal(getGame('minecraft').timeline(repeated).filter(e=>e.kind==='area').length,1);
});

test('submit uploads every file in parts and the site receives exactly the staged bytes', async t => {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'bench-submit-'));
  t.after(()=>fs.rm(data,{recursive:true,force:true}));
  const {manifest,result,events}=fixture();
  const run=path.join(data,'runs',ID);await fs.mkdir(run,{recursive:true});
  await fs.writeFile(path.join(run,'manifest.json'),JSON.stringify(manifest));
  await fs.writeFile(path.join(run,'result.json'),JSON.stringify(result));
  await fs.writeFile(path.join(run,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const video=path.join(data,'run.mp4');await fs.writeFile(video,Buffer.alloc(2500,7));
  const received={};let declared,waitlisted=true;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.authorization!=='Bearer mbs_test')return send(401,{error:'bad token'});
    if(req.url==='/api/me')return send(200,{user:{termsAccepted:true,role:'member',waitlist:{status:waitlisted?'waiting':'admitted',place:waitlisted?7:null}},systems:[{slug:'my-agent'}]});
    if(req.method==='POST'&&req.url==='/api/runs'){declared=JSON.parse(body);return send(201,{id:'r_1',partSize:1000,url:'http://site/runs/r_1'});}
    const part=req.url.match(/^\/api\/runs\/r_1\/files\/([^/]+)\/parts\/(\d+)$/);
    if(part){const name=decodeURIComponent(part[1]);(received[name]??=[])[Number(part[2])-1]=body;return send(200,{partNumber:Number(part[2]),etag:`e${part[2]}`});}
    if(req.url==='/api/runs/r_1/complete')return send(200,{id:'r_1',status:'pending',score:0.375,reasons:[],url:'http://site/runs/r_1',parts:JSON.parse(body).parts});
    send(404,{error:'no route'});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  await assert.rejects(submitRun({runId:ID,system:'my-agent',video,site:`http://127.0.0.1:${server.address().port}`,token:'mbs_test',data,log:()=>{}}),/number 7 in line/);
  waitlisted=false;
  const done=await submitRun({runId:ID,system:'my-agent',video,withhold:true,site:`http://127.0.0.1:${server.address().port}`,token:'mbs_test',data,log:()=>{}});
  assert.equal(done.status,'pending');
  assert.deepEqual(declared.files.map(f=>f.name),['manifest.json','result.json','events.jsonl','video.mp4']);
  assert.equal(declared.withheld,true);
  assert.equal(declared.game,'minecraft');
  for(const f of declared.files){
    const bytes=Buffer.concat(received[f.name]);
    assert.equal(bytes.length,f.size,f.name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256,f.name);
  }
  assert.equal(received['video.mp4'].length,3);
  assert.equal(done.parts['video.mp4'].length,3);
  assert.ok(!Buffer.concat(received['events.jsonl']).toString().includes('private plan'));
});

test('a community agent log passes only when every action traces to a model response', async () => {
  const { checkCommunityBundle, withholdEvent: withhold }=await import('../community/bundle.mjs');
  const { agentLogTimeline }=await import('../community/agent-log.mjs');
  const t0=Date.parse('2026-10-22T18:00:00.000Z'),at=ms=>new Date(t0+ms).toISOString();
  const lines=[
    {type:'run_start',ms:0,data:{game:'tetris-gb',category:'any-percent',model:'provider/model',scaffold:{name:'my-agent'}}},
    {type:'model_request',ms:100,data:{messages:[{role:'user',content:'secret prompt'}]}},
    {type:'model_response',ms:2000,data:{id:'c1',model:'provider/model',text:'private reasoning',actions:[{name:'press',args:{button:'A'}}]}},
    {type:'action',ms:2010,data:{call:'c1',name:'press',args:{button:'A'}}},
    {type:'run_end',ms:60000,data:{reason:'goal reached'}},
  ];
  const log=ls=>ls.map((l,i)=>JSON.stringify({seq:i,at:at(l.at??l.ms),elapsedMs:l.ms,type:l.type,data:l.data})).join('\n')+'\n';
  const ok=checkCommunityBundle({game:'tetris-gb',category:'any-percent',logText:log(lines),videoSeconds:61});
  assert.deepEqual(ok.reasons,[]);
  assert.deepEqual({calls:ok.stats.modelCalls,actions:ok.stats.actions,ms:ok.stats.durationMs},{calls:1,actions:1,ms:60000});
  assert.deepEqual(agentLogTimeline(ok.events).map(e=>[e.kind,e.label]),[['model','private reasoning'],['action','press']]);
  assert.equal(agentLogTimeline(ok.events.map(withhold))[0].label,'Model call');
  const withheld=JSON.stringify(ok.events.map(withhold));
  assert.ok(!withheld.includes('secret prompt')&&!withheld.includes('private reasoning')&&withheld.includes('"button":"A"'));
  const human=lines.slice();human.splice(4,0,{type:'action',ms:3000,data:{call:'nobody',name:'press',args:{}}});
  assert.match(checkCommunityBundle({game:'tetris-gb',category:'any-percent',logText:log(human)}).reasons.join(),/does not name an earlier model_response/);
  const undisclosed=lines.map(l=>l.type==='run_start'?{...l,data:{...l.data,scaffold:{}}}:l);
  assert.match(checkCommunityBundle({game:'tetris-gb',category:'any-percent',logText:log(undisclosed)}).reasons.join(),/scaffold/);
  const forged=lines.map(l=>l.type==='action'?{...l,at:30000}:l);
  assert.match(checkCommunityBundle({game:'tetris-gb',category:'any-percent',logText:log(forged)}).reasons.join(),/disagrees with its time/);
  assert.match(checkCommunityBundle({game:'tetris-gb',category:'any-percent',logText:log(lines),videoSeconds:20}).reasons.join(),/the video is 20.0 s/);
  assert.match(checkCommunityBundle({game:'other',category:'any-percent',logText:log(lines)}).reasons.join(),/not other/);
});
