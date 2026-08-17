/**
 * compile-view (cathedral-5 D3'): determinism by construction (double-run
 * byte identity, no wall-clock in the module source), total-order output
 * (score desc, slug asc — ties break on slug), strict budget cap (first
 * entry over budget ⇒ header-only comment; budget smaller than header ⇒
 * packToBudget never called), whole-output token assertion, digest
 * stability, scan-drop reporting, and read-error abort.
 */
import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  compileView,
  COMPILED_CONTEXT_ENVELOPE,
  RECENCY_CANDIDATE_LIMIT,
  type CompileViewEngine,
  type CompileViewInput,
} from '../src/core/context/compile-view.ts';
import { loadSensitivityConfig } from '../src/core/context/sensitivity-scan.ts';
import * as tokenBudget from '../src/core/search/token-budget.ts';
import type { Page, PageFilters, GetPageOpts } from '../src/core/types.ts';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function scanConfig() {
  tmp = mkdtempSync(join(tmpdir(), 'compile-view-'));
  return loadSensitivityConfig({
    workspaceRoot: tmp,
    blocklist: '',
    userPatternsPath: join(tmp, 'no-such-patterns.txt'),
  });
}

const T0 = new Date('2026-08-01T12:00:00.000Z');

function page(slug: string, over: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug,
    type: 'note' as Page['type'],
    title: over.title ?? `Title of ${slug}`,
    compiled_truth: over.compiled_truth ?? `A steady prose line about ${slug}. More detail follows.`,
    timeline: '',
    frontmatter: over.frontmatter ?? {},
    created_at: T0,
    updated_at: over.updated_at ?? T0,
    source_id: over.source_id ?? 'default',
    ...over,
  } as Page;
}

/** In-memory fixture engine honoring exactly the filters compile-view uses. */
function makeEngine(pages: Page[]): CompileViewEngine {
  return {
    async listPages(filters: PageFilters = {}) {
      let rows = pages.slice();
      if (filters.sourceId) rows = rows.filter((p) => p.source_id === filters.sourceId);
      if (filters.slugPrefix) rows = rows.filter((p) => p.slug.startsWith(filters.slugPrefix!));
      if (filters.tag) {
        rows = rows.filter((p) => {
          const tags = p.frontmatter?.tags;
          return Array.isArray(tags) && tags.includes(filters.tag);
        });
      }
      if (filters.updated_after) {
        const cut = new Date(filters.updated_after).getTime();
        rows = rows.filter((p) => new Date(p.updated_at).getTime() > cut);
      }
      const bySlug = (a: Page, b: Page) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
      if (filters.sort === 'slug') rows.sort(bySlug);
      else if (filters.sort === 'updated_asc') {
        rows.sort(
          (a, b) =>
            new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime() || bySlug(a, b),
        );
      } else {
        rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      }
      if (typeof filters.limit === 'number') rows = rows.slice(0, filters.limit);
      return rows;
    },
    async getPage(slug: string, opts?: GetPageOpts) {
      return (
        pages.find((p) => p.slug === slug && (!opts?.sourceId || p.source_id === opts.sourceId)) ??
        null
      );
    },
  };
}

function input(engine: CompileViewEngine, over: Partial<CompileViewInput> = {}): CompileViewInput {
  return {
    engine,
    sourceId: 'default',
    target: 'claude-code',
    budget: 4000,
    scanConfig: over.scanConfig ?? scanConfig(),
    ...over,
  };
}

const FIXTURE_PAGES = [
  page('concepts/alpha', { updated_at: new Date('2026-07-30T00:00:00.000Z') }),
  page('concepts/beta', { updated_at: new Date('2026-07-30T00:00:00.000Z') }),
  page('people/zed', { updated_at: new Date('2026-07-30T00:00:00.000Z') }),
  page('daily/2026-07-29', {
    updated_at: new Date('2026-07-29T00:00:00.000Z'),
    frontmatter: { tags: ['compile-context'] },
  }),
  page('originals/essay', { updated_at: new Date('2026-06-01T00:00:00.000Z') }),
];

