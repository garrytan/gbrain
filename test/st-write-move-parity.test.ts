/**
 * Before/after parity for the three writes that moved behind BrainEngine members in the S2b-st caller edits
 * (the statements' text was written in src/core/loops/loops-store.ts and src/core/page-body/streamed-import.ts at 33433faa84).
 *
 * Each case runs master's exact statement (copied below, with the file and line it had) through `executeRaw` against the
 * new member, over the same steps, and requires the same results and the same rows afterwards. Master ran `loops-store`'s
 * two statements on a plain engine (autocommit) and `streamed-import`'s delete on the import transaction's handle.
 *
 * 1. Protects: upsertOpenLoop (INSERT .. ON CONFLICT with the manual-close guard, the #5012 mute guard and the mute
 *    re-check reopen), closeOpenLoop (source scope, status guard) and pruneFrontmatterTags (frontmatter-owned tags only,
 *    one page in one source) answer what the statement they replaced answered, step by step, on rows on each side of
 *    every predicate.
 * 2. Fails when: a member drops or changes a guard, a COALESCE, a LEAST or GREATEST, a RETURNING column or the follow-up id
 *    read; sends text other than master's (Postgres text block); or runs outside the transaction it was called in.
 * 3. Existing coverage: engine-parity/open-loops.test.ts compares the engines with each other; no case compared a member with
 *    master's statement, and a Rust brain has no raw SQL to run master's text.
 * 4. Seam: none. Real engines; `executeRaw` with master's text as the "before", the typed member as the "after". The
 *    "before" and "after" run on two sources of one brain (PGLite, Postgres) and, with GBRAIN_TEST_RUST_ARM=1, master's text
 *    on a PGLite brain against the Rust member. The transaction block runs each member inside `transaction()`, throws, and
 *    requires the write to be gone (scope), and a source pin requires `tx.pruneFrontmatterTags` between the two statements
 *    it sat between in master.
 *    `open_loops` and `tags` carry no visibility column, so there is no private row to add; the world-only rules for loops are
 *    in JavaScript (entity-card.ts) and untouched.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { HEALTH_CACHE_TTL_KEY } from '../src/core/health-memo.ts';
import { MUTE_RECHECK, MUTED, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';
import { createSource, resetArm, type ParityArm } from './engine-parity/harness.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

// ---------------------------------------------------------------- master's statements, verbatim from 33433faa84

/** src/core/loops/loops-store.ts:127 (upsertOpenLoop), with `${MUTE_RECHECK}` and `${MUTED}` interpolated as master did. */
const MASTER_UPSERT_LOOP = `INSERT INTO open_loops (
       source_id, dedup_key, loop_type, counterparty_slug, counterparty_email,
       summary, evidence, thread_id, page_slug, due_at, detector, confidence,
       fact_id, last_activity_at, opened_at, counterparty_source_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10::timestamptz, $11, $12,
       $13, COALESCE($14::timestamptz, now()), COALESCE($15::timestamptz, now()), $16
     )
     ON CONFLICT (source_id, dedup_key) DO UPDATE SET
       opened_at = CASE WHEN open_loops.status = 'open'
                        THEN LEAST(open_loops.opened_at, EXCLUDED.opened_at)
                        ELSE EXCLUDED.opened_at END,
       status = 'open',
       loop_type = EXCLUDED.loop_type,
       counterparty_slug = COALESCE(EXCLUDED.counterparty_slug, open_loops.counterparty_slug),
       counterparty_source_id = CASE WHEN EXCLUDED.counterparty_slug IS NULL
                                     THEN open_loops.counterparty_source_id
                                     ELSE EXCLUDED.counterparty_source_id END,
       counterparty_email = COALESCE(EXCLUDED.counterparty_email, open_loops.counterparty_email),
       summary = EXCLUDED.summary,
       evidence = EXCLUDED.evidence,
       page_slug = COALESCE(EXCLUDED.page_slug, open_loops.page_slug),
       due_at = COALESCE(EXCLUDED.due_at, open_loops.due_at),
       confidence = EXCLUDED.confidence,
       fact_id = COALESCE(EXCLUDED.fact_id, open_loops.fact_id),
       last_activity_at = GREATEST(open_loops.last_activity_at, EXCLUDED.last_activity_at),
       closed_at = NULL,
       closed_by = NULL,
       updated_at = now()
     WHERE (open_loops.status = 'open'
            OR EXCLUDED.last_activity_at > open_loops.last_activity_at
            OR open_loops.closed_by = '${MUTE_RECHECK}')
       AND (open_loops.closed_by IS DISTINCT FROM '${MUTED}'
            OR open_loops.counterparty_email IS DISTINCT FROM EXCLUDED.counterparty_email)
     RETURNING id, (xmax = 0) AS created`;
