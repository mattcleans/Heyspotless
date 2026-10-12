import config from './config.js';
import { createWorkerHandler } from './handler.js';

// The deployment artifact includes the actual app libraries. Configuration is
// read through the generated adapter; hosted runtimes prohibit env mutation.
// No credentials are embedded in deployment files.
const { createAdminClient }=await import('./source/src/lib/supabase/admin.ts');
const { runDispatch }=await import('./source/src/lib/dispatch/run.ts');
const db=createAdminClient();
const handler=createWorkerHandler({config,getEnv:key=>Deno.env.get(key),run:origin=>runDispatch(origin),
  verifyToken:async token=>{
    const {data,error}=await db.rpc('verify_matching_worker_token',{p_token:token});
    if(error) throw new Error('Worker authentication unavailable.');return data===true;
  },
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
