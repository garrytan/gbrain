// TS baseline: findMentionedEntities over every page text of the dump, and its parts.
import { readFileSync, writeFileSync } from 'node:fs';
const G = '/code/garrytan/gbrain/src';
const { findMentionedEntities, tokenizeForScan } = await import(`${G}/core/by-mention.ts`);
const { stripCodeBlocks } = await import(`${G}/core/markdown-code.ts`);
const gaz = new Map(JSON.parse(readFileSync('/var/tmp/rx/gaz.json', 'utf8')));
const pages: { slug: string; source_id: string; text: string }[] = JSON.parse(readFileSync('/var/tmp/rx/pages.json', 'utf8'));
const reps = Number(process.argv[2] ?? 5);
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
function run(label: string, f: (p: typeof pages[0]) => unknown) {
  const totals: number[] = []; let per: number[] = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now(); const pp: number[] = [];
    for (const p of pages) { const a = performance.now(); f(p); pp.push(performance.now() - a); }
    totals.push(performance.now() - t0); if (r === reps - 1) per = pp;
  }
  console.log(JSON.stringify({ label, total_ms_p50: +q(totals, 0.5).toFixed(1), total_ms_min: +Math.min(...totals).toFixed(1), page_us_p50: +(q(per, 0.5) * 1000).toFixed(1), page_us_p95: +(q(per, 0.95) * 1000).toFixed(1), page_us_p99: +(q(per, 0.99) * 1000).toFixed(1) }));
}
const opts = (p: typeof pages[0]) => ({ fromSlug: p.slug, fromSourceId: p.source_id, allowCrossSource: false });
run('strip', p => stripCodeBlocks(p.text, { onHtmlComment: () => {} }));
run('strip+tokenize', p => tokenizeForScan(stripCodeBlocks(p.text, { onHtmlComment: () => {} })));
run('findMentionedEntities', p => findMentionedEntities(p.text, gaz as any, opts(p)));
if (process.argv[3]) {
  const out = pages.map(p => findMentionedEntities(p.text, gaz as any, opts(p)));
  writeFileSync(process.argv[3], JSON.stringify(out));
  console.log(JSON.stringify({ wrote: process.argv[3], mentions: out.reduce((a, m) => a + m.length, 0) }));
}
