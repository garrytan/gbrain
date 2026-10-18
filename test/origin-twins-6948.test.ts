/**
 * #6948: duplicate-origin twins. `decideOriginTwins` (the one rule discovery, the sync-time heal and
 * `gbrain repair origin-twins` share) over every pathological group shape, and the merge primitive
 * (`mergeTwinInto`, `twinMergeConflicts`) on a real database: what moves to the survivor, what is deduplicated, and
 * the distinct evidence that refuses the merge before any write. PGLite and, with DATABASE_URL, Postgres.
 * Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { decideOriginTwins, readOriginClaimants, type OriginClaimant } from '../src/core/persistence/origin-twins.ts';
import { mergeTwinInto, twinMergeConflicts } from '../src/core/persistence/twin-merge.ts';
import { syncOriginPath } from '../src/core/persistence/sync-origin.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';

const page = (id: number, slug: string, over: Partial<OriginClaimant> = {}): OriginClaimant =>
  ({ id, slug, revision: '1', body_hash: 'same', fm_id: null, private: false, restricted: false, trust_tier: 'owner', ...over });
const decide = (sourcePath: string, claimants: OriginClaimant[], fileId: string | null | undefined = null, occupied: string[] = []) =>
  decideOriginTwins({ sourcePath, claimants, fileId, slugPathOccupied: slug => occupied.includes(slug) });
const reason = (v: ReturnType<typeof decide>) => v.verdict === 'hold' ? v.reason : 'resolve';

describe('#6948 decideOriginTwins: every pathological group', () => {
  test('two verified duplicates resolve: the page the path names survives, the other is its twin', () => {
    const v = decide('notes/note-example.md', [page(7, 'notes/note-example-copy'), page(3, 'notes/note-example')]);
    expect(v).toMatchObject({ verdict: 'resolve', canonical: 'notes/note-example', survivor: { id: 3 } });
    expect(v.verdict === 'resolve' && v.twins.map(t => t.id)).toEqual([7]);
  });
  test('three and more live claimants resolve together when all are duplicates, and hold together when one differs', () => {
    const three = [page(1, 'notes/note-example'), page(2, 'notes/note-example-2'), page(3, 'notes/note-example-3'), page(4, 'archive/note-example')];
    const v = decide('notes/note-example.md', three);
    expect(v.verdict === 'resolve' && v.twins.map(t => t.id)).toEqual([2, 3, 4]);
    expect(reason(decide('notes/note-example.md', [...three.slice(0, 3), page(4, 'archive/note-example', { body_hash: 'other' })]))).toBe('content_differs');
  });
  test('canonical ties: no claimant is the page the path names, or the same slug twice, hold no_canonical_claimant', () => {
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/a'), page(2, 'notes/b')]))).toBe('no_canonical_claimant');
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example'), page(2, 'notes/note-example')]))).toBe('no_canonical_claimant');
  });
  test('claimants differing in content hold content_differs, and a body that cannot be read (segmented) never matches', () => {
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example'), page(2, 'x/y', { body_hash: 'other' })]))).toBe('content_differs');
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example', { body_hash: null }), page(2, 'x/y', { body_hash: null })]))).toBe('content_differs');
  });
  test('claimants (or the file) carrying different frontmatter ids hold explicit_id_conflict; one shared id resolves', () => {
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example', { fm_id: 'id-a' }), page(2, 'x/y', { fm_id: 'id-b' })]))).toBe('explicit_id_conflict');
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example'), page(2, 'x/y')], 'id-file'))).toBe('resolve');
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example', { fm_id: 'id-a' }), page(2, 'x/y')], 'id-b'))).toBe('explicit_id_conflict');
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example', { fm_id: 'id-a' }), page(2, 'x/y', { fm_id: 'id-a' })], 'id-a'))).toBe('resolve');
  });
  test('missing evidence never counts as agreement: an unreadable file holds file_unreadable', () => {
    expect(reason(decideOriginTwins({ sourcePath: 'notes/note-example.md', claimants: [page(1, 'notes/note-example'), page(2, 'x/y')], fileId: undefined }))).toBe('file_unreadable');
  });
  test('visibility, trust tier, slug-keyed withdrawals and a file at a twin\'s own slug path each hold', () => {
    const pair = (over: Partial<OriginClaimant>) => [page(1, 'notes/note-example'), page(2, 'x/y', over)];
    expect(reason(decide('notes/note-example.md', pair({ private: true })))).toBe('visibility_differs');
    expect(reason(decide('notes/note-example.md', pair({ trust_tier: 'untrusted' })))).toBe('trust_tier_differs');
    expect(reason(decide('notes/note-example.md', [page(1, 'notes/note-example', { trust_tier: 'untrusted' }), page(2, 'x/y')]))).toBe('trust_tier_differs');
    expect(reason(decide('notes/note-example.md', pair({ restricted: true })))).toBe('twin_has_withdrawals');
    expect(reason(decide('notes/note-example.md', pair({}), null, ['x/y']))).toBe('twin_slug_path_occupied');
  });
  test('path spellings: case and Unicode normalization fold to one canonical page; ./ and a trailing slash are not stored origins', () => {
    const pair = [page(1, 'notes/note-example'), page(2, 'x/y')];
    expect(decide('Notes/Note-Example.md', pair)).toMatchObject({ verdict: 'resolve', canonical: 'notes/note-example' });
    const cafe = [page(1, 'notes/cafe'), page(2, 'x/y')];
    expect(decide('notes/cafe\u0301.md', cafe)).toMatchObject({ verdict: 'resolve', canonical: 'notes/cafe' });
    expect(decide('notes/caf\u00e9.md', cafe)).toMatchObject({ verdict: 'resolve', canonical: 'notes/cafe' });
    expect(decide('./notes/note-example.md', pair)).toMatchObject({ verdict: 'resolve', canonical: 'notes/note-example' });
    // A trailing slash names no Markdown file: no claimant is its page, so a person decides.
    expect(reason(decide('notes/note-example.md/', pair))).toBe('no_canonical_claimant');
    for (const spelled of ['./notes/note-example.md', 'notes/note-example.md/', 'notes//note-example.md']) expect(() => syncOriginPath(spelled)).toThrow();
  });
});

for (const backend of testBackends()) describe(`[${backend}] #6948 mergeTwinInto and twinMergeConflicts`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const sourceId = 'default';
  const write = <T>(fn: (tx: BrainEngine) => Promise<T>) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
  const id = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id);
  async function put(slug: string, opts: { body?: string; sourcePath?: string | null; frontmatter?: Record<string, unknown> } = {}) {
    // Twins are legacy data: no writer records a held origin on a second page (#6948), so the origin is set directly.
    await write(async tx => {
      await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: opts.body ?? 'One shared body.', timeline: '', frontmatter: opts.frontmatter ?? {},
        content_hash: randomUUID() }, { sourceId });
      if (opts.sourcePath) await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [sourceId, slug, opts.sourcePath]);
    });
    return id(slug);
  }
  /** A survivor and a twin recording one origin with one body, and a third page. */
  async function trio() {
    const tag = randomUUID().slice(0, 8);
    const origin = `notes/note-${tag}.md`;
    const survivor = await put(`notes/note-${tag}`, { sourcePath: origin });
    const twin = await put(`notes/note-${tag}-copy`, { sourcePath: origin });
    const third = await put(`people/alice-example-${tag}`, { body: 'Alice, a person.' });
    return { tag, origin, survivor: { page_id: survivor, slug: `notes/note-${tag}` }, twin: { page_id: twin, slug: `notes/note-${tag}-copy` }, third };
  }
  const link = (from: number, to: number, type: string, source: string | null, context = '', origin: number | null = null) =>
    write(tx => tx.executeRaw('INSERT INTO links (from_page_id,to_page_id,link_type,link_source,context,origin_page_id) VALUES ($1,$2,$3,$4,$5,$6)', [from, to, type, source, context, origin]));
  const merge = (t: Awaited<ReturnType<typeof trio>>) => write(async tx => {
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
    return mergeTwinInto(tx, { sourceId, incarnation: source!.incarnation, survivor: t.survivor, twin: t.twin });
  });

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    // A brain that already holds twins (written before this release): the index is pending, so twins can be seeded.
    await dropOriginIndex(engine);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('a twin with inbound links, manual and custom outgoing relationships, aliases, timeline, raw data and tags: everything moves or is an exact duplicate', async () => {
    const t = await trio();
    // Inbound: a body link from the third page to both (derived, re-derived from that body: deduplicated), and a manual one to the twin only.
    await link(t.third, t.twin.page_id, '', 'markdown', 'see [[twin]]');
    await link(t.third, t.survivor.page_id, '', 'markdown', 'see [[survivor]]');
    await link(t.third, t.twin.page_id, 'mentions_manually', 'manual', 'a person said so');
    // Outgoing relationships the twin holds database-only (add_link): manual and a custom provenance.
    await link(t.twin.page_id, t.third, 'works_with', 'manual', 'manual context');
    await link(t.twin.page_id, t.third, 'advises', 'acme-example', 'custom context');
    await write(tx => tx.executeRaw(`INSERT INTO link_transitions (source_id,from_page_id,to_page_id,link_type,kind,occurred_on,producer,origin_page_id)
      VALUES ($1,$2,$3,'works_at','start','2024-01-01','explicit',$2)`, [sourceId, t.twin.page_id, t.third]));
    await write(async tx => {
      await tx.executeRaw("INSERT INTO page_aliases (source_id,alias_norm,slug,origin) VALUES ($1,$2,$3,'frontmatter')", [sourceId, `note alias ${t.tag}`, t.twin.slug]);
      await tx.executeRaw("INSERT INTO timeline_entries (page_id,date,summary,source) VALUES ($1,'2024-02-02','Shared entry','') , ($2,'2024-02-02','Shared entry','') , ($1,'2024-03-03','Only on the twin','manual')", [t.twin.page_id, t.survivor.page_id]);
      await tx.executeRaw("INSERT INTO raw_data (page_id,source,data) VALUES ($1,'crm','{\"k\":1}'), ($1,'web','{\"same\":true}'), ($2,'web','{\"same\":true}')", [t.twin.page_id, t.survivor.page_id]);
      await tx.executeRaw("INSERT INTO tags (page_id,tag,tag_source) VALUES ($1,'alpha','added'), ($1,'shared','added'), ($2,'shared','frontmatter'), ($1,'fm-only','frontmatter')", [t.twin.page_id, t.survivor.page_id]);
    });
    expect(await twinMergeConflicts(engine, t.survivor.page_id, t.twin.page_id)).toEqual([]);
    const result = await merge(t);
    expect(result.links_moved.length).toBe(3);
    expect(result.transitions_moved).toBe(1);
    expect(result.tags_moved).toEqual(['alpha']);
    const out = await engine.executeRaw<{ link_type: string; link_source: string; context: string }>('SELECT link_type, link_source, context FROM links WHERE from_page_id=$1 AND to_page_id=$2 ORDER BY link_type', [t.survivor.page_id, t.third]);
    expect(out).toEqual([{ link_type: 'advises', link_source: 'acme-example', context: 'custom context' }, { link_type: 'works_with', link_source: 'manual', context: 'manual context' }]);
    const inbound = await engine.executeRaw<{ link_source: string; context: string }>('SELECT link_source, context FROM links WHERE from_page_id=$1 AND to_page_id=$2 ORDER BY link_source', [t.third, t.survivor.page_id]);
    expect(inbound).toEqual([{ link_source: 'manual', context: 'a person said so' }, { link_source: 'markdown', context: 'see [[survivor]]' }]);
    expect(await engine.executeRaw('SELECT 1 FROM links WHERE from_page_id=$1 OR to_page_id=$1', [t.twin.page_id])).toEqual([]);
    expect(await engine.executeRaw<{ from_page_id: number }>('SELECT from_page_id FROM link_transitions WHERE to_page_id=$1', [t.third])).toEqual([{ from_page_id: t.survivor.page_id }]);
    expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_aliases WHERE source_id=$1 AND alias_norm=$2', [sourceId, `note alias ${t.tag}`])).map(r => r.slug)).toEqual([t.survivor.slug]);
    expect(await engine.executeRaw<{ canonical_slug: string }>('SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [sourceId, t.twin.slug])).toEqual([{ canonical_slug: t.survivor.slug }]);
    expect((await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1 ORDER BY date', [t.survivor.page_id])).map(r => r.summary)).toEqual(['Shared entry', 'Only on the twin']);
    expect((await engine.executeRaw<{ source: string }>('SELECT source FROM raw_data WHERE page_id=$1 ORDER BY source', [t.survivor.page_id])).map(r => r.source)).toEqual(['crm', 'web']);
    const tags = await engine.executeRaw<{ page_id: number; tag: string; tag_source: string }>('SELECT page_id, tag, tag_source FROM tags WHERE page_id=ANY($1::int[]) ORDER BY page_id, tag', [[t.survivor.page_id, t.twin.page_id]]);
    expect(tags.map(r => [Number(r.page_id) === t.survivor.page_id ? 'survivor' : 'twin', r.tag, r.tag_source]))
      .toEqual([['survivor', 'alpha', 'added'], ['survivor', 'shared', 'added'], ['twin', 'fm-only', 'frontmatter'], ['twin', 'shared', 'added']].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])));
    const [gone] = await engine.executeRaw<{ deleted_at: string | null; source_path: string | null; database_only_reason: string | null }>('SELECT deleted_at, source_path, database_only_reason FROM pages WHERE id=$1', [t.twin.page_id]);
    expect(gone!.deleted_at).not.toBeNull();
    expect(gone).toMatchObject({ source_path: null, database_only_reason: 'origin_twin' });
    expect((await engine.executeRaw<{ source_path: string }>('SELECT source_path FROM pages WHERE id=$1', [t.survivor.page_id]))[0]!.source_path).toBe(t.origin);
  });

  test('distinct evidence on the same unique key refuses the merge before any write: link context, raw payload, timeline detail, relationship date precision', async () => {
    const cases: Array<[string, (t: Awaited<ReturnType<typeof trio>>) => Promise<unknown>]> = [
      ['links', async t => { await link(t.third, t.twin.page_id, 'knows', 'manual', 'context A'); await link(t.third, t.survivor.page_id, 'knows', 'manual', 'context B'); }],
      ['raw_data', t => write(tx => tx.executeRaw("INSERT INTO raw_data (page_id,source,data) VALUES ($1,'crm','{\"v\":1}'), ($2,'crm','{\"v\":2}')", [t.twin.page_id, t.survivor.page_id]))],
      ['timeline_entries', t => write(tx => tx.executeRaw("INSERT INTO timeline_entries (page_id,date,summary,source,detail) VALUES ($1,'2024-02-02','Met','', 'detail A'), ($2,'2024-02-02','Met','', 'detail B')", [t.twin.page_id, t.survivor.page_id]))],
      ['link_transitions', t => write(tx => tx.executeRaw(`INSERT INTO link_transitions (source_id,from_page_id,to_page_id,link_type,kind,occurred_on,producer,origin_page_id,date_precision)
        VALUES ($1,$2,$4,'works_at','start','2024-01-01','manual',NULL,'day'), ($1,$3,$4,'works_at','start','2024-01-01','manual',NULL,'year')`, [sourceId, t.twin.page_id, t.survivor.page_id, t.third]))],
    ];
    for (const [table, seed] of cases) {
      const t = await trio();
      await seed(t);
      const conflicts = await twinMergeConflicts(engine, t.survivor.page_id, t.twin.page_id);
      expect(conflicts.map(c => c.table)).toEqual([table as never]);
      const error = await merge(t).then(() => null, e => e as OperationError);
      expect(error).toBeInstanceOf(OperationError);
      expect(error).toMatchObject({ code: 'revision_conflict', reason: 'twin_evidence_conflicts' });
      const [twin] = await engine.executeRaw<{ deleted_at: string | null; source_path: string | null }>('SELECT deleted_at, source_path FROM pages WHERE id=$1', [t.twin.page_id]);
      expect(twin).toEqual({ deleted_at: null, source_path: t.origin });
    }
  });

  test('a derived link whose context differs is re-derived from the survivor\'s body: deduplicated, not a conflict; exact duplicates are idempotent', async () => {
    const t = await trio();
    await link(t.twin.page_id, t.third, '', 'markdown', 'body context A', t.twin.page_id);
    await link(t.survivor.page_id, t.third, '', 'markdown', 'body context B', t.survivor.page_id);
    await link(t.third, t.twin.page_id, 'knows', 'manual', 'same');
    await link(t.third, t.survivor.page_id, 'knows', 'manual', 'same');
    expect(await twinMergeConflicts(engine, t.survivor.page_id, t.twin.page_id)).toEqual([]);
    const result = await merge(t);
    expect(result.deduplicated).toBe(2);
    expect((await engine.executeRaw('SELECT 1 FROM links WHERE from_page_id=$1 AND to_page_id=$2', [t.survivor.page_id, t.third])).length).toBe(1);
    expect((await engine.executeRaw('SELECT 1 FROM links WHERE from_page_id=$1 AND to_page_id=$2', [t.third, t.survivor.page_id])).length).toBe(1);
  });

  test('readOriginClaimants reads the verdict inputs: one digest per body, the frontmatter id, the trust tier and slug-keyed withdrawals', async () => {
    const t = await trio();
    const differs = await put(`notes/other-${t.tag}`, { body: 'A different body.', sourcePath: t.origin, frontmatter: { id: 'id-x' } });
    await write(tx => tx.executeRaw("INSERT INTO fact_withdrawals (source_id,visibility,subject,fact_hash) VALUES ($1,'private',$2,'h')", [sourceId, t.twin.slug]));
    const rows = await readOriginClaimants(engine, sourceId, [t.survivor.page_id, t.twin.page_id, differs]);
    expect(rows.map(r => r.id)).toEqual([t.survivor.page_id, t.twin.page_id, differs].sort((a, b) => a - b));
    const by = new Map(rows.map(r => [r.id, r]));
    expect(by.get(t.survivor.page_id)!.body_hash).toBe(by.get(t.twin.page_id)!.body_hash);
    expect(by.get(differs)!.body_hash).not.toBe(by.get(t.survivor.page_id)!.body_hash);
    expect(by.get(differs)!.fm_id).toBe('id-x');
    expect(by.get(t.twin.page_id)!.restricted).toBe(true);
    expect(by.get(t.survivor.page_id)!.restricted).toBe(false);
    expect(reason(decideOriginTwins({ sourcePath: t.origin, claimants: rows.filter(r => r.id !== differs), fileId: null }))).toBe('twin_has_withdrawals');
  });
});
