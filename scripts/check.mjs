import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for(const folder of ['src','scripts','public','test'])for(const name of await fs.readdir(folder))if(/\.(mjs|js)$/.test(name)){
  const result=spawnSync(process.execPath,['--check',`${folder}/${name}`],{stdio:'inherit',windowsHide:true});if(result.status!==0)process.exit(result.status??1);
}
console.log('All JavaScript modules parse.');
