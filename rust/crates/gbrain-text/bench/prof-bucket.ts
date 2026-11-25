// For samples charged to a bucket (nearest gbrain frame matches a regex), list the nearest gbrain
// function (file:fn) and the leaf natives they spend in.
import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2]!; const re = new RegExp(process.argv[3]!);
const file = readdirSync(dir).filter(f => f.endsWith('.cpuprofile')).map(f => `${dir}/${f}`)[0]!;
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map<number, any>(p.nodes.map((n: any) => [n.id, n])); const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const owner = new Map<string, number>(), leafs = new Map<string, number>(), files = new Map<string, number>(); let tot = 0;
for (let i = 0; i < p.samples.length; i++) {
  const dt = (p.timeDeltas[i + 1] ?? 0) / 1000; let id: number | undefined = p.samples[i]; const leaf = byId.get(id!)!.callFrame;
  while (id !== undefined) { const cf = byId.get(id)!.callFrame; if (cf.url && (cf.url.includes('/gbrain/src/') || cf.url.includes('node_modules'))) break; id = parent.get(id); }
  if (id === undefined) continue; const cf = byId.get(id)!.callFrame; if (!re.test(cf.url)) continue;
  tot += dt; const rel = cf.url.replace(/.*\/gbrain\//, '');
  const k = `${rel}:${cf.functionName || '(anon)'}:${cf.lineNumber}`; owner.set(k, (owner.get(k) ?? 0) + dt);
  files.set(rel, (files.get(rel) ?? 0) + dt);
  const lk = leaf.functionName || '(anon)'; leafs.set(lk, (leafs.get(lk) ?? 0) + dt);
}
console.log(`bucket ${re} ${tot.toFixed(0)} ms`);
console.log('files:'); for (const [k, v] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v.toFixed(0).padStart(6)}  ${k}`);
console.log('functions:'); for (const [k, v] of [...owner].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${v.toFixed(0).padStart(6)}  ${k}`);
console.log('leaf natives:'); for (const [k, v] of [...leafs].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${v.toFixed(0).padStart(6)}  ${k}`);
