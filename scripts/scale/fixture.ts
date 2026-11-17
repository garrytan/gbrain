/**
 * Deterministic synthetic brain for the scale harness (`bun run test:scale`,
 * docs/TESTING.md "Scale tier"). Same seed and page count always produce the
 * same pages, links, fences, vectors and known answers, so a report can be
 * reproduced from its printed seed. No provider calls.
 *
 * Two sources: `default` and `scale-b`. About a third of `scale-b` bodies copy
 * a `default` body (partly overlapping corpora). Each page links to three
 * pages of its own source, carries two dated timeline bullets and a unique
 * search token. A few island pages have no links in or out (known orphans).
 * Every tenth page (a person) carries a `## Facts` and a `## Takes` fence with
 * two rows each. Each page has a deterministic query vector
 * (`scaleVector`) that the harness writes onto its chunks and injects through
 * `queryEmbedFn`, so the vector arm runs keylessly.
 */
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { renderTakesFence, type ParsedTake } from '../../src/core/takes-fence.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ScalePage {
  sourceId: string;
  slug: string;
  content: string;
  token: string;
  links: string[];
  /** Global position; drives `scaleVector`. */
  index: number;
  facts: number;
  takes: number;
}
export interface ScaleWriter { slug: string; requestId: string; content: string }
export interface ScaleFixture {
  seed: number;
  pages: ScalePage[];
  /** Island pages: no inbound or outbound links. */
  islands: string[];
  /** A `default` page with outbound links, for traversal and backlink queries. */
  hub: string;
  /** Vector-arm probe: a query text no keyword matches, embedded as the target page's vector. */
  vectorProbe: { query: string; sourceId: string; slug: string; index: number };
  /** Source-scoped grant probe: a caller allowed only `allowed` must see `visible` and never `hidden`. */
  grant: { allowed: string; visible: { sourceId: string; slug: string; token: string }; hidden: { sourceId: string; slug: string; token: string } };
  /** Two receipt-bearing put_page writers with distinct request ids. */
  writers: [ScaleWriter, ScaleWriter];
  expected: { facts: number; takes: number };
}

export const SCALE_SOURCES = ['default', 'scale-b'] as const;
const WORDS = ['ledger', 'harbor', 'quartz', 'meadow', 'signal', 'lantern', 'orbit', 'canvas', 'summit', 'thicket', 'ember', 'falcon',
  'garnet', 'hollow', 'island', 'juniper', 'kestrel', 'linden', 'marble', 'nectar', 'oracle', 'pepper', 'quiver', 'russet'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kindFor(i: number): 'people' | 'companies' | 'notes' {
  const r = i % 10;
  return r < 2 ? 'people' : r < 3 ? 'companies' : 'notes';
}

/** Dimensions a scale vector occupies: a low intrinsic dimension an HNSW graph can navigate. */
export const SCALE_VECTOR_DIMS = 16;

/**
 * Page `index`'s vector: a seeded random unit vector in the first
 * SCALE_VECTOR_DIMS dimensions, zero elsewhere. Distinct per index, so the
 * target page is the only chunk at cosine 1. Dense on purpose: with sparse
 * two-hot vectors almost every pair sits at the same distance, so an HNSW
 * search has no gradient to follow and misses the target in most index builds.
 */
export function scaleVector(index: number, dim: number): Float32Array {
  const rand = mulberry32(Math.imul(index + 1, 0x9e3779b1));
  const k = Math.min(SCALE_VECTOR_DIMS, dim);
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < k; i++) {
    v[i] = rand() * 2 - 1;
    norm += v[i]! * v[i]!;
  }
  for (let i = 0; i < k; i++) v[i] = v[i]! / Math.sqrt(norm);
  return v;
}

