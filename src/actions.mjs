import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { errorText, sleep } from './util.mjs';

// A plain 3-number array rather than a tuple: some MCP clients (Codex) reject tuple-form JSON Schema `items`.
const position=z.array(z.number().finite().min(-30000000).max(30000000)).length(3).refine(p=>p[1]>=0&&p[1]<=255,{message:'y must be between 0 and 255'}).describe('World coordinates [x, y, z]; y from 0 to 255.');
const item=z.string().regex(/^[a-z0-9_]+$/).max(80);
const count=z.number().int().min(1).max(64);
export const schemas={
  observe:z.object({}).strict(),
  move_to:z.object({position,radius:z.number().min(0.5).max(4).default(1),seconds:z.number().min(0.1).max(10).default(10)}).strict(),
  move:z.object({toward:position.optional(),direction:z.enum(['forward','back','left','right','none']).default('forward'),jump:z.boolean().default(false),sprint:z.boolean().default(false),sneak:z.boolean().default(false),seconds:z.number().min(0.05).max(5).default(0.5)}).strict(),
  pillar:z.object({item,count:z.number().int().min(1).max(8).default(1)}).strict(),
  look_at:z.object({position}).strict(),
  mine:z.object({position}).strict(),
  place:z.object({item,reference:position,face:z.enum(['up','down','north','south','east','west'])}).strict(),
  craft:z.object({item,count:count.default(1),table:position.optional()}).strict(),
  recipes:z.object({item}).strict(),
  open:z.object({position}).strict(),
  transfer:z.object({direction:z.enum(['withdraw','deposit']),item,count}).strict(),
  close:z.object({}).strict(),
  equip:z.object({item,destination:z.enum(['hand','head','torso','legs','feet','off-hand']).default('hand')}).strict(),
  use:z.object({item:item.optional(),position:position.optional(),entity:z.number().int().optional(),seconds:z.number().min(0.1).max(5).default(0.5)}).strict(),
  eat:z.object({item}).strict(),
  attack:z.object({entity:z.number().int(),seconds:z.number().min(0.1).max(3).default(1)}).strict(),
  smelt:z.object({position,input:item.optional(),fuel:item.optional(),count:count.default(1),collect:z.boolean().default(false)}).strict(),
  respawn:z.object({}).strict(),
  wait:z.object({seconds:z.number().min(0.05).max(10).default(2)}).strict(),
  cancel:z.object({}).strict()
};
export const descriptions={
  observe:'Get local structured observations, inventory, visible entities, and current action status. In the End, `dragon` reports boss-bar health and, while in line of sight at any range, the dragon\'s position, head position, and behaviour.',
  move_to:'Walk toward a destination for at most ten seconds. Pathfinding does not mine or place blocks. Return immediately with an action ID; observe/wait for progress.',
  move:'Hold movement keys like a player for a short time, without pathfinding: optionally turn horizontally toward a position first, then walk forward/back/left/right (or none) with optional jump, sprint, or sneak. Walking off a ledge falls, with normal fall damage; sneaking stops at edges.',
  pillar:'Jump and place the named block under your feet, repeated count times, to build straight up. Needs solid ground and two blocks of headroom; stops at the first failure.',
  look_at:'Turn to a world position.', mine:'Mine one visible block within reach, using currently equipped tool.',
  place:'Place an inventory item against an existing visible reference block face. Face is an absolute world direction.',
  craft:'Craft an item from available materials. count is recipe executions, not output items. Supply a nearby crafting table for 3x3 recipes.',
  recipes:'List recipes and ingredients for an item; this does not acquire or craft anything.',
  open:'Open a nearby chest or other container and inspect its contents.',
  transfer:'Move items between the currently open container and inventory.', close:'Close the current container.',
  equip:'Equip an existing inventory item.',
  use:'Use a held item or interact with a visible block/entity. With no target, hold use for the specified seconds (e.g. draw/release a bow). Throwing a held eye of ender reports where it flew while the call lasts (up to 5 seconds).',
  eat:'Consume a named food item from inventory.',
  attack:'Attack a named visible entity within melee reach for up to three seconds. Does not chase, choose equipment, or heal. Against the Ender Dragon each swing hits its nearest visible body part within reach; only the head takes full damage.',
  smelt:'Put named input/fuel into a nearby furnace, or collect its output. Does not wait for processing to finish.',
  respawn:'Respawn after a death; no items are restored.',wait:'Let the real-time simulation continue for up to the given seconds, returning early as soon as the running action finishes; then observe.',cancel:'Cancel the active action; movement and item use stop.'
};
// On the paused clock a mutating call runs its action to completion (or its time slice) before returning.
const PAUSED={move_to:'Walk toward a destination for at most ten seconds of game time. Pathfinding does not mine or place blocks. Returns when reached or when the time slice ends.',
  wait:'Let the game run for the given seconds, then observe. The world is frozen at all other times except during actions.'};
