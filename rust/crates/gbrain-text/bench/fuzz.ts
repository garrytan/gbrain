// Parity fuzz: random texts over a hand-built gazetteer that uses every entry flag
// (caseTokens, atOnly, shared, connector_stub, matchText, anySpacing, cross-source twins,
// Hangul and Katakana names). Compares TS findMentionedEntities with the Rust scanner.
import { createRequire } from 'node:module';
const G = '/code/garrytan/gbrain/src';
const { findMentionedEntities, tokenizeTitle } = await import(`${G}/core/by-mention.ts`);
const { stripCodeBlocks } = await import(`${G}/core/markdown-code.ts`);
const addon = createRequire(import.meta.url)(process.env.ADDON!);
let s = 7; const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
const E = (title: string, slug: string, source_id = 'default', extra: Record<string, unknown> = {}) => ({ slug, source_id, title, tokens: tokenizeTitle((extra.matchText as string) ?? title), ...extra });
const entries = [
  E('Acme Corp', 'companies/acme-corp'), E('Acme', 'companies/acme'), E('Acme Corp', 'companies/acme-b', 'other'),
  E('Jordan Lee', 'people/jordan-lee'), E('Jordan Lee', 'people/jordan-lee-2', 'default', { shared: true }), E('Jordan Lee', 'people/jordan-lee-3', 'default', { shared: true }),
  E('Pat', 'people/pat', 'default', { caseTokens: ['Pat'], origin: 'declared', matchText: 'Pat' }),
  E('jdoe', 'people/jdoe', 'default', { atOnly: true }),
  E('Nguyễn Văn', 'people/nguyen'), E('Zoë Smith', 'people/zoe', 'other', { connector_stub: true }), E('Zoë Smith', 'people/zoe', 'third'),
  E('김지원', 'people/kim'), E('김 지원', 'people/kim2', 'default', { anySpacing: true, matchText: '김 지원' }),
  E('タナカ', 'people/tanaka'), E('デン', 'places/den'), E('王伟', 'people/wang'), E('Ελένη Σ', 'people/eleni'),
];
const gaz = new Map<string, any[]>();
for (const e of entries) { if (!e.tokens.length) continue; const k = e.tokens[0]; (gaz.get(k) ?? gaz.set(k, []).get(k)!).push(e); }
for (const b of gaz.values()) b.sort((a, c) => c.tokens.length - a.tokens.length);
const flat = [...gaz].flatMap(([, b]) => b);
const scanner = new addon.MentionScanner(JSON.stringify([...gaz]));
const PIECES = ['Acme', 'acme', 'ACME', 'Corp', 'corp', 'Acme Corp', 'Jordan', 'Lee', 'Jordan Lee', 'Pat', 'pat', 'PAT', '@jdoe', 'jdoe', '@', "'s", 'Nguyễn', 'Nguye\u0302\u0303n', 'Văn', 'Zoë', 'Zoe\u0308', 'Smith', '김지원', '김 지원', '김  지원', '지원', '김지원씨는', '김지원하는', '김지원에게서', '가김지원', 'タナカ', 'タナカさん', 'インシデント', 'デン', 'デンタル', '喫茶デン', 'デン・カフェ', 'ー', '\u3099', '王伟', '王', '伟', 'Ελένη', 'ΕΛΈΝΗ', 'Σ', 'σ', ' ', ' ', ' ', '\n', '\n\n', '\t', '\u00a0', '\u3000', ',', '.', '`', '```', '~~~', '<!--', '-->', '\ud83d\ude00', '\ud800', '\udc00', 'x', '1', '½', '¹', 'ǅ', 'İ', 'ß', 'ﬁ', '\u0301', '\ufe0f', '[[people/pat]]'];
let mismatch = 0; const N = Number(process.argv[2] ?? 20000); const texts: string[] = []; const from: [string, string][] = [];
for (let i = 0; i < N; i++) {
  const parts: string[] = []; const n = 1 + Math.floor(rand() * 30);
  for (let k = 0; k < n; k++) { const p = pick(PIECES); parts.push(p.startsWith('```') || p === '~~~' ? (rand() < 0.5 ? '\n' + p + '\n' : p) : p); if (rand() < 0.6) parts.push(' '); }
  texts.push(parts.join('')); from.push(pick([['default', 'notes/x'], ['default', 'people/jordan-lee-2'], ['other', 'notes/y'], ['default', 'companies/acme'], ['other', 'people/zoe']]));
}
for (const cross of [false, true]) {
  const stripped = texts.map(t => stripCodeBlocks(t, { onHtmlComment: () => {} }));
  const bounds = new Uint32Array(N + 1); for (let k = 0; k < N; k++) bounds[k + 1] = bounds[k]! + stripped[k]!.length;
  const tri: Uint32Array = scanner.scan(stripped.join(''), bounds, from.map(f => f[0]), from.map(f => f[1]), cross);
  const rs: any[][] = texts.map(() => []);
  for (let j = 0; j < tri.length; j += 3) { const e = flat[tri[j + 1]!]; rs[tri[j]!]!.push({ slug: e.slug, source_id: e.source_id, name: e.title, offset: tri[j + 2]! }); }
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const ts = findMentionedEntities(texts[i]!, gaz as any, { fromSourceId: from[i]![0], fromSlug: from[i]![1], allowCrossSource: cross });
    hits += ts.length;
    if (JSON.stringify(ts) !== JSON.stringify(rs[i])) { if (mismatch++ < 5) console.log('MISMATCH', cross, JSON.stringify(texts[i]), JSON.stringify(ts), JSON.stringify(rs[i])); }
  }
  console.log(JSON.stringify({ allowCrossSource: cross, texts: N, ts_mentions: hits }));
}
console.log(JSON.stringify({ mismatches: mismatch }));