function uuidFrom(rand: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  hex[12] = '4';
  hex[16] = (8 + Math.floor(rand() * 4)).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function fences(s: number, i: number): string[] {
  const facts = renderFactsTable([1, 2].map(rowNum => ({
    rowNum, claim: `Scale fact ${rowNum} for page ${s}-${i}`, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    validFrom: '2025-01-01', source: 'scale-fixture', active: true,
  } satisfies ParsedFact)));
  const takes = renderTakesFence([1, 2].map(rowNum => ({
    rowNum, claim: `Scale take ${rowNum} for page ${s}-${i}`, kind: 'take', holder: 'brain', weight: 0.5, sinceDate: '2025-01', source: 'scale-fixture', active: true,
  } satisfies ParsedTake)));
  return ['## Facts', '', facts, '', '## Takes', '', takes, ''];
}

export function generateScaleFixture(opts: { pages: number; seed: number }): ScaleFixture {
  if (!Number.isInteger(opts.pages) || opts.pages < 20) throw new Error('scale fixture needs at least 20 pages');
  const rand = mulberry32(opts.seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const perSource = [Math.ceil(opts.pages / 2), Math.floor(opts.pages / 2)];
  const slugsBySource = SCALE_SOURCES.map((_, s) => Array.from({ length: perSource[s]! }, (_, i) => `${kindFor(i)}/scale-${s}-${i}`));
  const islandEvery = 97;
  const isIsland = (i: number) => i % islandEvery === islandEvery - 1;
  const pages: ScalePage[] = [];
  const defaultBodies: string[] = [];
  for (const [s, sourceId] of SCALE_SOURCES.entries()) {
    const slugs = slugsBySource[s]!;
    const linkable = slugs.filter((_, i) => !isIsland(i));
    for (const [i, slug] of slugs.entries()) {
      const token = `scaletok${s}x${i}`;
      const links = isIsland(i) ? [] : Array.from({ length: 3 }, () => pick(linkable)).filter(target => target !== slug);
      const reuse = s === 1 && i % 3 === 0 && defaultBodies.length > 0;
      const prose = reuse ? defaultBodies[i % defaultBodies.length]!
        : Array.from({ length: 3 }, () => Array.from({ length: 24 }, () => pick(WORDS)).join(' ') + '.').join('\n\n');
      if (s === 0) defaultBodies.push(prose);
      const month = String(1 + Math.floor(rand() * 12)).padStart(2, '0');
      const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
      const fenced = i % 10 === 0;
      const content = [
        '---', `title: Scale ${s} ${i}`, `type: ${kindFor(i) === 'people' ? 'person' : kindFor(i) === 'companies' ? 'company' : 'note'}`, '---',
        `# Scale ${s} ${i}`, '', `${prose} Marker ${token}.`, '',
        ...links.map(target => `See [[${target}]].`), '',
        ...(fenced ? fences(s, i) : []),
        '## Timeline', '', `- **2025-${month}-${day}** | Scale event ${i} recorded`, `- **2026-${month}-${day}** | Scale follow-up ${i}`, '',
      ].join('\n');
      pages.push({ sourceId, slug, content, token, links, index: pages.length, facts: fenced ? 2 : 0, takes: fenced ? 2 : 0 });
    }
  }
  const islands = pages.filter(p => p.sourceId === 'default' && p.links.length === 0
    && !pages.some(other => other.sourceId === 'default' && other.links.includes(p.slug))).map(p => p.slug);
  const hub = pages.find(p => p.sourceId === 'default' && p.links.length === 3)!.slug;
  const target = pages[Math.floor(pages.length * 2 / 3)]!;
  const visible = pages.find(p => p.sourceId === 'scale-b' && p.index % 3 !== 0)!;
  const hidden = pages.find(p => p.sourceId === 'default' && p.index > 0)!;
  const writer = (n: number): ScaleWriter => ({
    slug: `notes/scale-writer-${n}`,
    requestId: uuidFrom(rand),
    content: ['---', `title: Scale writer ${n}`, 'type: note', '---', '', `Concurrent receipt-bearing write ${n} for seed ${opts.seed}.`, ''].join('\n'),
  });
  return {
    seed: opts.seed, pages, islands, hub,
    vectorProbe: { query: `zzvectorprobe${opts.seed}`, sourceId: target.sourceId, slug: target.slug, index: target.index },
    grant: { allowed: 'scale-b', visible: { sourceId: visible.sourceId, slug: visible.slug, token: visible.token },
      hidden: { sourceId: hidden.sourceId, slug: hidden.slug, token: hidden.token } },
    writers: [writer(0), writer(1)],
    expected: { facts: pages.reduce((n, p) => n + p.facts, 0), takes: pages.reduce((n, p) => n + p.takes, 0) },
  };
}

/** Bump when the on-disk corpus layout changes, so a cached corpus is rewritten. */
const CORPUS_LAYOUT = 1;

/**
 * Write the fixture as Markdown under `<dir>/<source>/<slug>.md` for the real
 * `foresights import` path, once: a corpus whose manifest matches seed, page
 * count and content digest is reused (CI caches only this directory).
 * Returns whether the corpus was (re)written.
 */
/** Markdown files under one source's corpus directory, relative to it. */
export function corpusMarkdownFiles(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  return (readdirSync(sourceDir, { recursive: true }) as string[]).filter(f => f.endsWith('.md'));
}

function corpusFilesMatch(fixture: ScaleFixture, dir: string): boolean {
  for (const sourceId of SCALE_SOURCES) {
    if (corpusMarkdownFiles(join(dir, sourceId)).length !== fixture.pages.filter(p => p.sourceId === sourceId).length) return false;
  }
  return fixture.pages.every(p => {
    const file = join(dir, p.sourceId, `${p.slug}.md`);
    return existsSync(file) && readFileSync(file, 'utf8') === p.content;
  });
}

export function writeScaleCorpus(fixture: ScaleFixture, dir: string): boolean {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const p of fixture.pages) hasher.update(`${p.sourceId}\0${p.slug}\0${p.content}\0`);
  const manifest = { layout: CORPUS_LAYOUT, seed: fixture.seed, pages: fixture.pages.length, sha256: hasher.digest('hex') };
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      // The manifest alone proves nothing (a cache restored from a partial run, files deleted by hand):
      // reuse only when every page file is present with its exact content and nothing else is there.
      if (JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) === JSON.stringify(manifest) && corpusFilesMatch(fixture, dir)) return false;
    } catch { /* unreadable manifest: rewrite the corpus */ }
  }
  for (const sourceId of SCALE_SOURCES) rmSync(join(dir, sourceId), { recursive: true, force: true });
  for (const p of fixture.pages) {
    const file = join(dir, p.sourceId, `${p.slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, p.content);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
  return true;
}