/** src/core/loops/loops-store.ts:190 (the follow-up read when the guard held the row). */
const MASTER_UPSERT_FOLLOW_UP = 'SELECT id FROM open_loops WHERE source_id = $1 AND dedup_key = $2';
/** src/core/loops/loops-store.ts:205 (closeOpenLoop). */
const MASTER_CLOSE_LOOP = `UPDATE open_loops
       SET status = $1, closed_at = now(), closed_by = $2, updated_at = now()
     WHERE id = $3 AND status = 'open' AND ($4::text IS NULL OR source_id = $4)
     RETURNING *`;
/** src/core/page-body/streamed-import.ts:463 (importScanned, inside the import transaction). */
const MASTER_PRUNE_TAGS = `DELETE FROM tags t USING pages p WHERE p.id = t.page_id AND p.source_id = $1 AND p.slug = $2
      AND t.tag_source = 'frontmatter' AND NOT (t.tag = ANY($3::text[]))`;

/** The binds master's upsertOpenLoop sent, in `$1`..`$16` order. */
function masterUpsertBinds(loop: OpenLoopUpsert): unknown[] {
  return [
    loop.sourceId, loop.dedupKey, loop.loopType, loop.counterpartySlug ?? null, loop.counterpartyEmail ?? null,
    loop.summary, JSON.stringify(loop.evidence), loop.threadId ?? null, loop.pageSlug ?? null, loop.dueAt ?? null,
    loop.detector, loop.confidence ?? 1.0, loop.factId ?? null, loop.lastActivityAt ?? null, loop.openedAt ?? null,
    loop.counterpartySlug ? (loop.counterpartySourceId ?? null) : null,
  ];
}

/** master's upsertOpenLoop wrapper: the statement, then the follow-up id read when the guard held the row. */
async function masterUpsert(engine: BrainEngine, loop: OpenLoopUpsert): Promise<{ id: number; created: boolean; applied: boolean }> {
  const rows = await engine.executeRaw<{ id: number; created: boolean }>(MASTER_UPSERT_LOOP, masterUpsertBinds(loop));
  if (rows.length > 0) return { id: Number(rows[0]!.id), created: Boolean(rows[0]!.created), applied: true };
  const existing = await engine.executeRaw<{ id: number }>(MASTER_UPSERT_FOLLOW_UP, [loop.sourceId, loop.dedupKey]);
  return { id: Number(existing[0]?.id ?? 0), created: false, applied: false };
}

