/**
 * Result-time collapse through bare hybridSearch on PGLite (#4612, #7153,
 * #7154): twins in another source, redirect stubs and copies of one document
 * take one slot, the folded pages stay named in `collapsed`, and pages that
 * only look alike (templated notes, a person and a company sharing a slug
 * leaf) keep their own slots. `search.collapse false` reproduces the
 * pre-collapse output, which is the failure shape each case pins.
 * Hermetic: a hash bag-of-words embedder through `queryEmbedFn`; network off.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { type CollapseDecision, collapseResults, prefetchPageFacts, redirectTargetSlug } from '../../src/core/search/collapse.ts';
import { fnv1a } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

const DIM = 1536;
function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const h = fnv1a(tok);
    v[Math.abs(h) % DIM] += (h & 1) === 0 ? 1 : -1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

const OPS_DETAIL = 'We walked through incident counts, on-call load, the depot dashboard and budget variance for each team in detail. '.repeat(8);
const LONG = (topic: string) => `${topic} memo. ` + 'The team reviewed the quarterly plan, the hiring targets and the vendor shortlist, then agreed on owners and dates. '.repeat(4);

interface Seed { slug: string; source?: string; type: string; title: string; body: string; frontmatter?: Record<string, unknown>; date?: string; chunks?: string[] }
const SEEDS: Seed[] = [
  // twins: the same slug in two sources
  { slug: 'concepts/zephyr-ledger', type: 'concept', title: 'Zephyr ledger', body: 'Zephyr ledger: the shared accounting ledger for the zephyr program, reconciled weekly by finance against vendor invoices and payroll exports.' },
  { slug: 'concepts/zephyr-ledger', source: 'team-example', type: 'concept', title: 'Zephyr ledger', body: 'Zephyr ledger: the shared accounting ledger for the zephyr program, reconciled weekly by finance against vendor invoices and payroll exports. Mirrored copy.' },
  // the same slug in two sources, different documents: both keep their slots
  { slug: 'notes/roadmap', type: 'note', title: 'Roadmap', body: 'Roadmap: ship the harbor scheduling app, migrate depot payroll, hire two drivers, retire the paper rota in spring.' },
  { slug: 'notes/roadmap', source: 'team-example', type: 'note', title: 'Roadmap', body: 'Roadmap: launch the bakery loyalty card, renovate the oven room, open a weekend stall at the farmers market.' },
  // a redirect stub (frontmatter redirect_to with a leading slash, markdown link body) whose target is in the pool
  { slug: 'concepts/zephyr-ledger-old', type: 'concept-redirect', title: 'Zephyr ledger', body: 'Zephyr ledger. See [Zephyr ledger](/concepts/zephyr-ledger).', frontmatter: { redirect_to: '/concepts/zephyr-ledger' } },
  // a redirect stub whose target never matches the query: it is read in
  { slug: 'concepts/quill-roster-old', type: 'concept', title: 'Quill roster', body: 'This page has been merged into [[people/bram-example]].' },
  { slug: 'people/bram-example', type: 'person', title: 'Bram Example', body: 'Bram Example runs the night shift scheduling for the harbor depot.' },
  // a bare-word redirect that names two pages: ambiguous, so the stub stays and says where it points
  { slug: 'concepts/kestrel-plan-old', type: 'concept-redirect', title: 'Kestrel plan', body: 'Kestrel plan moved.', frontmatter: { redirect_to: 'kestrel' } },
  { slug: 'projects/kestrel', type: 'project', title: 'Kestrel', body: 'Kestrel project overview.' },
  { slug: 'notes/kestrel', type: 'note', title: 'Kestrel', body: 'Kestrel note.' },
  // a document family by derivative suffix
  { slug: 'media/orbit-talk', type: 'media', title: 'Orbit talk', body: 'Orbit talk verbatim: orbit launch cadence, orbit telemetry downlinks, ground station staffing, propellant margins and the orbit budget review.' },
  { slug: 'media/orbit-talk-summary', type: 'media', title: 'Orbit talk summary', body: 'Orbit talk summary: launch cadence, telemetry downlinks, ground station staffing, propellant margins, budget for orbit.' },
  { slug: 'media/orbit-talk-transcript', type: 'media', title: 'Orbit talk transcript', body: 'Orbit talk transcript, diarized: orbit launch cadence, orbit telemetry downlinks, ground station staffing and propellant margins.' },
  // a derivative suffix in another directory with another document: separate
  { slug: 'project-a/quarterly-plan', type: 'note', title: 'Quarterly plan', body: 'Quarterly plan for project A: kiln upgrade, glaze supplier audit, studio rent renewal, pottery class schedule.' },
  { slug: 'project-b/quarterly-plan-summary', type: 'note', title: 'Quarterly plan summary', body: 'Quarterly plan summary for project B: drone permits, battery procurement, survey contracts, pilot training.' },
  // real content that mentions a merge is not a redirect stub
  { slug: 'meetings/2026-04-01-ops-review', type: 'meeting', title: 'Ops review', body: 'Ops review. The old service was merged into [[concepts/zephyr-ledger]]. ' + OPS_DETAIL, chunks: ['Ops review. The old service was merged into [[concepts/zephyr-ledger]].', OPS_DETAIL] },
  { slug: 'notes/orbit-answer', type: 'note', title: 'Orbit answer', body: 'Orbit answer: the orbit launch cadence is every six weeks.' },
  // identical bodies under two types
  { slug: 'concepts/heron-memo', type: 'concept', title: 'Heron memo', body: LONG('Heron') },
  { slug: 'notes/heron-memo', type: 'note', title: 'Heron memo', body: LONG('Heron') },
  // a meeting and its transcript: one leaf extends the other on the same date
  { slug: 'meetings/2026-03-02-lumen-sync', type: 'meeting', title: 'Lumen sync', body: 'Lumen sync notes: lumen pricing decision, lumen rollout order, partner onboarding, support staffing and the launch checklist.', date: '2026-03-02' },
  { slug: 'transcripts/2026-03-02-lumen-sync-call', type: 'transcript', title: 'Lumen sync call', body: 'Lumen sync call transcript: lumen pricing decision discussed, lumen rollout order, partner onboarding, support staffing, launch checklist.', date: '2026-03-02' },
  // a private page a bare-word redirect would resolve to
  { slug: 'private-area/osprey', type: 'note', title: 'Osprey', body: 'Osprey private planning notes.', frontmatter: { visibility: 'private' } },
  { slug: 'concepts/osprey-old', type: 'concept-redirect', title: 'Osprey plan', body: 'Osprey plan moved.', frontmatter: { redirect_to: 'osprey' } },
  // look-alikes that must keep their own slots
  ...[1, 2, 3].map(i => ({ slug: `notes/standup-${i}`, type: 'note', title: `Standup ${i}`, body: `Standup ${i}: blockers none. ` + 'Yesterday we shipped the badge reader fix and today we test the badge reader. '.repeat(4) })),
  { slug: 'people/nimbus-example', type: 'person', title: 'Nimbus Example', body: 'Nimbus Example founded the nimbus weather service.' },
  { slug: 'companies/nimbus-example', type: 'company', title: 'Nimbus Example', body: 'Nimbus Example is the nimbus weather service company.' },
];

let engine: PGLiteEngine;
const realFetch = globalThis.fetch;
const search = async (q: string, extra: Record<string, unknown> = {}) => {
  let meta: HybridSearchMeta | null = null;
  const rows = await hybridSearch(engine, q, { limit: 20, queryEmbedFn: hashEmbed, onMeta: m => { meta = m; }, ...extra });
  return { rows, meta: meta as HybridSearchMeta | null };
};
const keys = (rows: SearchResult[]) => [...new Set(rows.map(r => `${r.source_id}:${r.slug}`))];
const row = (rows: SearchResult[], slug: string) => rows.find(r => r.slug === slug);

beforeAll(async () => {
  globalThis.fetch = (async () => { throw new Error('collapse test: network disabled'); }) as unknown as typeof fetch;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-example', 'team-example') ON CONFLICT (id) DO NOTHING`);
  for (const s of SEEDS) {
    const sourceId = s.source ?? 'default';
    await engine.putPage(s.slug, { type: s.type, title: s.title, compiled_truth: s.body, ...(s.frontmatter ? { frontmatter: s.frontmatter } : {}) }, { sourceId });
    await installFixtureChunks(engine, s.slug, (s.chunks ?? [s.body]).map((text, i) => ({ chunk_index: i, chunk_text: text, chunk_source: 'compiled_truth' as const, embedding: hashEmbed(text), token_count: text.split(/\s+/).length })), { sourceId });
    if (s.date) await engine.executeRaw(`UPDATE pages SET effective_date = $1::date, effective_date_source = 'date' WHERE slug = $2 AND source_id = $3`, [s.date, s.slug, sourceId]);
  }
}, 120_000);

afterEach(async () => { await engine.unsetConfig('search.collapse'); });
afterAll(async () => {
  globalThis.fetch = realFetch;
  await engine.disconnect();
});

describe('redirectTargetSlug', () => {
  test('wikilinks, markdown links, leading slashes, .md and anchors all name the slug', () => {
    expect(redirectTargetSlug('[[people/x|X]]')).toBe('people/x');
    expect(redirectTargetSlug('[X](/companies/x.md#top)')).toBe('companies/x');
    expect(redirectTargetSlug('/concepts/y')).toBe('concepts/y');
    expect(redirectTargetSlug('kestrel')).toBe('kestrel');
    expect(redirectTargetSlug('https://example.com/a')).toBeNull();
    expect(redirectTargetSlug('  ')).toBeNull();
  });
});

describe('twins and redirect stubs', () => {
  test('off: the twin and the stub each take a slot (the failure shape)', async () => {
    await engine.setConfig('search.collapse', 'false');
    const { rows } = await search('zephyr ledger');
    const zephyr = keys(rows).filter(k => k.includes('zephyr-ledger'));
    expect(zephyr).toEqual(expect.arrayContaining(['default:concepts/zephyr-ledger', 'team-example:concepts/zephyr-ledger', 'default:concepts/zephyr-ledger-old']));
  });

  test('on: one slot, the twin and the stub listed on it', async () => {
    const { rows, meta } = await search('zephyr ledger');
    const zephyr = keys(rows).filter(k => k.includes('zephyr-ledger'));
    expect(zephyr).toHaveLength(1);
    const kept = rows.find(r => r.slug === 'concepts/zephyr-ledger')!;
    expect(kept.collapsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'concepts/zephyr-ledger-old', source_id: 'default', reason: 'redirect' }),
      expect.objectContaining({ slug: 'concepts/zephyr-ledger', reason: 'twin' }),
    ]));
    expect(meta?.collapse?.twins).toBeGreaterThanOrEqual(1);
    expect(meta?.collapse?.redirects).toBeGreaterThanOrEqual(1);
  });

  test('a stub whose target the pool lacks returns the target in its slot', async () => {
    await engine.setConfig('search.collapse', 'false');
    const { rows } = await search('quill roster', { limit: 50 });
    const stub = row(rows, 'concepts/quill-roster-old')!;
    const other = row(rows, 'notes/orbit-answer')!;
    const decisions: CollapseDecision[] = [];
    const out = await collapseResults(engine, [{ ...stub, collapsed: undefined }, other], { onDecision: d => decisions.push(d) });
    expect(out.map(r => r.slug)).toEqual(['people/bram-example', 'notes/orbit-answer']);
    expect(out[0]).toMatchObject({ source_id: 'default', score: stub.score, collapsed: [{ slug: 'concepts/quill-roster-old', source_id: 'default', reason: 'redirect' }] });
    expect(out[0].chunk_text).toContain('night shift');
    expect(decisions).toEqual([{ twins: 0, redirects: 1, families: 0, redirect_reads: 1 }]);
    const scoped = await collapseResults(engine, [{ ...stub, collapsed: undefined }, other], { sourceIds: ['team-example'] });
    expect(scoped[0]).toMatchObject({ slug: 'concepts/quill-roster-old', redirect_to: 'people/bram-example' });
  });

  test('a read-in target honors the exclude contract: the stub stays, stamped redirect_to', async () => {
    const { rows } = await search('quill roster', { exclude_slug_prefixes: ['people/'] });
    expect(row(rows, 'people/bram-example')).toBeUndefined();
    expect(row(rows, 'concepts/quill-roster-old')?.redirect_to).toBe('people/bram-example');
  });

  test('an ambiguous bare-word target leaves the stub with redirect_to', async () => {
    const { rows } = await search('kestrel plan');
    expect(row(rows, 'concepts/kestrel-plan-old')?.redirect_to).toBe('kestrel');
  });
});

describe('document families', () => {
  test('derivative suffixes fold into the best-ranked copy; the answer page keeps its slot', async () => {
    await engine.setConfig('search.collapse', 'false');
    const off = await search('orbit talk launch cadence telemetry');
    expect(keys(off.rows).filter(k => k.includes('orbit-talk'))).toHaveLength(3);
    await engine.unsetConfig('search.collapse');
    const { rows } = await search('orbit talk launch cadence telemetry');
    const family = rows.filter(r => r.slug.startsWith('media/orbit-talk'));
    expect(family).toHaveLength(1);
    expect(family[0].collapsed?.map(c => c.reason)).toEqual(['family', 'family']);
    expect(row(rows, 'notes/orbit-answer')).toBeDefined();
  });

  test('identical bodies under two types fold', async () => {
    const { rows } = await search('heron memo quarterly plan');
    expect(rows.filter(r => r.slug.endsWith('/heron-memo'))).toHaveLength(1);
  });

  test('a meeting and its same-day transcript fold', async () => {
    const { rows } = await search('lumen sync pricing decision rollout');
    expect(rows.filter(r => r.slug.includes('lumen-sync'))).toHaveLength(1);
  });

  test('templated notes and a person and company sharing a leaf keep their own slots', async () => {
    const standups = await search('standup badge reader');
    expect(keys(standups.rows).filter(k => k.includes('standup-'))).toHaveLength(3);
    const nimbus = await search('nimbus weather service');
    expect(row(nimbus.rows, 'people/nimbus-example')).toBeDefined();
    expect(row(nimbus.rows, 'companies/nimbus-example')).toBeDefined();
  });
});

describe('look-alikes the review found (no false folds, no private slug)', () => {
  test('the same slug in two sources with different bodies keeps both slots', async () => {
    const { rows } = await search('roadmap');
    expect(keys(rows).filter(k => k.endsWith(':notes/roadmap'))).toHaveLength(2);
  });

  test('a derivative-suffixed slug in another directory with another document keeps its slot', async () => {
    const { rows } = await search('quarterly plan');
    expect(row(rows, 'project-a/quarterly-plan')).toBeDefined();
    expect(row(rows, 'project-b/quarterly-plan-summary')).toBeDefined();
  });

  test('a long page that mentions a merge keeps its slot and is not stamped a redirect', async () => {
    const { rows } = await search('ops review old service merged');
    const ops = row(rows, 'meetings/2026-04-01-ops-review');
    expect(ops).toBeDefined();
    expect(ops!.redirect_to).toBeUndefined();
  });

  test('a bare-word redirect that resolves to a private page names only what the stub wrote', async () => {
    const { rows } = await search('osprey plan', { excludePrivate: true });
    const stub = row(rows, 'concepts/osprey-old');
    expect(stub?.redirect_to).toBe('osprey');
    expect(JSON.stringify(rows)).not.toContain('private-area/osprey');
  });

  test('a single stub row still resolves to its target', async () => {
    await engine.setConfig('search.collapse', 'false');
    const { rows } = await search('quill roster', { limit: 50 });
    const stub = row(rows, 'concepts/quill-roster-old')!;
    const out = await collapseResults(engine, [{ ...stub, collapsed: undefined }]);
    expect(out.map(r => r.slug)).toEqual(['people/bram-example']);
  });
});

describe('GBRA-156: page facts read ahead of the collapse', () => {
  const factReads = (sent: string[]) => sent.filter(sql => sql.includes("frontmatter->>'redirect_to'")).length;
  const recording = (sent: string[]) => new Proxy(engine, {
    get(target, key, receiver) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[]) => { sent.push(sql); return target.executeRaw(sql, params); };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PGLiteEngine;

  test('a prefetch over every page (more than the collapse reads) gives the same rows and the collapse reads no facts itself', async () => {
    await engine.setConfig('search.collapse', 'false');
    const allIds = (await engine.executeRaw<{ id: number }>('SELECT id FROM pages')).map(r => Number(r.id));
    for (const q of ['zephyr ledger', 'orbit talk', 'heron memo', 'lumen sync', 'kestrel plan', 'standup badge reader', 'quill roster']) {
      const { rows } = await search(q);
      const plain: string[] = [];
      const ahead: string[] = [];
      const before = await collapseResults(recording(plain), rows.map(r => ({ ...r })), {});
      const after = await collapseResults(recording(ahead), rows.map(r => ({ ...r })), { prefetched: prefetchPageFacts(engine, allIds) });
      expect({ q, rows: after }).toEqual({ q, rows: before });
      expect({ q, reads: factReads(plain) }).toEqual({ q, reads: 1 });
      expect({ q, reads: factReads(ahead) }).toEqual({ q, reads: 0 });
    }
  });

  test('pages the prefetch does not cover are read as before, and a failed prefetch falls back to the collapse\'s own read', async () => {
    await engine.setConfig('search.collapse', 'false');
    const { rows } = await search('zephyr ledger');
    const expected = await collapseResults(engine, rows.map(r => ({ ...r })), {});
    const sent: string[] = [];
    const partial = await collapseResults(recording(sent), rows.map(r => ({ ...r })), { prefetched: prefetchPageFacts(engine, [rows[0]!.page_id]) });
    expect(partial).toEqual(expected);
    expect(factReads(sent)).toBe(1);
    const failed = await collapseResults(engine, rows.map(r => ({ ...r })), { prefetched: Promise.resolve(null) });
    expect(failed).toEqual(expected);
  });
});