describe('compileView — determinism', () => {
  test('double run on the same fixture engine yields identical bytes and meta', async () => {
    const engine = makeEngine(FIXTURE_PAGES);
    const cfg = scanConfig();
    const a = await compileView(input(engine, { scanConfig: cfg }));
    const b = await compileView(input(engine, { scanConfig: cfg }));
    expect(b.text).toBe(a.text);
    expect(b.meta).toEqual(a.meta);
  });

  test('module source contains no wall-clock (Date.now) — anchor is content-derived', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/core/context/compile-view.ts'),
      'utf-8',
    );
    expect(src.includes('Date.now')).toBe(false);
    expect(src).not.toMatch(/new Date\(\s*\)/); // argument-less construction is wall-clock too
  });

  test('empty brain compiles header-only, deterministically, without the no-fit comment', async () => {
    const engine = makeEngine([]);
    const cfg = scanConfig();
    const a = await compileView(input(engine, { scanConfig: cfg }));
    const b = await compileView(input(engine, { scanConfig: cfg }));
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('<!-- gbrain:compiled-context digest=sha256:');
    expect(a.text).toContain(COMPILED_CONTEXT_ENVELOPE);
    expect(a.text).not.toContain('no entries fit');
    expect(a.text).not.toContain('## ');
    expect(a.meta.entries_used).toBe(0);
  });
});

