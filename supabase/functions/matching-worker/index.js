import process from 'node:process';
import config from './config.js';
import { createWorkerHandler } from './handler.js';

// The deployment artifact includes the actual app libraries. Configuration is
// mapped before their dynamic import; no credentials are embedded in files.
process.env.NEXT_PUBLIC_SUPABASE_URL=Deno.env.get('SUPABASE_URL');
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=Deno.env.get('SUPABASE_ANON_KEY');
process.env.SUPABASE_SERVICE_ROLE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
process.env.DEMO_MODE='0';
if(config.preview) { process.env.MESSAGING_ENABLED='0';process.env.PUSH_ENABLED='0';process.env.BILLING_ENABLED='0'; }
const { createAdminClient }=await import('./source/src/lib/supabase/admin.ts');
const { runDispatch }=await import('./source/src/lib/dispatch/run.ts');
const db=createAdminClient();
const handler=createWorkerHandler({config,getEnv:key=>Deno.env.get(key),run:origin=>runDispatch(origin),
  claim:async id=>{
    const {data,error}=await db.rpc('claim_matching_worker',{p_id:id,p_seconds:180});
    if(error) throw new Error('Worker lease unavailable.');return data===true;
  },
  finish:async(id,status,result)=>{
    const {data,error}=await db.rpc('finish_matching_worker',{p_id:id,p_status:status,p_result:result});
    if(error) throw new Error('Worker lease unavailable.');return data===true;
  }
});
Deno.serve(handler);
