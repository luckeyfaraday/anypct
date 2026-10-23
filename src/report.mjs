export function wilson(successes,total){if(!total)return [0,1];const z=1.96,p=successes/total,d=1+z*z/total,c=(p+z*z/(2*total))/d,h=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;return [Math.max(0,c-h),Math.min(1,c+h)];}
// Student t critical values (two-sided 95%) for small samples; 1.96 beyond 30 degrees of freedom.
const T95=[12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.16,2.145,2.131,2.12,2.11,2.101,2.093,2.086,2.08,2.074,2.069,2.064,2.06,2.056,2.052,2.048,2.045,2.042];
export function scoreStats(values){
  const v=values.filter(Number.isFinite),n=v.length;if(!n)return null;
  const mean=v.reduce((a,b)=>a+b,0)/n,sd=n>1?Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/(n-1)):null,h=n>1?(T95[n-2]??1.96)*sd/Math.sqrt(n):null;
  return {n,mean,min:Math.min(...v),max:Math.max(...v),sd,ci95:h===null?null:[Math.max(0,mean-h),Math.min(1,mean+h)]};
}
export function summarize(results){
  const groups=new Map();
  for(const r of results){if(!r.eligible)continue;const key=`${r.model}|${r.scenario}|${r.durationMs}|${r.protocolHash??'unknown'}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  return [...groups.values()].map(runs=>{const eligible=runs.filter(r=>r.outcome!=='infrastructure_error');const wins=eligible.filter(r=>r.success),times=wins.map(r=>r.completionMs).sort((a,b)=>a-b),progress=eligible.map(r=>r.progress?.score).filter(Number.isFinite);return {model:runs[0].model,scenario:runs[0].scenario,durationMs:runs[0].durationMs,attempts:runs.length,validAttempts:eligible.length,infrastructureErrors:runs.length-eligible.length,successes:wins.length,successRate:eligible.length?wins.length/eligible.length:null,confidence95:wilson(wins.length,eligible.length),medianCompletionMs:times.length?(times[Math.floor((times.length-1)/2)]+times[Math.ceil((times.length-1)/2)])/2:null,
    // Secondary measure: share of route checkpoints reached. Runs graded before checkpoints existed are omitted, not zero.
    meanProgress:progress.length?progress.reduce((s,p)=>s+p,0)/progress.length:null,bestProgress:progress.length?Math.max(...progress):null,progressAttempts:progress.length,
    // Score v2 (time-weighted, partial credit): mean, range and a t-interval over valid attempts.
    score:scoreStats(eligible.map(r=>r.score?.value)),totalCostUsd:runs.every(r=>r.metrics?.costUsd!==null&&r.metrics?.costUsd!==undefined)?runs.reduce((s,r)=>s+r.metrics.costUsd,0):null};});
}
