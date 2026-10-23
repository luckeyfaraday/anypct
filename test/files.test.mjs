import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJson, readJson } from '../src/util.mjs';

test('atomic JSON replacement survives transient Windows sharing violations',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minecraft-bench-files-'));
  const file=path.join(directory,'status.json');
  try {
    await writeJson(file,{status:'running'});
    const rename=fs.rename;let failures=2;
    t.mock.method(fs,'rename',async(...args)=>{
      if(failures-->0){
        assert.deepEqual(await readJson(file),{status:'running'});
        throw Object.assign(new Error('Windows sharing violation'),{code:'EPERM'});
      }
      return rename(...args);
    });
    await writeJson(file,{status:'complete'});
    assert.deepEqual(await readJson(file),{status:'complete'});
    assert.deepEqual(await fs.readdir(directory),['status.json']);
  } finally {
    t.mock.restoreAll();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('minecraft-bench-files-'));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
