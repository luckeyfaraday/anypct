const $=id=>document.getElementById(id);
let runs=[],selected=null,frames=[],index=0,filter='evaluation',playing=false,live=false,polling=false;
const seconds=ms=>{const s=Math.floor((ms||0)/1000);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const text=(el,value)=>{el.textContent=String(value);};
function node(tag,cls,value){const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)text(e,value);return e;}
function renderList(){
  const visible=runs.filter(r=>filter==='evaluation'?r.manifest.kind==='evaluation':r.manifest.kind!=='evaluation');
  $('run-list').replaceChildren();$('empty-list').hidden=visible.length>0;text($('run-count'),visible.length);
  for(const r of visible){const b=node('button',`run-card${selected?.id===r.id?' selected':''}`);b.append(node('b','',r.manifest.model));b.append(node('small','',`${r.manifest.scenario.id} · ${r.result?.outcome??r.status?.status??'starting'}`));b.append(node('small','',new Date(r.manifest.createdAt).toLocaleTimeString()));b.onclick=()=>selectRun(r.id);$('run-list').append(b);}
}
async function selectRun(id){selected=runs.find(r=>r.id===id);playing=false;live=false;$('live-view').hidden=true;renderList();await loadFrames(true);renderSelected();}
async function loadFrames(reset=false){if(!selected)return;const id=selected.id;const response=await fetch(`/api/runs/${encodeURIComponent(id)}/frames`);if(!response.ok)throw new Error('Cannot read replay');const next=await response.json();if(selected?.id!==id)return;const atEnd=index>=frames.length-1;frames=next;index=reset||(!playing&&atEnd)?Math.max(0,frames.length-1):Math.min(index,frames.length-1);renderFrame();}
function renderSelected(){if(!selected)return;const r=selected,result=r.result;
  text($('selected-title'),r.manifest.model);text($('selected-meta'),`${r.manifest.scenario.id} / ${r.manifest.scenario.category}`);
  text($('run-status'),(result?.outcome??r.status?.status??'ready').replaceAll('_',' ').toUpperCase());$('run-status').classList.toggle('fixture',r.manifest.kind!=='evaluation');
  $('evidence-empty').hidden=!!result;$('checks').replaceChildren();
  const labels={persistentDragonKill:'Dragon kill saved by server',playerSawCredits:'Player reached end credits',survivalPlayer:'Player remained in Survival',completedInTime:'Completed before deadline',eventOrdering:'Dragon death preceded exit'};
  if(result)for(const [key,label] of Object.entries(labels)){const d=node('div',`check ${result.checks[key]?'pass':'fail'}`);d.append(node('i','',result.checks[key]?'✓':'○'),node('span','',label));$('checks').append(d);}
  const metrics=result?.metrics??r.status?.metrics??{};text($('calls'),metrics.modelCalls??'—');text($('inference'),metrics.inferenceMs!==undefined?`${(metrics.inferenceMs/1000).toFixed(1)}s`:'—');text($('cost'),metrics.costUsd!=null?`$${metrics.costUsd.toFixed(4)}`:'Not reported');
  renderRoute(r);renderScore(r);
  $('events-link').hidden=false;$('events-link').href=`/api/runs/${encodeURIComponent(r.id)}/events`;
  $('result-link').hidden=!result;$('result-link').href=`/api/runs/${encodeURIComponent(r.id)}/result`;
  $('live').disabled=!r.status?.viewerUrl||r.status?.status!=='running';
  // Finished runs open in the separate 3D replay server (npm run replay, port 8124) on the same host.
  const replay3d=$('replay3d');replay3d.hidden=!r.result;replay3d.href=`${location.protocol}//${location.hostname}:8124/?run=${encodeURIComponent(r.id)}`;
}
const routeLabels={wood:'Log in inventory',craftingTable:'Crafting table',pickaxe:'Pickaxe',enteredEnd:'Entered the End',endSafe:'Alive in the End for 5 s',goal:'Course goal reached',blazeRod:'Blaze rod',dragonDamaged:'Dragon damaged',dragonHalf:'Dragon at half health',dragonDead:'Dragon killed',exitEnd:'Left through the exit portal'};
function renderScore(r){const s=r.result?.score,res=r.result;$('score').replaceChildren();if(!s){$('score').append(node('span','muted','No score yet'));return;}
  $('score').append(node('div','score-value',`${s.value.toFixed(2)}${s.rescored?' · rescored':''}`));
  for(const g of s.segments){const label=routeLabels[g.checkpoint]??g.checkpoint.replace(/^landmark(\d+)$/,(_,i)=>`Reached: ${r.manifest.scenario.landmarks?.[Number(i)]?.name??g.checkpoint}`);const d=node('div',`check ${g.reachedMs!==null?'pass':'fail'}`);d.append(node('i','',g.reachedMs!==null?'✓':'○'),node('span','',`${label} · ${g.reachedMs!==null?seconds(g.reachedMs):`${Math.round((g.partial??0)*100)}% partial`} · ${g.credit.toFixed(2)}`));$('score').append(d);}
  const extra=[res.clock?.kind==='paused'?`Paused clock: ${seconds(res.clock.courseMs)} game / ${seconds(res.clock.wallMs)} wall`:null,Number.isFinite(res.crystalsDestroyed)?`End crystals destroyed: ${res.crystalsDestroyed}`:null,Number.isFinite(res.endSeconds)?`Alive in the End: ${Math.round(res.endSeconds)} s`:null,`Deaths: ${res.deaths??0}`].filter(Boolean);
  for(const line of extra)$('score').append(node('small','muted',line));}
