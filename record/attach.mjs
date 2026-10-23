// Network recorder for real in-game footage. Preload it into any runner:
//   node --import ./record/attach.mjs scripts/run-claude.mjs --scenario speedrun ...
// Every Mineflayer bot the process creates gets its traffic written to one stream file: each clientbound
// packet exactly as the client received it (decompressed bytes), each serverbound packet the bot sent (as
// JSON), and a few events. record/play.mjs later streams it into a real Minecraft client. The recorder only
// listens: it lives outside src/ so recorded and unrecorded runs share one protocol hash.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shared=createRequire(path.join(ROOT,'package.json'));
export const KIND={clientbound:0,serverbound:1,event:2};

if(isMainThread&&process.env.BENCH_RECORD!=='0'){
  const mineflayer=shared('mineflayer'),{Vec3}=shared('vec3');
  const base=process.env.BENCH_RECORD_DIR||path.join(ROOT,'data','recordings');
  const started=Date.now(),directory=path.join(base,`${new Date(started).toISOString().replace(/[:.]/g,'-')}-${process.pid}`);
  let fd=null,bots=0,pending=[];
  const now=()=>performance.timeOrigin+performance.now();
  const json=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);
  // Batched synchronous writes: nothing is lost when a runner exits without draining async streams.
  const flush=()=>{if(fd===null||!pending.length)return;const data=Buffer.concat(pending);pending=[];fs.writeSync(fd,data);};
  // Record: u8 kind, f64 epoch ms, u32 length, payload.
  const record=(kind,payload)=>{
    if(fd===null)return;
    const body=Buffer.isBuffer(payload)?Buffer.from(payload):Buffer.from(json(payload));
    const head=Buffer.allocUnsafe(13);head.writeUInt8(kind,0);head.writeDoubleLE(now(),1);head.writeUInt32LE(body.length,9);
    pending.push(head,body);
  };
  const open=()=>{
    if(fd!==null)return;
    fs.mkdirSync(directory,{recursive:true});
    fd=fs.openSync(path.join(directory,'stream.bin'),'a');
    setInterval(flush,250).unref();
    fs.writeFileSync(path.join(directory,'meta.json'),json({format:1,startedAt:new Date(started).toISOString(),argv:process.argv.slice(1),cwd:process.cwd(),pid:process.pid}));
  };
  const original=mineflayer.createBot;
  mineflayer.createBot=function(options={}){
    const bot=original.call(this,options);
    try{
      open();const index=bots++,client=bot._client;
      record(KIND.event,{type:'bot',index,username:options.username,version:options.version});
      client.on('raw',(buffer,meta)=>{if(meta.state==='play')record(KIND.clientbound,buffer);});
      const write=client.write.bind(client);
      client.write=(name,params)=>{
        if(client.state==='play'){
          record(KIND.serverbound,{name,params});
          // Dig progress is drawn client-side, so keep the dig time the bot expected for this block.
          if(name==='block_dig'&&params?.status===0){
            try{const {x,y,z}=params.location,block=bot.blockAt(new Vec3(x,y,z));record(KIND.event,{type:'dig',location:{x,y,z},block:block?.name,digTimeMs:block?bot.digTime(block):null});}catch{}
          }
        }
        return write(name,params);
      };
      bot.once('login',()=>record(KIND.event,{type:'login',index,entityId:bot.entity?.id,uuid:client.uuid}));
      bot.once('end',reason=>record(KIND.event,{type:'end',index,reason:String(reason??'')}));
    }catch(error){console.error('recorder: could not attach',error);}
    return bot;
  };
  // Name the run this recording belongs to: the newest run directory created after recording began.
  process.once('exit',()=>{
    if(fd===null)return;
    try{flush();fs.closeSync(fd);}catch{}
    try{
      const runs=path.join(ROOT,'data','runs');
      const run=fs.readdirSync(runs).map(id=>({id,t:fs.statSync(path.join(runs,id)).birthtimeMs})).filter(r=>r.t>=started-1000).sort((a,b)=>a.t-b.t).at(-1)?.id??null;
      const meta=JSON.parse(fs.readFileSync(path.join(directory,'meta.json'),'utf8'));
      fs.writeFileSync(path.join(directory,'meta.json'),json({...meta,run,endedAt:new Date().toISOString(),bots}));
    }catch{}
  });
  console.error(`recorder: writing ${directory}`);
}
