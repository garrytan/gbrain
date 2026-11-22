#!/usr/bin/env bun
/**
 * Round-trip check for rust/scripts/export-corpus.ts:
 *   1. import a corpus into a scratch PGLite brain:  run.ts --engine pglite --only import --data-dir <dir> --fresh ...
 *   2. export that brain:                             export-corpus.ts --pglite-dir <dir> --out <out>
 *   3. compare:  bun rust/bench/baseline/roundtrip-check.ts <original-corpus> <exported-corpus>
 * Pages are matched by (source, slug); chunks by (slug, idx). Order differs (the export walks source then slug).
 * Exits non-zero on any difference. Prints counts only, never page text.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { chunkVector, loadCorpus } from './lib/corpus.ts';

const [aDir, bDir] = process.argv.slice(2);
if (!aDir || !bDir) { console.error('usage: roundtrip-check.ts <original-corpus> <exported-corpus>'); process.exit(2); }

const a = await loadCorpus(aDir);
const b = await loadCorpus(bDir);
const problems: string[] = [];
/** jsonb does not keep key order, so compare frontmatter with sorted keys. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([m], [n]) => (m < n ? -1 : 1))) : x));
const check = (ok: boolean, message: string) => { if (!ok) problems.push(message); };

check(a.dims === b.dims, `dims ${a.dims} vs ${b.dims}`);
check(a.pages.length === b.pages.length, `pages ${a.pages.length} vs ${b.pages.length}`);
check(a.chunks.length === b.chunks.length, `chunks ${a.chunks.length} vs ${b.chunks.length}`);

const bPages = new Map(b.pages.map(p => [`${p.source_id}/${p.slug}`, p]));
let pagesCompared = 0, chunksCompared = 0, vectorMismatch = 0, textMismatch = 0, pageMismatch = 0;
for (const p of a.pages) {
  const q = bPages.get(`${p.source_id}/${p.slug}`);
  if (!q) { pageMismatch++; continue; }
  pagesCompared++;
  if (q.type !== p.type || q.title !== p.title || q.body !== p.body || q.chunk_count !== p.chunk_count
    || canon(q.frontmatter) !== canon(p.frontmatter)) pageMismatch++;
  for (let k = 0; k < p.chunk_count; k++) {
    const ra = p.chunk_start + k, rb = q.chunk_start + k;
    chunksCompared++;
    if (a.chunks[ra]!.idx !== b.chunks[rb]!.idx || a.chunks[ra]!.text !== b.chunks[rb]!.text) textMismatch++;
    const va = chunkVector(a, ra), vb = chunkVector(b, rb);
    for (let d = 0; d < a.dims; d++) if (va[d] !== vb[d]) { vectorMismatch++; break; }
  }
}
check(pageMismatch === 0, `${pageMismatch} pages differ or are missing`);
check(textMismatch === 0, `${textMismatch} chunks differ in text or index`);
check(vectorMismatch === 0, `${vectorMismatch} chunk vectors differ bit for bit`);

// Queries must be stored chunk vectors.
const stored = new Set<string>();
for (let r = 0; r < b.chunks.length; r++) stored.add(Buffer.from(chunkVector(b, r).buffer, chunkVector(b, r).byteOffset, b.dims * 4).toString('base64'));
let queriesNotInCorpus = 0;
for (let q = 0; q < b.queryCount; q++) {
  const v = b.queries.subarray(q * b.dims, (q + 1) * b.dims);
  if (!stored.has(Buffer.from(v.buffer, v.byteOffset, b.dims * 4).toString('base64'))) queriesNotInCorpus++;
}
check(queriesNotInCorpus === 0, `${queriesNotInCorpus} exported queries are not stored chunk vectors`);
check(b.manifest.queries_in_corpus === true, 'manifest does not flag queries_in_corpus');

for (const f of ['manifest.json', 'pages.jsonl', 'chunks.jsonl', 'vectors.f32', 'queries.f32', 'queries.jsonl']) {
  const mode = statSync(join(bDir, f)).mode & 0o777;
  check(mode === 0o600, `${f} mode is ${mode.toString(8)}, expected 600`);
}
check((statSync(bDir).mode & 0o777) === 0o700, 'export directory mode is not 700');

console.log(`pages ${pagesCompared}/${a.pages.length} compared, chunks ${chunksCompared}/${a.chunks.length} compared, ${b.queryCount} queries checked`);
if (problems.length) { console.error(`ROUND TRIP FAILED:\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log('round trip ok: counts, text, frontmatter, vectors (bit-exact), file modes');