/** master's closeOpenLoop wrapper. */
async function masterClose(engine: BrainEngine, sourceId: string | null, id: number, status: string, closedBy: string): Promise<Record<string, unknown> | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(MASTER_CLOSE_LOOP, [status, closedBy, id, sourceId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- scenarios

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.000Z';
const T3 = '2026-03-09T10:00:00.000Z';

function loop(sourceId: string, over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId, dedupKey: 'thread:a', loopType: 'unanswered_inbound', counterpartySlug: 'people/alice-example',
    counterpartyEmail: 'alice@example.com', summary: 'first', evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-a',
    detector: 'deterministic_thread', lastActivityAt: T1, openedAt: T1, ...over,
  };
}

type Step =
  | { op: 'upsert'; loop: Partial<OpenLoopUpsert> }
  | { op: 'close'; scope: 'own' | 'null' | 'other'; status: 'done' | 'dropped' | 'stale'; by: string };

interface Scenario { name: string; steps: Step[] }

const SCENARIOS: Scenario[] = [
  { name: 'a new loop is inserted; an unchanged re-upsert of the open loop updates it in place', steps: [
    { op: 'upsert', loop: {} },
    { op: 'upsert', loop: { summary: 'second', lastActivityAt: T2, openedAt: T2, counterpartySlug: undefined, counterpartyEmail: undefined, pageSlug: 'emails/a', dueAt: T3, factId: 9, confidence: 0.4 } },
  ] },
  { name: 'an open loop keeps the earliest opened_at and the latest activity', steps: [
    { op: 'upsert', loop: { lastActivityAt: T2, openedAt: T2 } },
    { op: 'upsert', loop: { lastActivityAt: T1, openedAt: T1, summary: 'older' } },
  ] },
  { name: 'a manually closed loop stays closed on a re-upsert with no newer activity (the manual-close guard)', steps: [
    { op: 'upsert', loop: {} },
    { op: 'close', scope: 'own', status: 'done', by: 'manual' },
    { op: 'upsert', loop: { summary: 'same activity' } },
    { op: 'upsert', loop: { summary: 'older activity', lastActivityAt: '2026-02-01T00:00:00.000Z' } },
  ] },
  { name: 'a closed loop reopens on genuinely newer activity', steps: [
    { op: 'upsert', loop: {} },
    { op: 'close', scope: 'own', status: 'dropped', by: 'manual' },
    { op: 'upsert', loop: { summary: 'newer', lastActivityAt: T2, openedAt: T2 } },
  ] },
  { name: 'a loop a mute closed never reopens for the same counterparty while muted, and does for another one (#5012)', steps: [
    { op: 'upsert', loop: {} },
    { op: 'close', scope: 'own', status: 'dropped', by: MUTED },
    { op: 'upsert', loop: { summary: 'newer, same counterparty', lastActivityAt: T3, openedAt: T3 } },
    { op: 'upsert', loop: { summary: 'newer, other counterparty', lastActivityAt: T3, openedAt: T3, counterpartyEmail: 'bob@example.com' } },
  ] },
  { name: 'a loop an unmute queued for re-check reopens on the re-check even with no newer activity', steps: [
    { op: 'upsert', loop: {} },
    { op: 'close', scope: 'own', status: 'dropped', by: MUTE_RECHECK },
    { op: 'upsert', loop: { summary: 'rechecked' } },
  ] },
  { name: 'closeOpenLoop: a wrong source closes nothing, a null source or the own source closes once, a closed loop closes no more', steps: [
    { op: 'upsert', loop: {} },
    { op: 'close', scope: 'other', status: 'done', by: 'manual' },
    { op: 'close', scope: 'own', status: 'stale', by: 'staleness' },
    { op: 'close', scope: 'null', status: 'done', by: 'manual' },
    { op: 'upsert', loop: { dedupKey: 'thread:b', summary: 'b' } },
    { op: 'close', scope: 'null', status: 'done', by: 'manual' },
  ] },
];

/** A row with ids, clocks and the source masked, so two sources (or two brains) compare. */
function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || k === 'created_at' || k === 'updated_at' || k === 'source_id') continue;
    if (k === 'closed_at') out[k] = v === null || v === undefined ? null : 'set';
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (k === 'fact_id') out[k] = v === null || v === undefined ? null : Number(v);
    else if (k === 'confidence') out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

interface Driver {
  upsert(loop: OpenLoopUpsert): Promise<{ id: number; created: boolean; applied: boolean }>;
  close(sourceId: string | null, id: number, status: string, by: string): Promise<Record<string, unknown> | null>;
  rows(sourceId: string): Promise<Array<Record<string, unknown>>>;
  /** The source the "other" scope names. */
  otherSource: string;
}

/** Runs a scenario through a driver on one source and returns what every step answered, then the rows left. */
async function play(d: Driver, sourceId: string, steps: readonly Step[]): Promise<unknown> {
  const answers: unknown[] = [];
  const ids = new Map<string, number>();
  for (const step of steps) {
    if (step.op === 'upsert') {
      const loopIn = loop(sourceId, step.loop);
      const r = await d.upsert(loopIn);
      ids.set(loopIn.dedupKey, r.id);
      const own = [...(await d.rows(sourceId))].find(row => Number(row.id) === r.id);
      answers.push({ step: 'upsert', created: r.created, applied: r.applied, found: Boolean(own) });
    } else {
      const target = ids.get('thread:b') !== undefined && steps.indexOf(step) >= 4 ? ids.get('thread:b')! : ids.get('thread:a')!;
      const scope = step.scope === 'own' ? sourceId : step.scope === 'null' ? null : d.otherSource;
      const row = await d.close(scope, target, step.status, step.by);
      answers.push({ step: 'close', row: row && normalize(row) });
    }
  }
  const rows = (await d.rows(sourceId)).sort((a, b) => String(a.dedup_key).localeCompare(String(b.dedup_key))).map(normalize);
  return { answers, rows };
}

