import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionManager, schemas } from '../src/actions.mjs';
import { grade, scoreValue } from '../src/referee.mjs';
import { authorized } from '../src/agent-api.mjs';
import { summarize, wilson } from '../src/report.mjs';
import { buildRequest } from '../src/models.mjs';
import { sleep, safeId, loadScenario } from '../src/util.mjs';

const winning={evidence:{dragonKilled:true,seenCredits:true,gameType:0},observed:{dragonSeen:100,dragonDead:10000,exitEnd:11000},last:{dragonDeadTick:200,exitEnd:220,deaths:0},durationMs:600000,elapsedMs:12000};
test('victory requires independent persistent and ordered in-window evidence',()=>{
  assert.equal(grade(winning).success,true);
  for(const change of [{evidence:{dragonKilled:true,seenCredits:false,gameType:0}},{evidence:{dragonKilled:false,seenCredits:true,gameType:0}},{evidence:{dragonKilled:true,seenCredits:true,gameType:1}},{observed:{dragonSeen:1,dragonDead:500,exitEnd:600001}},{last:{dragonDeadTick:200,exitEnd:100}},{infrastructureError:'server died'}])assert.equal(grade({...winning,...change}).success,false);
});
test('privileged victory fixtures are permanently excluded from evaluation scores',()=>{const result=grade({...winning,kind:'fixture'});assert.equal(result.success,false);assert.equal(result.verifiedGameplay,true);assert.equal(result.eligible,false);assert.equal(summarize([{...result,model:'test',scenario:'sprint'}]).length,0);});
test('timeouts remain in success-rate denominator; infrastructure errors are visible',()=>{
  const base={eligible:true,model:'m',scenario:'s',durationMs:600000,metrics:{costUsd:null}};
  const [result]=summarize([{...base,success:true,outcome:'success',completionMs:100},{...base,success:false,outcome:'timeout'},{...base,success:false,outcome:'infrastructure_error'}]);
  assert.equal(result.successRate,.5);assert.equal(result.attempts,3);assert.equal(result.infrastructureErrors,1);assert.equal(result.totalCostUsd,null);assert.ok(result.confidence95[0]<.5&&result.confidence95[1]>.5);
});
test('different protocols and deadlines are not pooled',()=>{const base={eligible:true,model:'m',scenario:'s',outcome:'timeout',success:false};assert.equal(summarize([{...base,durationMs:10,protocolHash:'a'},{...base,durationMs:10,protocolHash:'b'},{...base,durationMs:20,protocolHash:'a'}]).length,3);});
test('schema rejects invalid and privileged actions',()=>{assert.equal(schemas.move_to.safeParse({position:[0,70,0],seconds:999}).success,false);assert.equal(schemas.mine.safeParse({position:[0,70,0],command:'/give'}).success,false);assert.equal(schemas.execute,undefined);assert.equal(schemas.move.safeParse({seconds:6}).success,false);assert.equal(schemas.move.safeParse({direction:'up'}).success,false);assert.equal(schemas.move.parse({}).direction,'forward');assert.equal(schemas.pillar.safeParse({item:'dirt',count:9}).success,false);assert.equal(schemas.mine.safeParse({position:[0,300,0]}).success,false);assert.equal(schemas.mine.safeParse({position:[0,70]}).success,false);assert.equal(schemas.mine.safeParse({position:[0.5,70,-3]}).success,true);assert.throws(()=>safeId('../server'));assert.equal(scoreValue('BenchAgent has 123 [mb_exit]'),123);});
test('cancellation settles before another action can start',async()=>{
  let executing=0,maxExecuting=0,stops=0;
  const manager=new ActionManager({stop:()=>stops++,execute:async(name,args,signal)=>{executing++;maxExecuting=Math.max(maxExecuting,executing);try{while(!signal.aborted)await sleep(5);}finally{executing--;}}});
  assert.equal(manager.start('mine',{position:[0,70,0]}).ok,true);await sleep(10);
  assert.equal(manager.start('mine',{position:[1,70,0]}).error,'busy');await manager.cancel();assert.equal(manager.last.ok,false);assert.equal(executing,0);assert.ok(stops>0);
  manager.start('mine',{position:[1,70,0]});await sleep(5);await manager.shutdown();assert.equal(maxExecuting,1);assert.equal(manager.start('mine',{position:[1,70,0]}).error,'run_finished');
});
test('a dimension change ends a native action that would never settle, without a controller fault',async()=>{
  const {Controller}=await import('../src/controller.mjs');const {EventEmitter}=await import('node:events');
  const bot=Object.assign(new EventEmitter(),{_client:new EventEmitter(),game:{dimension:'overworld'}});
  const controller=new Controller(bot);const listeners=bot.listenerCount('game');
  controller.perform=()=>new Promise(()=>{}); // a dig whose world was unloaded under it
  const manager=new ActionManager({execute:(...a)=>controller.execute(...a),stop:()=>{},maxSeconds:1});
  manager.start('mine',{position:[1007,27,1152]});await sleep(10);
  bot.emit('game');await sleep(10);assert.ok(manager.active,'a game event without a dimension change (e.g. gamemode) keeps the action');
  bot.game.dimension='the_end';bot.emit('game');await manager.active?.done;
  assert.equal(manager.last.error,'dimension_changed');assert.equal(manager.poisoned,false);assert.equal(bot.listenerCount('game'),listeners);
});
test('an expired deadline cannot dispatch an action',()=>{let count=0;const manager=new ActionManager({execute:()=>count++,stop:()=>{},clock:()=>100,deadline:100});assert.equal(manager.start('mine',{position:[0,70,0]}).error,'run_finished');assert.equal(count,0);});
test('token authentication does not accept prefixes or wrong values',()=>{assert.ok(authorized('Bearer abc','abc'));for(const value of ['',undefined,'Bearer ab','Bearer abcd','abc'])assert.equal(authorized(value,'abc'),false);});
test('provider options cannot replace the shared controller contract',()=>{assert.throws(()=>buildRequest({model:'m',messages:[],tools:[],maxTokens:1,options:{tools:[]}}));assert.equal(buildRequest({model:'m',messages:[],tools:[],maxTokens:1,options:{temperature:0}}).temperature,0);});
test('seed stays a string to avoid 64-bit rounding',async()=>{const s=await loadScenario('sprint');assert.equal(s.seed,'8398967436125155523');const p=await loadScenario('progression');assert.equal(p.difficulty,'normal');assert.deepEqual(p.landmarks,[]);});
test('an unreadable scoreboard is an infrastructure error, not a zero score',()=>{assert.throws(()=>scoreValue('Unknown scoreboard objective mb_clock'));});
test('Wilson interval handles no samples and all failures',()=>{assert.deepEqual(wilson(0,0),[0,1]);assert.ok(wilson(0,5)[1]>.4);});
test('route progress counts only in-window server checkpoints and never implies success',async()=>{
  const {ladder}=await import('../src/referee.mjs');
  const route=ladder({landmarks:[{name:'portal',dimension:'overworld',position:[0,30,0]}]});
  assert.ok(route.includes('landmark0')&&route.at(-1)==='exitEnd');
  const milestones={wood:{wallMs:1000},craftingTable:{wallMs:2000},landmark0:{wallMs:700000}};
  const result=grade({evidence:null,observed:{},last:{},durationMs:600000,elapsedMs:600000,milestones,route});
  assert.deepEqual(result.progress.reached,['wood','craftingTable']);assert.equal(result.progress.score,2/route.length);assert.equal(result.success,false);assert.equal(result.dragonHealthMin,null);
  const base={eligible:true,model:'m',scenario:'s',durationMs:600000,success:false,outcome:'timeout',metrics:{costUsd:null}};
  const [row]=summarize([{...base,progress:{score:.2}},{...base,progress:{score:.4}},{...base}]);
  assert.ok(Math.abs(row.meanProgress-.3)<1e-9);assert.equal(row.bestProgress,.4);assert.equal(row.progressAttempts,2);assert.equal(row.validAttempts,3);
});
test('referee reads server entity data and tolerates a missing player',async()=>{
  const {entityData}=await import('../src/referee.mjs');
  assert.deepEqual(entityData('BenchAgent has the following entity data: [-557.7d, 57.08d, 469.7d]'),[-557.7,57.08,469.7]);
  assert.equal(entityData('BenchAgent has the following entity data: "minecraft:overworld"'),'minecraft:overworld');
  assert.equal(entityData('No entity was found'),null);
});
test('referee datapack declares every checkpoint objective within the 1.16 name limit',async()=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {installRefereePack}=await import('../src/datapack.mjs');
  const world=await fs.mkdtemp(path.join(os.tmpdir(),'bench-pack-'));
  try{
    await installRefereePack(world,{minecraft:'1.16.1',landmarks:[{name:'portal',dimension:'overworld',position:[1008,24,1151]}]});
    const base=path.join(world,'datapacks','minecraft_bench');
    assert.equal(JSON.parse(await fs.readFile(path.join(base,'pack.mcmeta'),'utf8')).pack.pack_format,5);
    const load=await fs.readFile(path.join(base,'data/bench/functions/load.mcfunction'),'utf8');
    for(const name of load.match(/objectives add (\S+)/g).map(s=>s.split(' ')[2]))assert.ok(name.length<=16,name);
    assert.match(load,/mb_lm0/);
    assert.match(await fs.readFile(path.join(base,'data/bench/functions/tick.mcfunction'),'utf8'),/x=992,y=0,z=1135,dx=32,dy=255,dz=32/);
    const wood=JSON.parse(await fs.readFile(path.join(base,'data/bench/advancements/item_wood.json'),'utf8'));
    assert.deepEqual(wood.criteria.c0.conditions.items,[{tag:'minecraft:logs'}]);
    // A failed dragon health read must not be stored as 0.
    assert.match(await fs.readFile(path.join(base,'data/bench/functions/tick.mcfunction'),'utf8'),/store success score #hp_ok mb_dragon store result score #hp_read/);
  }finally{await fs.rm(world,{recursive:true,force:true});}
});
test('dragon part layout follows vanilla offsets and entity ids',async()=>{
  const {dragonParts}=await import('../src/controller.mjs');const {Vec3}=await import('vec3');
  // Mineflayer yaw PI is vanilla yaw 0, whose head offset is (sin 0, -cos 0) * 6.5: toward -z.
  const parts=dragonParts({id:100,yaw:Math.PI,position:new Vec3(0,64,0)}),byName=n=>parts.filter(p=>p.name===n);
  assert.deepEqual(parts.map(p=>p.id),[101,102,103,104,105,106,107,108]);
  const head=byName('head')[0].position;assert.ok(Math.abs(head.x)<1e-9&&Math.abs(head.z+6.5)<1e-9,String(head));
  const [right,left]=byName('wing').map(p=>p.position);assert.ok(Math.abs(right.x-4.5)<1e-9&&Math.abs(left.x+4.5)<1e-9&&right.y===67);
  for(const tail of byName('tail'))assert.ok(tail.position.z>0,'tail trails behind the head');
});
