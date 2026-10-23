import fs from 'node:fs';
import path from 'node:path';

export class RunLog {
  constructor(directory){this.directory=directory;fs.mkdirSync(directory,{recursive:true});this.file=path.join(directory,'events.jsonl');fs.writeFileSync(this.file,'',{flag:'wx'});this.seq=0;this.start=null;}
  elapsed(){return this.start===null?0:performance.now()-this.start;}
  event(type,data={}){const event={seq:this.seq++,at:new Date().toISOString(),elapsedMs:this.start===null?null:this.elapsed(),type,data};fs.appendFileSync(this.file,JSON.stringify(event)+'\n');return event;}
}
