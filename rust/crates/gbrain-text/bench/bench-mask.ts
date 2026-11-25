import { readFileSync } from 'node:fs';
const pages: { text: string }[] = JSON.parse(readFileSync('/var/tmp/rx/pages.json', 'utf8'));
function oldMask(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content;
  const chars = content.split('');
  for (const [s, e] of ranges) for (let i = s; i < e && i < chars.length; i++) chars[i] = ' ';
  return chars.join('');
}
function newMask(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content;
  const n = content.length; const cover = new Uint8Array(n);
  for (const [s, e] of ranges) for (let i = Math.max(0, s); i < e && i < n; i++) cover[i] = 1;
  let out = ''; let i = 0;
  while (i < n) { let j = i; if (cover[i]) { while (j < n && cover[j]) j++; out += ' '.repeat(j - i); } else { while (j < n && !cover[j]) j++; out += content.slice(i, j); } i = j; }
  return out;
}
const re = /\[\[[^\]]+\]\]/g;
const inputs = pages.map(p => { const r: Array<[number, number]> = []; for (const m of p.text.matchAll(re)) r.push([m.index!, m.index! + m[0].length]); return [p.text, r] as const; });
let same = 0; for (const [t, r] of inputs) if (oldMask(t, r) === newMask(t, r)) same++;
const time = (f: any) => { const t: number[] = []; for (let k = 0; k < 5; k++) { const a = performance.now(); for (const [x, r] of inputs) f(x, r); t.push(performance.now() - a); } return +t.sort((a, b) => a - b)[2]!.toFixed(1); };
console.log(JSON.stringify({ identical: same, pages: inputs.length, old_ms: time(oldMask), new_ms: time(newMask) }));
