import { readFileSync } from 'node:fs';
const { extractEntityRefs } = await import('/code/garrytan/gbrain/src/core/link-extraction.ts');
const pages: { text: string }[] = JSON.parse(readFileSync('/var/tmp/rx/pages.json', 'utf8'));
const t: number[] = []; let n = 0;
for (let r = 0; r < 5; r++) { const a = performance.now(); n = 0; for (const p of pages) n += extractEntityRefs(p.text).length; t.push(performance.now() - a); }
console.log(JSON.stringify({ extractEntityRefs_ms_p50: +t.sort((x, y) => x - y)[2]!.toFixed(1), refs: n }));
