// Assistant stream events can carry only the initial output-token estimate.
// The CLI's final usage record contains the complete conversation totals.
export function applyFinalClaudeUsage(metrics,usage){
  if(!usage||!Number.isFinite(usage.output_tokens)){metrics.tokenUsageComplete=false;return;}
  metrics.uncachedInputTokens=usage.input_tokens??0;
  metrics.cacheReadInputTokens=usage.cache_read_input_tokens??0;
  metrics.cacheCreationInputTokens=usage.cache_creation_input_tokens??0;
  metrics.inputTokens=metrics.uncachedInputTokens+metrics.cacheReadInputTokens+metrics.cacheCreationInputTokens;
  metrics.outputTokens=usage.output_tokens;
  metrics.tokenUsageComplete=true;
  metrics.usageSource='claude_code_final_result';
}
