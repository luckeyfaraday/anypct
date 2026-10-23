import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFinalClaudeUsage } from '../src/claude-usage.mjs';

test('Claude final usage replaces partial output counts without double-counting cached input',()=>{
  const metrics={inputTokens:2071742,outputTokens:505,costUsd:null};
  applyFinalClaudeUsage(metrics,{input_tokens:76,cache_creation_input_tokens:182923,cache_read_input_tokens:1888743,output_tokens:11238});
  assert.equal(metrics.inputTokens,2071742);
  assert.equal(metrics.outputTokens,11238);
  assert.equal(metrics.tokenUsageComplete,true);
  assert.equal(metrics.costUsd,null);
});
test('an interrupted CLI keeps available token counts marked incomplete',()=>{
  const metrics={inputTokens:2000,outputTokens:8};
  applyFinalClaudeUsage(metrics,undefined);
  assert.deepEqual(metrics,{inputTokens:2000,outputTokens:8,tokenUsageComplete:false});
});
