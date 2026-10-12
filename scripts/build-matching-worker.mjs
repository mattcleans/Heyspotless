import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Generate a deployment artifact from the actual app modules, not a second matcher. */
export async function buildMatchingWorker({ root, output, projectRef, appOrigin, sourceVersion, preview }) {
  if (!/^[a-z0-9]{20}$/.test(projectRef) || !/^[a-f0-9]{40}$/.test(sourceVersion)) throw new Error('Project ref and source commit required.');
  const origin = new URL(appOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== appOrigin) throw new Error('Use the exact HTTPS app origin.');
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const version = lock.packages?.['node_modules/@supabase/supabase-js']?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Pinned Supabase SDK required.');
  const files = [], sources = [], seen = new Set();
  async function sourcePath(path) {
    for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) {
      if (!candidate.endsWith('.ts')) continue;
      try { await access(resolve(root, candidate)); return candidate; } catch { /* Try the next real source path. */ }
    }
    throw new Error(`Missing matcher dependency: ${path}`);
  }
  async function visit(path) {
    if (seen.has(path)) return;
    if (!path.startsWith('src/lib/') || path.includes('..')) throw new Error('Worker dependencies must stay in app libraries.');
    seen.add(path);
    const original = await readFile(resolve(root, path), 'utf8');
    sources.push({ path, sha256: createHash('sha256').update(original).digest('hex') });
    const name = `source/${path}`;
    const ast=ts.createSourceFile(path,original,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const matches=[];
    function imports(node) {
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) matches.push(node.moduleSpecifier);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword) {
        const argument=node.arguments[0];if(!argument||!ts.isStringLiteral(argument)) throw new Error('Non-literal worker import requires review.');matches.push(argument);
      }
      ts.forEachChild(node,imports);
    }
    imports(ast);matches.sort((a,b)=>a.getStart(ast)-b.getStart(ast));
    let content = original;
    for (const match of matches.reverse()) {
      const specifier = match.text;
      let rewritten;
      if (specifier === 'server-only') rewritten = posix.relative(posix.dirname(name), 'runtime/server-only.ts');
      else if (specifier === '@supabase/supabase-js') rewritten = `npm:@supabase/supabase-js@${version}`;
      else if (specifier.startsWith('node:')) rewritten = specifier;
      else if (specifier.startsWith('@/') || specifier.startsWith('.')) {
        const target = await sourcePath(specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : posix.normalize(posix.join(posix.dirname(path), specifier)));
        await visit(target);
        rewritten = posix.relative(posix.dirname(name), `source/${target}`);
      } else throw new Error(`Unreviewed worker package: ${specifier}`);
      if (!rewritten.startsWith('.') && !rewritten.includes(':')) rewritten = `./${rewritten}`;
      const offset = match.getStart(ast)+1;
      content = content.slice(0, offset) + rewritten + content.slice(match.getEnd()-1);
    }
    if (/\bprocess\.env\b/.test(content)) {
      let adapter=posix.relative(posix.dirname(name),'runtime/environment.js');
      if(!adapter.startsWith('.')) adapter=`./${adapter}`;
      content = `import process from ${JSON.stringify(adapter)};\n` + content;
    }
    if (/\bBuffer\b/.test(content)) content = 'import { Buffer } from "node:buffer";\n' + content;
    files.push({ name, content });
  }
  await visit('src/lib/dispatch/run.ts');
  sources.sort((a,b) => a.path.localeCompare(b.path));
  const templates=[];
  for(const filename of ['index.js','handler.js','environment.js']) templates.push({name:filename,sha256:createHash('sha256').update(await readFile(resolve(root,'supabase/functions/matching-worker',filename),'utf8')).digest('hex')});
  const sourceDigest = createHash('sha256').update(JSON.stringify({sources,templates,sdkVersion:version})).digest('hex');
  const config = { projectRef, appOrigin, sourceVersion, sourceDigest, preview: Boolean(preview), sdkVersion: version };
  for (const filename of ['index.js', 'handler.js', 'environment.js']) files.push({ name: filename, content: await readFile(resolve(root, 'supabase/functions/matching-worker', filename), 'utf8') });
  files.push({name:'runtime/environment.js',content:'import config from "../config.js";\nimport { createWorkerEnvironment } from "../environment.js";\nexport default Object.freeze({env:createWorkerEnvironment(config,key=>Deno.env.get(key))});\n'});
  files.push({ name: 'config.js', content: `export default ${JSON.stringify(config)};\n` });
  files.push({ name: 'runtime/server-only.ts', content: '// This deployment runs only in the authenticated Edge server runtime.\nexport {};\n' });
  files.push({ name: 'deno.json', content: JSON.stringify({ compilerOptions: { lib: ['deno.ns', 'deno.window', 'dom', 'esnext'] } }) });
  files.push({ name: 'manifest.json', content: JSON.stringify({ ...config, sources, templates }, null, 2) });
  if (output) for (const file of files) {
    const destination = resolve(output, file.name); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, file.content);
  }
  return { files, config, sources };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_,i) => [process.argv[2+i*2], process.argv[3+i*2]]));
  const result = await buildMatchingWorker({ root: process.cwd(), output: resolve(args['--output']), projectRef: args['--project-ref'], appOrigin: args['--app-origin'], sourceVersion: args['--source-version'], preview: args['--preview'] === 'true' });
  console.log(JSON.stringify({ files: result.files.length, sourceDigest: result.config.sourceDigest, sdkVersion: result.config.sdkVersion }));
}
