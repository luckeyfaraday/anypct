import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { PLAYER, sleep, errorText } from './util.mjs';
const { pathfinder, Movements, goals }=pf;
const pos=v=>[Number(v.x.toFixed(2)),Number(v.y.toFixed(2)),Number(v.z.toFixed(2))];
const vec=a=>new Vec3(...a);
const stack=i=>({name:i.name,count:i.count,slot:i.slot});
// Vanilla EnderDragonEntity part layout: [entity-id offset, forward, side, height above the dragon, size].
// The main dragon entity ignores melee; only parts take hits, and only the head takes full damage.
// Forward/side follow the server's yaw-only offsets; head/neck pitch is ignored.
const DRAGON_PARTS=[['head',1,6.5,0,0,1],['neck',2,5.5,0,0,3],['body',3,0.5,0,0,3],['tail',4,-3.5,0,0,2],['tail',5,-5.5,0,0,2],['tail',6,-7.5,0,0,2],['wing',7,0,4.5,2,2],['wing',8,0,-4.5,2,2]];
const DRAGON_STATES={0:'circling',1:'strafing',2:'approaching_perch',3:'landing',4:'taking_off',5:'perched_breathing',6:'perched_scanning',7:'perched_roaring',8:'charging',9:'dying',10:'hovering'};
export function dragonParts(dragon){
  // Mineflayer yaw is radians from north; vanilla's is degrees with sin(yaw) east-west.
  const yaw=Math.PI-dragon.yaw,s=Math.sin(yaw),c=Math.cos(yaw);
  return DRAGON_PARTS.map(([name,offset,forward,side,height,size])=>({name,id:dragon.id+offset,
    position:dragon.position.offset(s*forward+c*side,height+size/2,-c*forward+s*side)}));
}