describe('compileView — ordering (score desc, slug asc)', () => {
  test('pin outranks everything; equal scores tie-break on slug asc; boosts order prefixes', async () => {
    const { text } = await compileView(input(makeEngine(FIXTURE_PAGES)));
    const headings = [...text.matchAll(/## .*\(brain:\/\/([^)]+)\)/g)].map((m) => m[1]);
    // daily/ is the lowest-boost page but tag-pinned ⇒ PIN_BONUS puts it first.
    expect(headings[0]).toBe('daily/2026-07-29');
    // concepts (1.3) at the same updated_at outrank people (1.2); slug asc within tie.
    expect(headings.slice(1, 4)).toEqual(['concepts/alpha', 'concepts/beta', 'people/zed']);
    // originals/ (1.5) is older — decay beats its boost here, lands last.
    expect(headings[4]).toBe('originals/essay');
  });
});

describe('compileView — budget strict cap', () => {
  test('whole-output token count never exceeds the budget when entries fit', async () => {
    const budget = 120;
    const { text, meta } = await compileView(input(makeEngine(FIXTURE_PAGES), { budget }));
    expect(tokenBudget.estimateTokens(text)).toBeLessThanOrEqual(budget);
    expect(meta.total_output_tokens).toBe(tokenBudget.estimateTokens(text));
    expect(meta.entries_used).toBeGreaterThan(0);
    expect(meta.dropped).toBeGreaterThan(0); // budget forced drops
  });

  test('first entry over budget ⇒ header-only + no-fit comment (strict, no salvage)', async () => {
    const budget = 60; // header fits; no single entry does
    const { text, meta } = await compileView(input(makeEngine(FIXTURE_PAGES), { budget }));
    expect(text).toContain(`<!-- no entries fit budget ${budget} -->`);
    expect(text).not.toContain('## ');
    expect(meta.entries_used).toBe(0);
    expect(meta.kept).toBe(0);
    expect(meta.dropped).toBe(5);
  });

  test('budget smaller than the header ⇒ header-only and packToBudget is NEVER called', async () => {
    const spy = spyOn(tokenBudget, 'packToBudget');
    try {
      const budget = 1; // entryBudget <= 0 — packToBudget would treat it as NO CAP
      const { text, meta } = await compileView(input(makeEngine(FIXTURE_PAGES), { budget }));
      expect(spy).not.toHaveBeenCalled();
      expect(text).toContain(`<!-- no entries fit budget ${budget} -->`);
      expect(text).not.toContain('## ');
      expect(meta.entries_used).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('compileView — digest', () => {
  const digestOf = (text: string) => text.match(/digest=sha256:([0-9a-f]{16})/)![1];

  test('digest is stable across runs on unchanged data', async () => {
    const engine = makeEngine(FIXTURE_PAGES);
    const cfg = scanConfig();
    const a = await compileView(input(engine, { scanConfig: cfg }));
    const b = await compileView(input(engine, { scanConfig: cfg }));
    expect(digestOf(a.text)).toBe(digestOf(b.text));
  });

  test('changing one page body changes the digest', async () => {
    const cfg = scanConfig();
    const a = await compileView(input(makeEngine(FIXTURE_PAGES), { scanConfig: cfg }));
    const changed = FIXTURE_PAGES.map((p) =>
      p.slug === 'concepts/alpha'
        ? page(p.slug, { ...p, compiled_truth: 'A different opening sentence entirely.' })
        : p,
    );
    const b = await compileView(input(makeEngine(changed), { scanConfig: cfg }));
    expect(digestOf(b.text)).not.toBe(digestOf(a.text));
  });
});

describe('compileView — sensitivity scan integration', () => {
  test('a scan hit drops the entry and reports {slug, family, fingerprint}', async () => {
    const dirty = [
      ...FIXTURE_PAGES,
      page('concepts/dirty', {
        updated_at: new Date('2026-07-31T00:00:00.000Z'),
        compiled_truth: 'Reach alice@example.com for the details.',
      }),
    ];
    const { text, meta } = await compileView(input(makeEngine(dirty)));
    expect(text).not.toContain('concepts/dirty');
    expect(text).not.toContain('alice@example.com');
    expect(meta.scan_drops).toHaveLength(1);
    expect(meta.scan_drops[0].slug).toBe('concepts/dirty');
    expect(meta.scan_drops[0].family).toBe('pii:email');
    expect(meta.scan_drops[0].fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    // Clean entries still compiled.
    expect(text).toContain('concepts/alpha');
  });
});

describe('compileView — recency arm (adversarial review: newest-first + tie-drop)', () => {
  test('a truncated recency window keeps the NEWEST pages; boundary-timestamp rows drop deterministically', async () => {
    // Non-durable-prefix, untagged pages: ONLY the recency arm can select
    // them. More pages than the limit forces truncation — the inverted
    // updated_asc fetch would have kept the OLDEST 500 and dropped the
    // newest pages entirely.
    const base = new Date('2026-07-01T00:00:00.000Z').getTime();
    const N = RECENCY_CANDIDATE_LIMIT + 10;
    const pages: ReturnType<typeof page>[] = [];
    for (let i = 0; i < N; i++) {
      pages.push(
        page(`notes/n-${String(i).padStart(4, '0')}`, {
          updated_at: new Date(base + i * 60_000),
        }),
      );
    }
    const { text } = await compileView(input(makeEngine(pages), { budget: 60_000 }));
    const pad = (i: number) => `notes/n-${String(i).padStart(4, '0')}`;
    // Newest page present; the 10 oldest fall outside the newest-first cut.
    expect(text).toContain(`brain://${pad(N - 1)}`);
    expect(text).not.toContain(`brain://${pad(0)}`);
    expect(text).not.toContain(`brain://${pad(9)}`);
    // The truncation-boundary timestamp row is dropped (tie-drop keeps the
    // survivor set well-defined regardless of DB tie order)...
    expect(text).not.toContain(`brain://${pad(10)}`);
    // ...and the first strictly-newer row survives.
    expect(text).toContain(`brain://${pad(11)}`);
  });
});

describe('compileView — source isolation + read errors', () => {
  test('duplicate slug across sources compiles the requested source body', async () => {
    const pages = [
      page('concepts/shared', {
        source_id: 'alpha-src',
        compiled_truth: 'Alpha source body sentence.',
      }),
      page('concepts/shared', {
        source_id: 'beta-src',
        compiled_truth: 'Beta source body sentence.',
      }),
    ];
    const { text } = await compileView(input(makeEngine(pages), { sourceId: 'beta-src' }));
    expect(text).toContain('Beta source body sentence.');
    expect(text).not.toContain('Alpha source body sentence.');
  });

  test('engine read error mid-run throws — never emits partial output', async () => {
    const engine = makeEngine(FIXTURE_PAGES);
    const broken: CompileViewEngine = {
      listPages: engine.listPages.bind(engine),
      getPage: async () => {
        throw new Error('boom: connection lost');
      },
    };
    await expect(compileView(input(broken))).rejects.toThrow('boom');
  });

  test('a page that vanishes between select and body read throws (raced deletion)', async () => {
    const engine = makeEngine(FIXTURE_PAGES);
    const vanishing: CompileViewEngine = {
      listPages: engine.listPages.bind(engine),
      getPage: async () => null,
    };
    await expect(compileView(input(vanishing))).rejects.toThrow('vanished');
  });
});
