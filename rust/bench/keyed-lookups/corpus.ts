/**
 * The keyed-lookups bench's synthetic corpus, query set, deterministic vectors and stats (bench.ts). Pure functions:
 * nothing here opens a brain, reads a file or calls a provider, so `bench.test.ts` checks them directly.
 */

export const DIMS = 1536;

/** A deterministic unit vector for `text` (FNV-1a seeded xorshift), the same in every arm. */
export function vectorFor(text: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  let x = (h >>> 0) || 1;
  const v = new Array<number>(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    v[i] = (x / 0xffffffff) - 0.5;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);
  return v.map(c => c / norm);
}

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer',
  'partner', 'platform', 'security', 'growth', 'research', 'support', 'onboarding', 'analytics', 'mobile', 'billing'];
const ROLES = ['engineer', 'designer', 'product manager', 'head of sales', 'CTO', 'founder'];

/** The synthetic corpus: companies, people with typed relation lines and dated timelines, notes with wikilinks. */
export function corpus(n: number): Array<{ slug: string; content: string; title: string }> {
  const companies = Math.max(1, Math.floor(n / 10));
  const people = Math.floor((n - companies) / 2);
  const out: Array<{ slug: string; content: string; title: string }> = [];
  const w = (i: number, k: number) => WORDS[(i * 7 + k * 3) % WORDS.length]!;
  for (let i = 0; i < companies; i++) {
    const title = `Company ${i} ${w(i, 0)}`;
    out.push({ slug: `companies/company-${i}`, title, content: `---\ntype: company\ntitle: ${title}\nid: company-${i}\n---\n\n${title} builds ${w(i, 1)} and ${w(i, 2)} tools.\n\nIt works on ${w(i, 3)} with [[companies/company-${(i + 1) % companies}]].\n` });
  }
  for (let i = 0; i < people; i++) {
    const c = (k: number) => `companies/company-${(i * 7 + k * 13) % companies}`;
    const title = `Person ${i} ${w(i, 4)}`;
    out.push({ slug: `people/person-${i}`, title, content: `---\ntype: person\ntitle: ${title}\n---\n\n${title} works at [[${c(0)}]] as a ${ROLES[i % ROLES.length]} and advises [[${c(1)}]].\nPreviously at [[${c(2)}]], focused on ${w(i, 5)} and ${w(i, 6)}.\n\n- works_at [[${c(0)}]] (since 20${10 + (i % 14)})\n- Met [[people/person-${(i + 1) % Math.max(1, people)}]] about ${w(i, 7)}.\n\n## Timeline\n\n- **2021-0${1 + (i % 9)}-01** | Joined [[${c(0)}]] as ${ROLES[i % ROLES.length]}\n- **2019-0${1 + (i % 9)}-15** | Left [[${c(2)}]]\n` });
  }
  for (let i = 0; out.length < n; i++) {
    const title = `Note ${i} on ${w(i, 8)} ${w(i, 9)}`;
    out.push({ slug: `notes/note-${i}`, title, content: `---\ntype: note\ntitle: ${title}\n---\n\nNotes on ${w(i, 8)}, ${w(i, 9)} and ${w(i, 10)} for [[companies/company-${i % companies}]] with [[people/person-${i % Math.max(1, people)}]].\n\nThe ${w(i, 11)} review covered ${w(i, 12)} and ${w(i, 13)}; next step is ${w(i, 14)}.\n` });
  }
  return out;
}

/** The query set: exact titles, title words inside longer questions, and topic questions. */
export function queries(pages: Array<{ title: string }>, q: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < q; i++) {
    const page = pages[(i * 104729) % pages.length]!;
    switch (i % 3) {
      case 0: out.push(page.title); break;
      case 1: out.push(`what do we know about ${page.title.toLowerCase()} and its ${WORDS[i % WORDS.length]}`); break;
      default: out.push(`${WORDS[i % WORDS.length]} ${WORDS[(i * 3 + 1) % WORDS.length]} decisions`);
    }
  }
  return out;
}

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  // Nearest rank: the sample at rank ceil(p * N), which is index ceil(p * N) - 1, kept inside [0, N - 1].
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};
export const median = (xs: number[]) => pct(xs, 0.5);
export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
