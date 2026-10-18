/**
 * A deterministic corpus of inline (<= 1 MiB body) Markdown pages for the Wave B
 * inline golden: prose, headings, code fences, facts and takes fences, a
 * timeline sentinel, CJK, emoji and astral text, CRLF and long lines, from a
 * few bytes up to exactly the inline threshold. Seeded, so every run builds
 * the same bytes.
 */
import { PAGE_INLINE_MAX_BYTES } from '../../src/core/page-size-policy.ts';

export interface CorpusPage { slug: string; content: string }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['widget', 'plan', 'acme-example', 'alice-example', 'roadmap', 'launch', 'metric', 'customer', 'pricing', 'review',
  'décision', 'naïve', '会议', '记录', '検討', '🚀', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', 'quote"mark', 'back\\slash', 'tab\there'];

function sentence(r: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]!);
  return out.join(' ') + '.';
}

function block(r: () => number, i: number): string {
  const k = Math.floor(r() * 10);
  if (k === 0) return `## Section ${i}`;
  if (k === 1) return `### Detail ${i}\n\n${sentence(r, 12)}`;
  if (k === 2) return '```ts\nexport function f' + i + '(x: number): number {\n  return x * ' + i + ';\n}\n```';
  if (k === 3) return `- item ${i}: ${sentence(r, 6)}\n- item ${i + 1}: ${sentence(r, 5)}`;
  if (k === 4) return `> ${sentence(r, 10)}`;
  return sentence(r, 8 + Math.floor(r() * 40));
}

/** Prose blocks until the body reaches `bytes` UTF-8 bytes, then trimmed to exactly that size on a code point. */
function body(r: () => number, bytes: number, fenced: boolean): string {
  const parts: string[] = [];
  let size = 0;
  let fences = 0;
  for (let i = 0; size < bytes; i++) {
    let b = block(r, i);
    if (b.startsWith('```') && (!fenced || ++fences > 4)) b = sentence(r, 10);
    parts.push(b);
    size += Buffer.byteLength(b) + 2;
  }
  const text = parts.join('\n\n');
  const buf = Buffer.from(text);
  let end = Math.min(bytes, buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8');
}

const FACTS = '```facts\n| fact | visibility |\n| --- | --- |\n| acme-example raised a seed | world |\n| alice-example prefers email | private |\n```';
const TAKES = '```takes\n| claim | holder | weight |\n| --- | --- | --- |\n| widget plan ships in Q3 | alice-example | 0.7 |\n```';

export function inlinePageCorpus(): CorpusPage[] {
  const pages: CorpusPage[] = [];
  const add = (slug: string, content: string) => pages.push({ slug, content });
  const r = rng(0x5eed);
  add('golden/tiny', '---\ntitle: Tiny\ntype: note\n---\nHello acme-example.\n');
  add('golden/empty-body', '---\ntitle: Empty\ntype: note\n---\n');
  add('golden/no-frontmatter', `# Heading only\n\n${sentence(r, 30)}\n`);
  add('golden/fences', `---\ntitle: Fences\ntype: concept\ntags: [b, a]\n---\n${body(r, 20_000, true)}\n\n${FACTS}\n\n${TAKES}\n`);
  add('golden/timeline', `---\ntitle: Timeline\ntype: person\n---\n${body(r, 30_000, false)}\n\n---\n\n- 2026-01-02: met alice-example\n- 2026-02-03: ${sentence(r, 12)}\n`);
  add('golden/crlf', `---\r\ntitle: Crlf\r\ntype: note\r\n---\r\n${body(r, 40_000, true).replace(/\n/g, '\r\n')}\r\n`);
  add('golden/long-line', `---\ntitle: Long line\ntype: note\n---\n${'x'.repeat(300_000)} ${sentence(r, 20)}\n`);
  add('golden/cjk', `---\ntitle: 会议记录\ntype: meeting\n---\n${'会议记录検討🚀'.repeat(20_000)}\n`);
  for (const size of [100_000, 500_000, 900_000]) add(`golden/prose-${size}`, `---\ntitle: Prose ${size}\ntype: note\n---\n${body(r, size, true)}\n`);
  const truth = body(r, PAGE_INLINE_MAX_BYTES - 64 * 1024, true);
  const timeline = `- 2026-03-01: ${body(r, 64 * 1024, false)}`;
  const timelineBytes = PAGE_INLINE_MAX_BYTES - Buffer.byteLength(truth);
  add('golden/at-threshold', `---\ntitle: At threshold\ntype: note\n---\n${truth}\n\n<!-- timeline -->\n${Buffer.from(timeline).subarray(0, timelineBytes).toString('utf-8').replace(/\uFFFD+$/, '')}`);
  return pages;
}