function sqlDrivers(engine: BrainEngine): { before: Driver; after: Driver } {
  const read = (sourceId: string) => engine.executeRaw<Record<string, unknown>>('SELECT * FROM open_loops WHERE source_id = $1 ORDER BY dedup_key', [sourceId]);
  return {
    before: {
      upsert: l => masterUpsert(engine, l), close: (s, id, st, by) => masterClose(engine, s, id, st, by), rows: read, otherSource: 'elsewhere',
    },
    after: {
      upsert: l => engine.upsertOpenLoop(l), close: (s, id, st, by) => engine.closeOpenLoop(s, id, st as never, by) as Promise<Record<string, unknown> | null>, rows: read, otherSource: 'elsewhere',
    },
  };
}

async function newSource(engine: BrainEngine, id: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`, [id]);
}

// ---------------------------------------------------------------- Postgres statement text, byte for byte

describe('the Postgres write members send master\'s statement text (no database)', () => {
  function recording() {
    const fake = makeFakeSql();
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = fake.sql;
    return { engine, sent: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
  }

  test('upsertOpenLoop sends the upsert and, when the guard held the row, the follow-up read, with master\'s binds', async () => {
    const { engine, sent } = recording();
    const l = loop('default', { counterpartySourceId: 'work', pageSlug: 'emails/a', factId: 7, dueAt: T3, confidence: 0.5 });
    await engine.upsertOpenLoop(l);
    expect(sent()).toEqual([
      { text: MASTER_UPSERT_LOOP, params: masterUpsertBinds(l) },
      { text: MASTER_UPSERT_FOLLOW_UP, params: ['default', 'thread:a'] },
    ]);
  });

  test('closeOpenLoop sends master\'s statement and binds, one statement', async () => {
    const { engine, sent } = recording();
    await engine.closeOpenLoop('work', 12, 'done', 'manual');
    await engine.closeOpenLoop(null, 13, 'stale', 'staleness');
    expect(sent()).toEqual([
      { text: MASTER_CLOSE_LOOP, params: ['done', 'manual', 12, 'work'] },
      { text: MASTER_CLOSE_LOOP, params: ['stale', 'staleness', 13, null] },
    ]);
  });

  test('pruneFrontmatterTags sends master\'s delete (whitespace aside) with the source, slug and kept tags', async () => {
    const { engine, sent } = recording();
    await engine.pruneFrontmatterTags('notes/a', ['x', 'y'], { sourceId: 'work' });
    const [only] = sent();
    expect(sent()).toHaveLength(1);
    // streamed-import.ts indented its second line by six spaces, tags.ts by ten: the same statement.
    expect(only!.text.replace(/\s+/g, ' ')).toBe(MASTER_PRUNE_TAGS.replace(/\s+/g, ' '));
    expect(only!.params).toEqual(['work', 'notes/a', ['x', 'y']]);
  });
});

// ---------------------------------------------------------------- call-site shape and transaction scope

describe('the strict call sites keep master\'s scope and order', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  test('importScanned prunes the frontmatter tags on the transaction handle, after the contextual-retrieval state and before the tags are added', () => {
    const src = read('src/core/page-body/streamed-import.ts');
    const state = src.indexOf('await tx.updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration);');
    const prune = src.indexOf('await tx.pruneFrontmatterTags(slug, parsed.tags, { sourceId });');
    const add = src.indexOf("await addPageTags(tx, result.pageId, parsed.tags, 'frontmatter');");
    expect(state).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(state);
    expect(add).toBeGreaterThan(prune);
    expect(src.slice(state, add)).not.toContain('engine.pruneFrontmatterTags');
    // no raw delete from tags is left in the file
    expect(src).not.toContain('DELETE FROM tags');
  });

  test('main.ts writes no schema-probe notice for a capability refusal, at both places it wrote one', () => {
    const src = read('src/cli/main.ts');
    expect(src).toContain("result.status === 'error' && !(await import('../core/rust-engine/errors.ts')).isCapabilityMissing(result.error)");
    expect(src).toContain("if (!(await import('../core/rust-engine/errors.ts')).isCapabilityMissing(err)) writeCliNotice(migrationsNotice(`Schema probe failed (unexpected)");
  });

  test('loops-store sends every write through the engine\'s members, one call each, and no longer writes open_loops itself', () => {
    const src = read('src/core/loops/loops-store.ts');
    expect(src).toContain('return engine.upsertOpenLoop(loop);');
    expect(src).toContain('await engine.closeOpenLoop(sourceId, id, status, closedBy);');
    expect(src).not.toContain('INSERT INTO open_loops');
    expect(src).not.toContain('UPDATE open_loops\n       SET status = $1');
  });
});

