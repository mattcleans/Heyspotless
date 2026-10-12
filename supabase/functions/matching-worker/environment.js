/**
 * Read-only app configuration without mutating the hosted Deno environment.
 * @param {{preview:boolean}} config
 * @param {(key:string)=>string|undefined} getEnv
 * @returns {Readonly<Record<string,string|undefined>>}
 */
export function createWorkerEnvironment(config,getEnv) {
  const overrides=Object.freeze({
    NEXT_PUBLIC_SUPABASE_URL:getEnv('SUPABASE_URL'),
    NEXT_PUBLIC_SUPABASE_ANON_KEY:getEnv('SUPABASE_ANON_KEY'),
    DEMO_MODE:'0',
    ...(config.preview?{MESSAGING_ENABLED:'0',PUSH_ENABLED:'0',BILLING_ENABLED:'0'}:{})
  });
  return new Proxy(overrides,{
    get:(target,key)=>typeof key==='string'?(Object.hasOwn(target,key)?target[key]:getEnv(key)):undefined,
    set:()=>false,
    defineProperty:()=>false,
    deleteProperty:()=>false
  });
}
