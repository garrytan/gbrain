// Summarize a Bun .cpuprofile: share by bucket (nearest gbrain/package frame), top self functions,
// and inclusive time of named functions.
import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2]!;
const watch = (process.argv[3] ?? 'findMentionedEntities,tokenizeForScan,stripCodeBlocks,buildGazetteer').split(',');
const file = readdirSync(dir).filter(f => f.endsWith('.cpuprofile')).map(f => `${dir}/${f}`)[0]!;
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const SRC = '/code/garrytan/gbrain/';
function bucketOf(url: string): string | null {
  if (!url) return null;
  if (url.includes('node_modules/')) { const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url); return `npm:${m?.[1]}`; }
  if (url.includes(SRC)) {
    const rel = url.slice(url.indexOf(SRC) + SRC.length);
    if (/pglite/.test(rel)) return 'engine:pglite';
    if (/vendor\/postgres|postgres-engine|postgres-js/.test(rel)) return 'engine:postgres-driver';
    if (/engine-sql|pglite-engine|postgres-engine|core\/engine/.test(rel)) return 'engine:ts';
    if (/by-mention|core\/mentions\//.test(rel)) return 'mentions';
    if (/link-extraction|timeline|extract/.test(rel)) return 'links+timeline extraction';
    if (/markdown|fence|frontmatter|yaml/.test(rel)) return 'markdown/frontmatter';
    if (/persistence\//.test(rel)) return 'persistence';
    if (/derive|segment/.test(rel)) return 'derivation';
    if (/config/.test(rel)) return 'config';
    if (/chunk/.test(rel)) return 'chunking';
    if (/sync/.test(rel)) return 'sync';
    return `other-gbrain`;
  }
  if (url.endsWith('.wasm') || url.includes('wasm')) return 'engine:pglite';
  return null;
}
const dts: number[] = p.timeDeltas; const samples: number[] = p.samples;
const bucket = new Map<string, number>(); const self = new Map<string, number>(); const incl = new Map<string, number>();
let total = 0;
for (let i = 0; i < samples.length; i++) {
  const dt = (dts[i + 1] ?? dts[i] ?? 0) / 1000; total += dt;
  let id: number | undefined = samples[i]; let b: string | null = null; const leaf = byId.get(id!)!;
  const lf = leaf.callFrame; const key = `${lf.functionName || '(anon)'} ${(lf.url || '').replace(/.*\/(src|node_modules)\//, '$1/')}:${lf.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + dt);
  const seenW = new Set<string>();
  while (id !== undefined) {
    const n = byId.get(id)!; const cf = n.callFrame;
    if (b === null) b = bucketOf(cf.url);
    if (watch.includes(cf.functionName) && !seenW.has(cf.functionName)) { seenW.add(cf.functionName); incl.set(cf.functionName, (incl.get(cf.functionName) ?? 0) + dt); }
    id = parent.get(id);
  }
  const name = b ?? (lf.functionName === '(idle)' ? '(idle)' : lf.functionName === '(garbage collector)' ? '(gc)' : 'runtime/native');
  bucket.set(name, (bucket.get(name) ?? 0) + dt);
}
const busy = total - (bucket.get('(idle)') ?? 0);
console.log(`profile ${file}\ntotal sampled ${total.toFixed(0)} ms, busy ${busy.toFixed(0)} ms`);
for (const [k, v] of [...bucket].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${v.toFixed(0).padStart(7)} ms  ${(100 * v / busy).toFixed(1)}%`);
console.log('inclusive:'); for (const [k, v] of incl) console.log(`  ${k.padEnd(32)} ${v.toFixed(0).padStart(7)} ms  ${(100 * v / busy).toFixed(1)}%`);
console.log('top self:'); for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[4] ?? 15))) console.log(`  ${v.toFixed(0).padStart(7)} ms  ${k}`);
