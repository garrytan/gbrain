// Rust path: stripCodeBlocks in TS (unchanged), then one napi call per batch to the Rust scanner,
// then Mention objects rebuilt in TS. Timed end to end, so FFI and object building are counted.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const G = '/code/garrytan/gbrain/src';
const { stripCodeBlocks } = await import(`${G}/core/markdown-code.ts`);
const addon = createRequire(import.meta.url)(process.env.ADDON!);
const gazJson = readFileSync('/var/tmp/rx/gaz.json', 'utf8');
const gazArr: [string, any[]][] = JSON.parse(gazJson);
const flat = gazArr.flatMap(([, b]) => b);
const t0 = performance.now();
const scanner = new addon.MentionScanner(gazJson);
const buildMs = performance.now() - t0;
const pages: { slug: string; source_id: string; text: string }[] = JSON.parse(readFileSync('/var/tmp/rx/pages.json', 'utf8'));
const reps = Number(process.argv[2] ?? 5);
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };

function scanBatch(batch: typeof pages) {
  const stripped = batch.map(p => stripCodeBlocks(p.text, { onHtmlComment: () => {} }));
  const bounds = new Uint32Array(batch.length + 1);
  for (let k = 0; k < batch.length; k++) bounds[k + 1] = bounds[k]! + stripped[k]!.length;
  const tri: Uint32Array = scanner.scan(stripped.join(''), bounds, batch.map(p => p.source_id), batch.map(p => p.slug), false);
  const out: { slug: string; source_id: string; name: string; offset: number }[][] = batch.map(() => []);
  for (let j = 0; j < tri.length; j += 3) {
    const e = flat[tri[j + 1]!];
    out[tri[j]!]!.push({ slug: e.slug, source_id: e.source_id, name: e.title, offset: tri[j + 2]! });
  }
  return out;
}
const results: Record<string, unknown>[] = [];
for (const size of [1, 100, pages.length]) {
  const totals: number[] = []; let per: number[] = [];
  for (let r = 0; r < reps; r++) {
    const t = performance.now(); const pp: number[] = [];
    for (let i = 0; i < pages.length; i += size) { const a = performance.now(); scanBatch(pages.slice(i, i + size)); pp.push((performance.now() - a) / Math.min(size, pages.length - i)); }
    totals.push(performance.now() - t); if (r === reps - 1) per = pp;
  }
  const row = { label: `rust batch=${size}`, total_ms_p50: +q(totals, 0.5).toFixed(1), total_ms_min: +Math.min(...totals).toFixed(1), page_us_p50: +(q(per, 0.5) * 1000).toFixed(1), page_us_p95: +(q(per, 0.95) * 1000).toFixed(1), page_us_p99: +(q(per, 0.99) * 1000).toFixed(1) };
  console.log(JSON.stringify(row)); results.push(row);
}
console.log(JSON.stringify({ scanner_build_ms: +buildMs.toFixed(1), entries: scanner.entries }));
if (process.argv[3]) {
  const out = scanBatch(pages);
  writeFileSync(process.argv[3], JSON.stringify(out));
  console.log(JSON.stringify({ wrote: process.argv[3], mentions: out.reduce((a, m) => a + m.length, 0) }));
}
