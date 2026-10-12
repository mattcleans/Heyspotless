const counters = ['jobs','expiredOffers','assigned','needsScheduling','held','offered','notified','deferred','unreachable','refused','unfilled','pushed','failed'];
export async function workerToken(serviceKey, projectRef) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(serviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`heyspotless:matching-worker:v1:${projectRef}`)));
  return Array.from(bytes, n => n.toString(16).padStart(2,'0')).join('');
}
function equal(a,b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0;
}
function json(body,status=200) { return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
export function createWorkerHandler({ config, getEnv, run, claim, finish }) {
  return async request => {
    const serviceKey=getEnv('SUPABASE_SERVICE_ROLE_KEY');
    const presented=request.headers.get('x-heyspotless-worker-token');
    if (!serviceKey || !equal(presented,await workerToken(serviceKey,config.projectRef))) return json({error:'unauthorized'},401);
    if (getEnv('SUPABASE_URL')?.replace(/\/$/,'') !== `https://${config.projectRef}.supabase.co`) return json({error:'Worker project configuration mismatch.'},503);
    if (request.method==='GET') return json({ready:true,databaseChecked:false,sourceVersion:config.sourceVersion,sourceDigest:config.sourceDigest,projectRef:config.projectRef,preview:config.preview,providerMessagesAllowed:!config.preview});
    if (request.method!=='POST') return json({error:'Use POST to run matching.'},405);
    const id=crypto.randomUUID(); let claimed=false;
    try {
      claimed=await claim(id);
      if (!claimed) return json({skipped:true,reason:'Matching worker already running.'},202);
      const result=await run(config.appOrigin),summary={};
      for(const key of counters) {
        const n=result[key]; if (!Number.isInteger(n)||n<0) throw new Error('Invalid matching report.'); summary[key]=n;
      }
      const succeeded=summary.failed===0;
      if (!await finish(id,succeeded?'success':'failed',summary)) return json({error:'Matching completed after its lease changed.'},503);
      return json({sourceVersion:config.sourceVersion,...summary},succeeded?200:503);
    } catch {
      if (claimed) { try { await finish(id,'failed',{}); } catch { /* The lease expires; a later run can recover. */ } }
      return json({error:'Matching worker could not finish. Saved pending visits remain available for retry.'},503);
    }
  };
}