export async function connectBot(port,{version,onEvent=()=>{}}={}) {
  const bot=mineflayer.createBot({host:'127.0.0.1',port,username:PLAYER,auth:'offline',version,respawn:false,hideErrors:true});
  // Mineflayer drops a full chunk with no block sections as if it were unloaded. In the End's void that
  // stopped client physics: a player who walked off the island hung in mid-air instead of falling, and the
  // next look never finished. Such columns are kept as loaded and empty. The listener is added once
  // Mineflayer's plugins are injected, so it runs after the plugin's own handler has dropped the column.
  let Chunk;
  bot.once('inject_allowed',()=>bot._client.on('map_chunk',packet=>{if(packet.bitMap||!packet.groundUp||bot.world.getColumn(packet.x,packet.z))return;
    Chunk??=createRequire(createRequire(import.meta.url).resolve('mineflayer'))('prismarine-chunk')(bot.registry);
    bot.world.setColumn(packet.x,packet.z,new Chunk({minY:bot.game.minY,worldHeight:bot.game.height}));}));
  bot.on('error',error=>onEvent('client_error',{message:error.message}));
  bot.on('kicked',reason=>onEvent('client_kicked',{reason:String(reason)}));
  const deadline=AbortSignal.timeout(60000);
  try{await once(bot,'spawn',{signal:deadline});await bot.waitForChunksToLoad();}catch(error){bot.quit();throw error;}
  bot.loadPlugin(pathfinder);
  const movement=new Movements(bot);
  movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;
  movement.allowSprinting=true;movement.scafoldingBlocks=[];movement.maxDropDown=3;
  bot.pathfinder.setMovements(movement);bot.pathfinder.searchRadius=64;bot.pathfinder.thinkTimeout=1000;bot.pathfinder.tickTimeout=10;
  return bot;
}
export class Controller {
  constructor(bot,{radius=24,clock=()=>performance.now(),onEvent=()=>{}}={}){this.bot=bot;this.radius=radius;this.clock=clock;this.lastSwing=-Infinity;this.events=[];this.discovered=new Map();
    const event=(type,data)=>{const e={type,...data};this.events.push(e);this.events=this.events.slice(-16);onEvent(type,data);};
    bot.on('death',()=>event('death',{}));bot.on('game',()=>event('dimension',{dimension:bot.game.dimension}));
    bot.on('entityHurt',entity=>{if(entity===bot.entity)event('hurt',{health:bot.health});});
    bot.on('end',reason=>event('client_end',{reason}));
    // Replay telemetry only (logged, never observed): block changes near the player let a
    // 3D replay rebuild the world at any moment from the run's final saved world.
    bot.on('blockUpdate',(before,after)=>{if(!before||!after||before.stateId===after.stateId||!bot.entity)return;const p=after.position;
      if(p.distanceTo(bot.entity.position)<=48)onEvent('block',{dimension:bot.game.dimension,position:[p.x,p.y,p.z],from:before.stateId,to:after.stateId});});
    bot._client.on('game_state_change',packet=>{if(packet.reason===4)event('client_exit_packet',{reason:packet.reason,gameMode:packet.gameMode});});
  }
  stop(){const b=this.bot;b.pathfinder.setGoal(null);b.clearControlStates();b.deactivateItem();if(b.targetDigBlock)b.stopDigging();}
  canSee(block){try{return this.bot.canSeeBlock(block);}catch{return false;}}
  block(position,{reach=true}={}){
    const p=vec(position).floored();const b=this.bot.blockAt(p);
    if(!b||b.name==='air')throw new Error('target_missing');
    if(p.distanceTo(this.bot.entity.position)> (reach?4.5:this.radius))throw new Error('out_of_reach');
    if(!this.canSee(b))throw new Error('target_not_visible');return b;
  }
  inventoryItem(name){const i=this.bot.inventory.items().find(i=>i.name===name);if(!i)throw new Error('missing_item');return i;}
  sees(target){const eye=this.bot.entity.position.offset(0,1.62,0),direction=target.minus(eye),distance=direction.norm();
    const hit=this.bot.world.raycast(eye,direction.scaled(1/(distance||1)),distance);return !(hit&&hit.intersect.distanceTo(eye)<distance-0.2);}
  entity(id){const e=this.bot.entities[id];if(!e||e===this.bot.entity)throw new Error('target_missing');
    if(e.position.distanceTo(this.bot.entity.position)>this.radius)throw new Error('target_not_visible');
    if(!this.sees(e.position.offset(0,(e.height||1)*0.5,0)))throw new Error('target_not_visible');return e;
  }
  // A player in the End sees the boss bar during the fight and the dragon itself at long
  // range in open sky, far beyond the 24-block observation radius for ordinary entities.
  dragon(){
    const b=this.bot;if(b.game.dimension!=='the_end')return undefined;
    const bar=b.bossBars.find(x=>(x.title?.translate??x.title)==='entity.minecraft.ender_dragon');
    const e=Object.values(b.entities).find(x=>x.name==='ender_dragon');
    const visible=!!e&&dragonParts(e).some(p=>this.sees(p.position));
    if(!bar&&!visible)return null;
    const view={health:bar?Math.round(bar.health*200):null,maxHealth:200,visible};
    if(!visible)return view;
    const head=dragonParts(e)[0].position;
    return {...view,id:e.id,state:DRAGON_STATES[e.metadata?.[15]]??'unknown',position:pos(e.position),distance:Number(e.position.distanceTo(b.entity.position).toFixed(1)),head:pos(head),headDistance:Number(head.distanceTo(b.entity.position.offset(0,1.62,0)).toFixed(1))};
  }
  observe(){
    const b=this.bot;if(!b.entity)return {connected:false};
    const points=b.findBlocks({matching:block=>block.boundingBox!=='empty'||/water|lava|portal/.test(block.name),maxDistance:this.radius,count:256});
    const blocks=[];
    for(const p of points){const block=b.blockAt(p);if(block&&this.canSee(block)){blocks.push({name:block.name,position:pos(p)});if(blocks.length>=96)break;}}
    // Include nearby useful blocks so a ground surface does not drown out a chest/tree.
    const useful=b.findBlocks({matching:block=>/log$|chest$|crafting_table|furnace|bed$|portal|obsidian|iron_ore|gold_ore/.test(block.name),maxDistance:this.radius,count:96});
    for(const p of useful){const block=b.blockAt(p);if(block&&this.canSee(block)&&!blocks.some(x=>x.position.join()===pos(p).join()))blocks.push({name:block.name,position:pos(p)});}
    for(const block of blocks)this.discovered.set(`${b.game.dimension}:${block.position.join()}`,{...block,dimension:b.game.dimension});
    while(this.discovered.size>1500)this.discovered.delete(this.discovered.keys().next().value);
    const entities=[];
    // Lingering clouds (dragon breath) report their current radius, which a player sees as the purple area.
    for(const e of Object.values(b.entities)){if(e===b.entity)continue;try{this.entity(e.id);const radius=e.name==='area_effect_cloud'?e.metadata?.[7]:undefined;
      entities.push({id:e.id,name:e.name||e.displayName||e.type,position:pos(e.position),distance:Number(e.position.distanceTo(b.entity.position).toFixed(1)),...(Number.isFinite(radius)?{radius:Number(radius.toFixed(1))}:{})});}catch{}}
    const window=b.currentWindow;
    return {connected:true,dimension:b.game.dimension,position:pos(b.entity.position),yaw:b.entity.yaw,pitch:b.entity.pitch,
      health:b.health,food:b.food,oxygen:b.oxygenLevel,alive:b.health>0,heldItem:b.heldItem?.name??null,
      inventory:b.inventory.items().map(stack),blocks,entities:entities.sort((a,c)=>a.distance-c.distance).slice(0,32),dragon:this.dragon(),
      container:window?{type:window.type,items:window.slots.slice(0,window.inventoryStart).filter(Boolean).map(stack)}:null,
      recentEvents:this.events,gameTicks:Number(b.time.age),knownBlocks:[...this.discovered.values()].filter(x=>/portal|chest|crafting_table|furnace/.test(x.name)).slice(-32)};
  }
  // A dimension change (falling into a portal mid-action) unloads the world an action was working in.
  // A dig in progress then never settles: its listener ignores the unload, and its stop is a no-op once
  // the dig timer has fired. The action ends here instead of hanging and faulting the controller.
  async execute(name,a,signal){
    const b=this.bot,from=b.game.dimension;let onGame;
    const changed=new Promise((_,reject)=>{onGame=()=>{if(b.game.dimension!==from)reject(new Error('dimension_changed'));};b.on('game',onGame);});
    try{return await Promise.race([this.perform(name,a,signal),changed]);}
    finally{b.removeListener('game',onGame);}
  }
  async perform(name,a,signal){
    const b=this.bot;const check=()=>{if(signal.aborted)throw new Error(String(signal.reason));};check();
    const equip=async item=>{await b.equip(this.inventoryItem(item),'hand');check();};
    if(b.health<=0&&name!=='respawn')throw new Error('player_dead');
    switch(name){
      case 'move_to': {
        if(b.currentWindow)b.closeWindow(b.currentWindow);
        const target=vec(a.position);b.pathfinder.setGoal(new goals.GoalNear(target.x,target.y,target.z,a.radius));
        const until=performance.now()+a.seconds*1000;
        while(performance.now()<until){check();if(b.entity.position.distanceTo(target)<=a.radius)return {reached:true,position:pos(b.entity.position)};await sleep(50);}
        return {reached:false,position:pos(b.entity.position),reason:'time_slice_complete'};
      }
      case 'move': {
        if(b.currentWindow)b.closeWindow(b.currentWindow);
        if(a.toward){const p=b.entity.position,t=vec(a.toward);await b.look(Math.atan2(-(t.x-p.x),-(t.z-p.z)),0,true);check();}
        const start=b.entity.position.clone();
        if(a.direction!=='none')b.setControlState(a.direction,true);
        for(const control of ['jump','sprint','sneak'])b.setControlState(control,a[control]);
        const until=performance.now()+a.seconds*1000;
        while(performance.now()<until){check();await sleep(Math.min(50,until-performance.now()));}
        b.clearControlStates();
        return {position:pos(b.entity.position),moved:Number(b.entity.position.distanceTo(start).toFixed(2)),onGround:b.entity.onGround};
      }
      case 'pillar': {
        // Jump, then place under the feet once they clear the top of the supporting block.
        // Momentum from earlier movement must settle first, or the jump drifts off the column.
        const ground=async()=>{const until=performance.now()+1500;while((!b.entity.onGround||Math.hypot(b.entity.velocity.x,b.entity.velocity.z)>0.01)&&performance.now()<until){check();await sleep(20);}};
        let placed=0,base;
        try{
          for(;placed<a.count;placed++){
            await ground();base??=Math.floor(b.entity.position.y+0.01);
            if(Math.floor(b.entity.position.y+0.01)!==base+placed)throw new Error('fell_off_pillar');
            const feet=b.entity.position.floored(),below=b.blockAt(feet.offset(0,-1,0)),head=b.blockAt(feet.offset(0,2,0));
            if(!b.entity.onGround||below?.boundingBox!=='block')throw new Error('no_support_below');
            if(head&&head.boundingBox!=='empty')throw new Error('no_headroom');
            // Aim before jumping and place with a forced look: Mineflayer rate-limits
            // turning, and an unforced turn can outlast the jump.
            await equip(a.item);await b.lookAt(below.position.offset(.5,1,.5),true);check();
            b.setControlState('jump',true);
            const until=performance.now()+1000;while(b.entity.position.y<feet.y+1&&performance.now()<until){check();await sleep(10);}
            b.setControlState('jump',false);if(b.entity.position.y<feet.y+1)throw new Error('jump_blocked');
            await b._placeBlockWithOptions(below,new Vec3(0,1,0),{forceLook:true,swingArm:'right'});check();
          }
          await ground();if(Math.floor(b.entity.position.y+0.01)!==base+placed)throw new Error('fell_off_pillar');
        }catch(error){if(!placed||signal.aborted)throw error;return {placed,stopped:errorText(error),position:pos(b.entity.position)};}
        return {placed,position:pos(b.entity.position)};
      }
      // Turns are instant (as a player's mouse): an unforced look waits on client physics and never settles if it stalls.
      case 'look_at':await b.lookAt(vec(a.position),true);return {};
      case 'mine':{const block=this.block(a.position);if(!b.canDigBlock(block))throw new Error('cannot_mine');await b.dig(block);return {block:block.name};}
      case 'place':{const reference=this.block(a.reference);await equip(a.item);const face={up:[0,1,0],down:[0,-1,0],north:[0,0,-1],south:[0,0,1],east:[1,0,0],west:[-1,0,0]}[a.face];await b.placeBlock(reference,vec(face));return {};}
      case 'craft':{const item=b.registry.itemsByName[a.item];if(!item)throw new Error('unknown_item');const table=a.table?this.block(a.table):null;if(table&&table.name!=='crafting_table')throw new Error('not_crafting_table');const recipes=b.recipesFor(item.id,null,a.count,table);if(!recipes.length)throw new Error('missing_materials_or_table');await b.craft(recipes[0],a.count,table);return {item:a.item,executions:a.count};}
      case 'open':{if(b.currentWindow)b.closeWindow(b.currentWindow);const window=await b.openContainer(this.block(a.position));check();return {items:window.containerItems().map(stack)};}
      case 'transfer':{const w=b.currentWindow;if(!w||typeof w[a.direction]!=='function')throw new Error('no_open_container');const item=b.registry.itemsByName[a.item];if(!item)throw new Error('unknown_item');await w[a.direction](item.id,null,a.count);return {};}
      case 'close':if(b.currentWindow)b.closeWindow(b.currentWindow);return {};
      case 'equip':await b.equip(this.inventoryItem(a.item),a.destination);return {};
      case 'eat':await equip(a.item);await b.consume();return {};
      case 'use':{
        if(a.item)await equip(a.item);
        if(a.position)await b.activateBlock(this.block(a.position));
        else if(a.entity!==undefined){const e=this.entity(a.entity);if(e.position.distanceTo(b.entity.position)>4.5)throw new Error('out_of_reach');await b.activateEntity(e);}
        else{const eye=b.heldItem?.name==='ender_eye'?this.watchEye():null;
          b.activateItem();const until=performance.now()+a.seconds*1000;while(performance.now()<until&&!eye?.done()){check();await sleep(50);}b.deactivateItem();
          if(eye)return {eye:eye.result()};}
        return {};
      }
      case 'attack':{const until=performance.now()+a.seconds*1000;const hits=[];
        // A perched dragon's centre can hide behind the fountain while its head is in view; parts are checked below.
        while(performance.now()<until){check();const raw=b.entities[a.entity],e=raw?.name==='ender_dragon'?raw:this.entity(a.entity);let target=e,point=e.position.offset(0,(e.height||1)*0.5,0);
          // Swing at the nearest visible dragon part, as a player aims at the part in front of them.
          if(e.name==='ender_dragon'){const eye=b.entity.position.offset(0,1.62,0),part=dragonParts(e).filter(p=>this.sees(p.position)).sort((x,y)=>x.position.distanceTo(eye)-y.position.distanceTo(eye))[0];
            if(!part||part.position.distanceTo(eye)>5)throw new Error('out_of_reach');target={id:part.id};point=part.position;hits.push(part.name);}
          else if(e.position.distanceTo(b.entity.position)>4)throw new Error('out_of_reach');
          // Swings are spaced by course time, across calls too: on the paused clock a frozen pause between two
          // short attack calls must not recharge the attack, as a player cannot swing faster than the cooldown.
          const ready=this.lastSwing+650-this.clock();if(ready>0){if(performance.now()+ready>until){await sleep(Math.max(0,until-performance.now()));break;}await sleep(ready);check();}
          await b.lookAt(point,true);check();b.attack(target);this.lastSwing=this.clock();await sleep(Math.max(1,Math.min(650,until-performance.now())));}
        return hits.length?{dragonParts:hits}:{};}
      case 'smelt':{const block=this.block(a.position);if(!/furnace/.test(block.name))throw new Error('not_furnace');const furnace=await b.openFurnace(block);try{check();if(a.input){const i=this.inventoryItem(a.input);await furnace.putInput(i.type,null,a.count);check();}if(a.fuel){const i=this.inventoryItem(a.fuel);await furnace.putFuel(i.type,null,Math.min(a.count,i.count));check();}if(a.collect&&furnace.outputItem())await furnace.takeOutput();return {progress:furnace.progress,output:furnace.outputItem()?.name??null};}finally{furnace.close();}}
      case 'respawn':if(b.health>0)throw new Error('player_alive');b.respawn();return {};
      default:throw new Error('unknown_action');
    }
  }
  // A thrown eye of ender flies about four seconds toward the nearest stronghold, then drops or shatters.
  // A player watches it; the call reports its path while it lasts (use `seconds` up to 5).
  watchEye(){
    const b=this.bot,path=[];let eye=null,gone=false,endedAt=null;
    const onSpawn=e=>{if(!eye&&e.name==='eye_of_ender'&&e.position.distanceTo(b.entity.position)<4){eye=e;path.push(pos(e.position));}};
    const onMove=e=>{if(e===eye)path.push(pos(e.position));};
    const onGone=e=>{if(e===eye){gone=true;endedAt=path.at(-1);}};
    b.on('entitySpawn',onSpawn);b.on('entityMoved',onMove);b.on('entityGone',onGone);
    return {done:()=>gone,result:()=>{
      b.removeListener('entitySpawn',onSpawn);b.removeListener('entityMoved',onMove);b.removeListener('entityGone',onGone);
      if(!eye)return {seen:false};
      const from=path[0],last=endedAt??path.at(-1),dx=last[0]-from[0],dz=last[2]-from[2],d=Math.hypot(dx,dz);
      return {seen:true,from,last,horizontalBlocks:Number(d.toFixed(1)),heading:d>0.5?[Number((dx/d).toFixed(3)),Number((dz/d).toFixed(3))]:null,ended:gone};}};
  }
  recipes(name){const b=this.bot,item=b.registry.itemsByName[name];if(!item)return {ok:false,error:'unknown_item'};
    const describe=i=>({item:b.registry.items[i.id]?.name??i.id,count:i.count,metadata:i.metadata});
    return {ok:true,item:name,recipes:b.recipesAll(item.id,null,true).slice(0,16).map(r=>({requiresTable:r.requiresTable,result:describe(r.result),ingredients:r.delta.filter(i=>i.count<0).map(i=>({...describe(i),count:-i.count}))}))};
  }
}