// ---------------------------------------------------------------- row parity, per backend

for (const kind of testBackends()) {
  describe(`moved writes before and after (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2);
        engine = pg.engine;
        close = pg.close;
      } else {
        const e = new PGLiteEngine();
        await e.connect({ engine: 'pglite' } as never);
        await e.initSchema();
        engine = e;
        close = () => e.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => { await resetArm({ backend: kind, engine } as unknown as ParityArm); });

    for (const scenario of SCENARIOS) {
      test(`${scenario.name}`, async () => {
        await newSource(engine, 'before');
        await newSource(engine, 'after');
        const { before, after } = sqlDrivers(engine);
        const was = await play(before, 'before', scenario.steps);
        const now = await play(after, 'after', scenario.steps);
        expect(now).toEqual(was);
        expect((now as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
      });
    }

    test('a closed loop stays closed through the guard on both paths (the answers above differ if either reopens it)', async () => {
      await newSource(engine, 'before');
      await newSource(engine, 'after');
      const { before, after } = sqlDrivers(engine);
      const steps: Step[] = [{ op: 'upsert', loop: {} }, { op: 'close', scope: 'own', status: 'done', by: 'manual' }, { op: 'upsert', loop: { summary: 'ignored' } }];
      const [was, now] = [await play(before, 'before', steps), await play(after, 'after', steps)] as Array<{ answers: any[]; rows: any[] }>;
      expect(now.answers[2]).toEqual({ step: 'upsert', created: false, applied: false, found: true });
      expect(now.rows[0].status).toBe('done');
      expect(now).toEqual(was);
    });

    // ------------------------------------------------------------ pruneFrontmatterTags

    async function tagFixture(sourceId: string, pageSlug: string) {
      await newSource(engine, sourceId);
      const page = await engine.putPage(pageSlug, { type: 'note', title: pageSlug, compiled_truth: pageSlug, timeline: '' }, { sourceId });
      for (const t of ['keep', 'drop', 'also-drop']) await engine.addTag(pageSlug, t, { sourceId, tagSource: 'frontmatter' });
      await engine.addTag(pageSlug, 'explicit', { sourceId });
      await engine.executeRaw(`INSERT INTO tags (page_id, tag, tag_source) VALUES ($1, 'legacy', NULL)`, [page.id]);
      return page;
    }
    const tagRows = (sourceId: string) => engine.executeRaw<{ slug: string; tag: string; tag_source: string | null }>(
      `SELECT p.slug, t.tag, t.tag_source FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 ORDER BY p.slug, t.tag`, [sourceId]);

    for (const keep of [[], ['keep'], ['keep', 'explicit', 'legacy'], ['nothing-matches']] as string[][]) {
      test(`pruneFrontmatterTags keeping ${JSON.stringify(keep)} deletes what master's statement deleted: the frontmatter tags not kept, nothing else, only that page and source`, async () => {
        for (const s of ['before', 'after', 'bystander']) {
          await tagFixture(s, 'notes/a');
          await tagFixture(s, 'notes/b');
        }
        await engine.executeRaw(MASTER_PRUNE_TAGS, ['before', 'notes/a', keep]);
        await engine.pruneFrontmatterTags('notes/a', keep, { sourceId: 'after' });
        const strip = (rows: Array<{ slug: string; tag: string; tag_source: string | null }>) => rows;
        const was = strip(await tagRows('before'));
        const now = strip(await tagRows('after'));
        expect(now).toEqual(was);
        // the untouched page keeps all five rows, the pruned page keeps what the frontmatter did not own plus what is kept
        expect(now.filter(r => r.slug === 'notes/b')).toHaveLength(5);
        // the same slug in another source is not touched
        expect(await tagRows('bystander')).toHaveLength(10);
        expect(now.filter(r => r.slug === 'notes/a').map(r => r.tag).sort()).toEqual(
          ['explicit', 'legacy', ...(keep.includes('keep') ? ['keep'] : [])].sort());
      });
    }

    // ------------------------------------------------------------ the reads that moved with the writes

    test('getSource answers the rows the preflight, connector and write-through statements read: local_path and config, by id, and nothing for an unknown id', async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config, local_path) VALUES ('pathed', 'pathed', '{"kind":"repo","federated":true}'::jsonb, '/work/p'), ('bare', 'bare', '{}'::jsonb, NULL)`);
      for (const id of ['default', 'pathed', 'bare', 'nowhere']) {
        const [old] = await engine.executeRaw<{ local_path: string | null; config: unknown }>('SELECT local_path, config FROM sources WHERE id = $1', [id]);
        const [oldPath] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [id]);
        const now = await engine.getSource(id);
        expect(now?.local_path ?? null, id).toBe(old?.local_path ?? null);
        expect(now?.local_path ?? null, id).toBe(oldPath?.local_path ?? null);
        expect(Boolean(now), id).toBe(Boolean(old));
        const cfg = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
        expect(now ? cfg(now.config) : null, id).toEqual(old ? cfg(old.config) : null);
      }
      expect((await engine.getSource('pathed'))?.local_path).toBe('/work/p');
    });

    test('listAccessTokens answers the rows `gbrain auth list` selected: every token, revoked ones too, newest first, every column', async () => {
      await engine.executeRaw(`INSERT INTO access_tokens (name, token_hash, scopes, created_at, revoked_at) VALUES
        ('old', 'h1', ARRAY['read'], '2026-01-01T00:00:00Z', NULL), ('mid', 'h2', ARRAY['read','write'], '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z'), ('new', 'h3', NULL, '2026-03-01T00:00:00Z', NULL)`);
      const old = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens ORDER BY created_at DESC');
      const now = await engine.listAccessTokens();
      // The trunk's member selects the columns `auth list` and the member-status read use (AccessTokenListRow), not every column: compare those.
      const columns = Object.keys((now[0] ?? {}) as Record<string, unknown>);
      const shape = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map(r => ({ ...Object.fromEntries(columns.map(c => [c, r[c]])), id: String(r.id) }));
      expect(shape(now as never)).toEqual(shape(old));
      expect(now.map(r => r.name)).toEqual(['new', 'mid', 'old']);
    });

    test('the health memo\'s clock and config reads answer what its one UNION statement answered, before and after a page write', async () => {
      const keys = ['embedding_columns', 'schema_pack', HEALTH_CACHE_TTL_KEY];
      await engine.executeRaw(`INSERT INTO config (key, value) VALUES ('embedding_columns', 'a,b'), ('schema_pack', 'p'), ('health.cache_ttl_ms', '5') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      const before = async () => {
        const rows = await engine.executeRaw<{ k: string; v: string | null }>(
          `SELECT key AS k, value AS v FROM config
        WHERE key IN (${keys.map(k => `'${k}'`).join(', ')})
       UNION ALL
       SELECT '__page_clock__' AS k, COALESCE((SELECT last_value FROM page_generation_clock_seq), 0)::text AS v
       UNION ALL
       SELECT '__brain_id__' AS k, (SELECT brain_id::text FROM persistence_brain WHERE singleton = 1) AS v`);
        const byKey = new Map(rows.map(r => [r.k, r.v]));
        return { clock: `${byKey.get('__brain_id__') ?? ''}:${byKey.get('__page_clock__') ?? ''}`, config: keys.map(k => [k, byKey.get(k) ?? null]) };
      };
      const after = async () => ({
        clock: await engine.readHealthMemoClock(),
        config: await engine.getConfigValues(keys).then(rows => { const m = new Map(rows.map(r => [r.key, r.value])); return keys.map(k => [k, m.get(k) ?? null]); }),
      });
      const first = await before();
      expect(await after()).toEqual(first);
      expect(first.config).toEqual([['embedding_columns', 'a,b'], ['schema_pack', 'p'], [HEALTH_CACHE_TTL_KEY, '5']]);
      await engine.putPage('notes/clock', { type: 'note', title: 'c', compiled_truth: 'c', timeline: '' });
      const second = await before();
      expect(second.clock).not.toBe(first.clock);
      expect(await after()).toEqual(second);
    });

    // ------------------------------------------------------------ transaction scope

    test('pruneFrontmatterTags runs inside the transaction it is called in: a rollback restores the tags, a commit applies the prune', async () => {
      await tagFixture('after', 'notes/a');
      await expect(engine.transaction(async tx => {
        await tx.pruneFrontmatterTags('notes/a', ['keep'], { sourceId: 'after' });
        expect((await tx.getTags('notes/a', { sourceId: 'after' })).sort()).toEqual(['explicit', 'keep', 'legacy']);
        throw new Error('roll back');
      })).rejects.toThrow('roll back');
      expect((await engine.getTags('notes/a', { sourceId: 'after' })).sort()).toEqual(['also-drop', 'drop', 'explicit', 'keep', 'legacy']);
      await engine.transaction(async tx => { await tx.pruneFrontmatterTags('notes/a', ['keep'], { sourceId: 'after' }); });
      expect((await engine.getTags('notes/a', { sourceId: 'after' })).sort()).toEqual(['explicit', 'keep', 'legacy']);
    });

    test('upsertOpenLoop and closeOpenLoop follow a transaction handle too, as executeRaw did: a rollback undoes both, and a commit keeps the loop', async () => {
      await newSource(engine, 'after');
      await expect(engine.transaction(async tx => {
        const r = await tx.upsertOpenLoop(loop('after'));
        expect(r).toMatchObject({ created: true, applied: true });
        expect(await tx.closeOpenLoop('after', r.id, 'done', 'manual')).not.toBeNull();
        throw new Error('roll back');
      })).rejects.toThrow('roll back');
      expect(await engine.listOpenLoops({ sourceIds: ['after'] })).toEqual([]);
      const kept = await engine.transaction(async tx => {
        const r = await tx.upsertOpenLoop(loop('after'));
        return r;
      });
      expect((await engine.listOpenLoops({ sourceIds: ['after'] })).map(r => Number(r.id))).toEqual([kept.id]);
    });
  });
}

