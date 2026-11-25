import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { stripCodeBlocks } = await import('/code/garrytan/gbrain/src/core/markdown-code.ts');
const addon = createRequire(import.meta.url)(process.env.ADDON!);
const gazJson = readFileSync('/var/tmp/rx/gaz.json', 'utf8'); const flat = JSON.parse(gazJson).flatMap(([, b]: any) => b);
const sc = new addon.MentionScanner(gazJson);
const pages: any[] = JSON.parse(readFileSync('/var/tmp/rx/pages.json', 'utf8'));
const med = (f: () => void) => { const t: number[] = []; for (let r = 0; r < 7; r++) { const a = performance.now(); f(); t.push(performance.now() - a); } return +t.sort((x, y) => x - y)[3]!.toFixed(1); };
let stripped: string[] = [], joined = '', bounds = new Uint32Array(1), tri = new Uint32Array(0);
const src = pages.map(p => p.source_id), slugs = pages.map(p => p.slug);
console.log(JSON.stringify({
  strip_ms: med(() => { stripped = pages.map(p => stripCodeBlocks(p.text, { onHtmlComment: () => {} })); }),
  join_bounds_ms: med(() => { joined = stripped.join(''); bounds = new Uint32Array(pages.length + 1); for (let k = 0; k < pages.length; k++) bounds[k + 1] = bounds[k]! + stripped[k]!.length; }),
  napi_scan_ms: med(() => { tri = sc.scan(joined, bounds, src, slugs, false); }),
  build_mentions_ms: med(() => { const o: any[] = []; for (let j = 0; j < tri.length; j += 3) { const e = flat[tri[j + 1]!]; o.push({ slug: e.slug, source_id: e.source_id, name: e.title, offset: tri[j + 2]! }); } }),
}));
