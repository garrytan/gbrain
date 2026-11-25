// Does a TypeScript rewrite of tokenizeForScan close the gap? Same tokens, one pass, ASCII fast path.
import { readFileSync } from 'node:fs';
const G = '/code/garrytan/gbrain/src';
const { tokenizeForScan } = await import(`${G}/core/by-mention.ts`);
const { stripCodeBlocks } = await import(`${G}/core/markdown-code.ts`);
const pages: { text: string }[] = JSON.parse(readFileSync('/var/tmp/rx/pages.json', 'utf8'));
const L = /^\p{L}$/u, LM = /^[\p{L}\p{M}]$/u;
const isCJK = (cp: number) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af);
const asciiAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
function fast(text: string) {
  const out: { text: string; offset: number; length: number }[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (!asciiAlnum(c)) { i++; continue; }
    } else {
      const cp = text.codePointAt(i)!; const w = cp > 0xffff ? 2 : 1;
      if (isCJK(cp)) { const ch = text.slice(i, i + w); out.push({ text: ch.normalize('NFC').toLowerCase(), offset: i, length: w }); i += w; continue; }
      if (!L.test(String.fromCodePoint(cp))) { i++; continue; }
    }
    const start = i; let ascii = true;
    while (i < n) {
      const d = text.charCodeAt(i);
      if (d < 128) { if (asciiAlnum(d)) { i++; continue; } break; }
      const cp = text.codePointAt(i)!;
      if (isCJK(cp) || !LM.test(String.fromCodePoint(cp))) break;
      ascii = false; i += cp > 0xffff ? 2 : 1;
    }
    const tok = text.slice(start, i);
    out.push({ text: ascii ? tok.toLowerCase() : tok.normalize('NFC').toLowerCase(), offset: start, length: i - start });
  }
  return out;
}
const stripped = pages.map(p => stripCodeBlocks(p.text, { onHtmlComment: () => {} }));
let same = 0;
for (const s of stripped) if (JSON.stringify(fast(s)) === JSON.stringify(tokenizeForScan(s))) same++;
const time = (f: (s: string) => unknown) => { const t: number[] = []; for (let r = 0; r < 5; r++) { const a = performance.now(); for (const s of stripped) f(s); t.push(performance.now() - a); } return +t.sort((x, y) => x - y)[2]!.toFixed(1); };
console.log(JSON.stringify({ identical_pages: same, pages: pages.length, tokenize_ts_ms: time(tokenizeForScan), tokenize_fast_ts_ms: time(fast) }));