function renderRoute(r){const route=r.result?.progress?.route??r.status?.route,milestones=r.result?.milestones??r.status?.milestones??{};$('route').replaceChildren();
  if(!route?.length){$('route').append(node('span','muted','Recorded before route checkpoints existed'));return;}
  for(const name of route){const m=milestones[name],landmark=name.match(/^landmark(\d+)$/),label=landmark?`Reached: ${r.manifest.scenario.landmarks?.[Number(landmark[1])]?.name??name}`:routeLabels[name]??name;
    const d=node('div',`check ${m?'pass':'fail'}`);d.append(node('i','',m?'✓':'○'),node('span','',m?`${label} · ${seconds(m.wallMs)}`:label));$('route').append(d);}
}
function renderFrame(){const f=frames[index];$('canvas-empty').hidden=!!f;$('play').disabled=!frames.length;$('scrub').disabled=!frames.length;$('scrub').max=Math.max(0,frames.length-1);$('scrub').value=Math.max(0,index);text($('time'),`${seconds(f?.elapsedMs)} / ${seconds(frames.at(-1)?.elapsedMs)}`);text($('play'),playing?'Ⅱ':'▶');
  text($('health'),f?`${f.health} / 20`:'—');text($('dimension'),f?.dimension?.replaceAll('_',' ')??'—');text($('position'),f?.position?.map(v=>Math.round(v)).join(', ')??'—');text($('action'),f?.actions?.active?.name??f?.actions?.last?.name??'—');
  $('inventory').replaceChildren();if(f?.inventory?.length)for(const item of f.inventory)$('inventory').append(node('span','item',`${item.name.replaceAll('_',' ')} ×${item.count}`));else $('inventory').append(node('span','muted','Empty inventory'));draw();
}
function draw(){const canvas=$('map'),rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height;ctx.fillStyle='#111a12';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#243120';ctx.lineWidth=.6;
  for(let x=0;x<w;x+=28){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=28){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  const f=frames[index];if(!f)return;const points=frames.slice(0,index+1).filter(p=>p.dimension===f.dimension&&p.position),p=f.position;
  const extent=Math.max(32,...points.flatMap(x=>[Math.abs(x.position[0]-p[0]),Math.abs(x.position[2]-p[2])]));const scale=Math.min(w,h)*.4/extent;
  const xy=v=>[w/2+(v[0]-p[0])*scale,h/2+(v[2]-p[2])*scale];
  for(const b of f.blocks??[]){const [x,y]=xy(b.position);ctx.fillStyle=/lava/.test(b.name)?'#bc6538':/water/.test(b.name)?'#325c6b':/portal/.test(b.name)?'#a881c8':/log|leaves/.test(b.name)?'#4d6637':'#33452c';ctx.fillRect(x,y,Math.max(2,scale),Math.max(2,scale));}
  ctx.strokeStyle='#c5f58a';ctx.lineWidth=2;ctx.beginPath();points.forEach((v,i)=>{const [x,y]=xy(v.position);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
  for(const e of f.entities??[]){const [x,y]=xy(e.position);ctx.fillStyle='#edca76';ctx.fillRect(x-2,y-2,4,4);}
  ctx.fillStyle='#c5f58a';ctx.beginPath();ctx.arc(w/2,h/2,5,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#c5f58a50';ctx.beginPath();ctx.arc(w/2,h/2,13,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#93a18d';ctx.font='10px monospace';ctx.fillText(`N ↑     ${Math.round(extent*2)} BLOCK SPAN`,16,h-16);
}
// Score v2 mean with its range; the t-interval is in the tooltip.
function scoreCell(s){const td=node('td','',s?s.mean.toFixed(2):'—');if(s){td.append(node('small','',s.n>1?`${s.min.toFixed(2)}–${s.max.toFixed(2)} · n=${s.n}`:`n=1`));if(s.ci95)td.title=`95% interval ${s.ci95.map(x=>x.toFixed(2)).join('–')}`;}return td;}
function renderLeaderboard(rows){$('leaderboard').replaceChildren();$('empty-board').hidden=rows.length>0;for(const r of rows){const tr=node('tr');const name=node('td','',r.model);name.append(node('small','',`${r.scenario} · ${Math.round(r.durationMs/1000)}s cap`));tr.append(name,node('td','',`${r.validAttempts}${r.infrastructureErrors?` (+${r.infrastructureErrors} infra)`:''}`),node('td','win-value',r.successRate===null?'—':`${Math.round(r.successRate*100)}%`),node('td','',r.validAttempts?r.confidence95.map(x=>`${Math.round(x*100)}%`).join('–'):'—'),scoreCell(r.score),node('td','',r.meanProgress==null?'—':`${Math.round(r.meanProgress*100)}%`),node('td','',r.medianCompletionMs===null?'—':seconds(r.medianCompletionMs)),node('td','',r.totalCostUsd===null?'Not reported':`$${r.totalCostUsd.toFixed(3)}`));$('leaderboard').append(tr);}}
async function refresh(){if(polling)return;polling=true;try{const response=await fetch('/api/runs');if(!response.ok)throw new Error('Harness unavailable');const data=await response.json();runs=data.runs;
  const evaluations=runs.filter(r=>r.result?.eligible);text($('attempts'),evaluations.length);text($('wins'),evaluations.filter(r=>r.result.success).length);text($('models'),new Set(evaluations.map(r=>r.manifest.model)).size);text($('courses'),new Set(evaluations.map(r=>r.manifest.scenario.id)).size);
  if(selected)selected=runs.find(r=>r.id===selected.id)??selected;renderList();renderLeaderboard(data.leaderboard);renderSelected();if(selected)await loadFrames();text($('connection'),'● Connected to local harness · updates every 2 seconds');
}catch(error){text($('connection'),`○ ${error.message} · retrying`);}finally{polling=false;}}
$('scrub').oninput=()=>{index=Number($('scrub').value);playing=false;live=false;$('live-view').hidden=true;renderFrame();};
$('play').onclick=()=>{if(index>=frames.length-1)index=0;playing=!playing;live=false;$('live-view').hidden=true;renderFrame();};
// Opened from another device (e.g. over Tailscale serve): reach the viewer's port on the same host.
const viewerSrc=url=>{const u=new URL(url);if(!['127.0.0.1','localhost'].includes(location.hostname)){u.protocol=location.protocol;u.hostname=location.hostname;}return u.href;};
$('live').onclick=()=>{if(!selected?.status?.viewerUrl)return;live=!live;const iframe=$('live-view'),src=viewerSrc(selected.status.viewerUrl);if(live&&iframe.src!==src)iframe.src=src;iframe.hidden=!live;text($('view-label'),live?'LIVE MINECRAFT OBSERVER · READ ONLY':'TELEMETRY REPLAY · NOT GAMEPLAY VIDEO');};
for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{filter=button.dataset.filter;for(const b of document.querySelectorAll('[data-filter]'))b.classList.toggle('active',b===button);renderList();};
window.addEventListener('resize',draw);setInterval(()=>{if(playing){index++;if(index>=frames.length-1){index=frames.length-1;playing=false;}renderFrame();}},500);setInterval(refresh,2000);draw();await refresh();
const params=new URLSearchParams(location.search);if(params.get('run')&&runs.some(r=>r.id===params.get('run'))){const target=runs.find(r=>r.id===params.get('run'));filter=target.manifest.kind==='evaluation'?'evaluation':'fixture';for(const b of document.querySelectorAll('[data-filter]'))b.classList.toggle('active',b.dataset.filter===filter);await selectRun(target.id);if(params.get('live')==='1'&&!$('live').disabled)$('live').click();}
// A small view adapter lets the existing vibe verifier exercise real UI behavior.
window.vibe={ready:true,step:async()=>{},observe:()=>({runs:runs.length,selected:selected?.id,frames:frames.length,index,filter,playing}),act:async command=>{if(command.select)await selectRun(command.select);if(command.filter){filter=command.filter;renderList();}},view:async()=>{},watch:()=>({kinds:{}})};