// ---------------------------------------------------------------- the Rust arm (opt-in): the three members Rust serves

describe.skipIf(!rustArmRequested())('the Rust write members before and after: master\'s statements on PGLite against Rust', () => {
  let rust: BrainEngine;
  let dir: string;
  let pglite: PGLiteEngine;

  beforeAll(async () => {
    const opened = await openRustBrain();
    rust = opened.engine as unknown as BrainEngine;
    dir = opened.dir;
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    await newSource(pglite, 'elsewhere');
    await createSource(rust, 'rust', 'elsewhere');
  }, 120_000);
  afterAll(async () => {
    await rust.disconnect();
    removeBrainDir(dir);
    await pglite.disconnect();
  });

  const rustDriver = (): Driver => ({
    upsert: l => rust.upsertOpenLoop(l),
    close: (s, id, st, by) => rust.closeOpenLoop(s, id, st as never, by) as Promise<Record<string, unknown> | null>,
    rows: async sourceId => (await rust.listOpenLoops({ sourceIds: [sourceId] })) as Array<Record<string, unknown>>,
    otherSource: 'elsewhere',
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.name}`, async () => {
      const id = `s${SCENARIOS.indexOf(scenario)}`;
      await newSource(pglite, id);
      await createSource(rust, 'rust', id);
      const was = await play(sqlDrivers(pglite).before, id, scenario.steps);
      const now = await play(rustDriver(), id, scenario.steps);
      expect(now).toEqual(was);
    });
  }

  test('pruneFrontmatterTags on Rust leaves the tags master\'s delete leaves on PGLite', async () => {
    for (const [e, backend] of [[pglite, 'pglite'], [rust, 'rust']] as const) {
      await createSource(e, backend, 'tg');
      await e.putPage('notes/a', { type: 'note', title: 'a', compiled_truth: 'a', timeline: '' }, { sourceId: 'tg' });
      for (const t of ['keep', 'drop']) await e.addTag('notes/a', t, { sourceId: 'tg', tagSource: 'frontmatter' });
      await e.addTag('notes/a', 'explicit', { sourceId: 'tg' });
    }
    await pglite.executeRaw(MASTER_PRUNE_TAGS, ['tg', 'notes/a', ['keep']]);
    await rust.pruneFrontmatterTags('notes/a', ['keep'], { sourceId: 'tg' });
    const [was, now] = [(await pglite.getTags('notes/a', { sourceId: 'tg' })).sort(), (await rust.getTags('notes/a', { sourceId: 'tg' })).sort()];
    expect(was).toEqual(['explicit', 'keep']);
    expect(now).toEqual(was);
  });
});
