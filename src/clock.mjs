// Course clocks. The real clock is wall time from the first observation: the world runs while the model
// thinks. The paused clock counts only game time that has run. Between tool calls the server is frozen
// (Carpet `tick freeze`: entities, blocks, weather and the day cycle stop) and the bot's physics is off, so
// thinking costs no game time. Players still tick on a frozen Carpet server: natural regeneration is
// switched off while frozen so thinking cannot heal, and the controller spaces attacks by course time.
// Burning, drowning and status effects still run during a freeze; that residual is documented.
export class RealClock {
  constructor(){this.kind='real';this.start=null;}
  begin(){this.start=performance.now();}
  elapsed(){return this.start===null?0:performance.now()-this.start;}
  async run(fn){return fn();}
  async close(){}
}
export class PausedClock {
  constructor({command,bot,onEvent=()=>{}}){Object.assign(this,{command,bot,onEvent});this.kind='paused';this.accumulated=0;this.since=null;this.frozen=false;this.queue=Promise.resolve();this.freezes=0;}
  begin(){}
  elapsed(){return this.accumulated+(this.since===null?0:performance.now()-this.since);}
  // Carpet's `tick freeze` toggles; the reply says which state the server is now in.
  async toggle(wantFrozen){
    const reply=String(await this.command('tick freeze'));
    const frozen=/is (deeply )?frozen/.test(reply),running=/runs normally/.test(reply);
    if(!frozen&&!running)throw new Error(`Unexpected tick freeze reply: ${reply.slice(0,160)}`);
    if(frozen!==wantFrozen){const again=String(await this.command('tick freeze'));if(/is (deeply )?frozen/.test(again)!==wantFrozen)throw new Error(`Could not ${wantFrozen?'freeze':'resume'} the world: ${again.slice(0,160)}`);}
  }
  async freeze(){
    if(this.frozen)return;
    this.bot.physicsEnabled=false;this.bot.clearControlStates?.();
    await this.toggle(true);
    if(this.since!==null){this.accumulated+=performance.now()-this.since;this.since=null;}
    await this.command('gamerule naturalRegeneration false');
    this.frozen=true;this.freezes++;
  }
  async resume(){
    if(!this.frozen)return;
    await this.command('gamerule naturalRegeneration true');
    await this.toggle(false);
    this.since=performance.now();this.bot.physicsEnabled=true;this.frozen=false;
  }
  // One tool call at a time lets the world run; concurrent read-only calls never resume it.
  run(fn){
    const next=this.queue.then(async()=>{await this.resume();try{return await fn();}finally{await this.freeze();}});
    this.queue=next.catch(()=>{});return next;
  }
  async close(){if(this.frozen){await this.command('gamerule naturalRegeneration true').catch(()=>{});}}
}