export const descriptionsFor=(clock='real')=>clock==='paused'?{...descriptions,...PAUSED}:descriptions;
// A single mutating action at a time. A cancelled operation must settle before
// another may start; a stuck native operation poisons the controller instead.
export class ActionManager {
  constructor({execute,stop,onEvent=()=>{},clock=()=>performance.now(),deadline=Infinity,maxSeconds=10,onFault=()=>{}}){
    Object.assign(this,{execute,stop,onEvent,clock,deadline,maxSeconds,onFault});this.active=null;this.last=null;this.closed=false;this.poisoned=false;
  }
  status(){return {active:this.active?{id:this.active.id,name:this.active.name,args:this.active.args,startedAt:this.active.startedAt}:null,last:this.last};}
  start(name,args){
    if(this.closed||this.clock()>=this.deadline)return {ok:false,error:'run_finished'};
    if(this.poisoned)return {ok:false,error:'controller_fault'};
    if(this.active)return {ok:false,error:'busy',action:this.status().active};
    const schema=schemas[name];if(!schema)return {ok:false,error:'unknown_tool'};
    const parsed=schema.safeParse(args);if(!parsed.success)return {ok:false,error:'invalid_arguments',details:parsed.error.issues};
    const job={id:randomUUID(),name,args:parsed.data,startedAt:this.clock(),abort:new AbortController()};
    this.active=job;this.onEvent('action_start',{id:job.id,name,args:job.args});
    const duration=Math.min((job.args.seconds??this.maxSeconds)*1000,this.maxSeconds*1000,Math.max(1,this.deadline-this.clock()));
    const timer=setTimeout(()=>job.abort.abort('action_timeout'),duration+(['move_to','move','attack','use'].includes(name)?100:0));
    const operation=Promise.resolve().then(()=>this.execute(name,job.args,job.abort.signal));
    const aborted=new Promise((_,reject)=>job.abort.signal.addEventListener('abort',()=>{try{this.stop();}catch{}reject(new Error(String(job.abort.signal.reason)));},{once:true}));
    job.done=(async()=>{
      let result;
      try{const value=await Promise.race([operation,aborted]);result={ok:true,value};}
      catch(error){
        result={ok:false,error:errorText(error)};
        if(job.abort.signal.aborted){
          const settled=await Promise.race([operation.then(()=>true,()=>true),sleep(1500).then(()=>false)]);
          if(!settled){this.poisoned=true;this.onFault('Native action did not settle after cancellation');}
        }
      }finally{clearTimeout(timer);try{this.stop();}catch{}}
      this.last={id:job.id,name,...result,durationMs:this.clock()-job.startedAt};
      this.active=null;this.onEvent('action_end',this.last);return this.last;
    })();
    return {ok:true,action:{id:job.id,name,status:'running'}};
  }
  async cancel(reason='cancelled') {const active=this.active;if(active){active.abort.abort(reason);await active.done;}return {ok:true,...this.status()};}
  async shutdown(){this.closed=true;await this.cancel('run_finished');}
}
