/**
 * Shared cases for purge, forget and demotion against page_segment_derivations (Wave B PR 4 lane 4a, round 2; spec 11):
 * after a fact purge no derivation row may hold the purged claim and the purge receipt reports the store complete,
 * whether the row belongs to an occurrence an append retired before the purge, to a derivation that read the page
 * before the purge and tried to write after it, or to a segmented body the page was demoted from. A fences row keeps
 * fence digests, never the fence text, and a forget deletes the unpaid rows of occurrences no longer live.
 *
 * The cases come in five groups by topic, each run by a file of its own on each engine, so no file outgrows the e2e
 * runner's per-file cap (scripts/run-e2e.sh): retired rows and races (derivation-purge-retired), normalized claims
 * (-normalized), sweep batches and deadlines (-batching), the scope and its lock (-scope), and stalls, paid work, receipts
 * and doctor (-stalls). PGLite: test/large-pages/derivation-purge-<group>.test.ts; PostgreSQL:
 * test/e2e/derivation-purge-<group>-postgres.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { __setAfterDerivationSweepBatchForTests, __setBeforeDerivationWriteForTests, __setBeforeUnreadDerivationDeleteForTests, __setDerivationSweepLimitsForTests,
  __setDerivationSweepWorkForTests, continueDerivationPurges, DERIVATION_SWEEP_LIMITS, derivationPurgeState, derivationSweepStatements, derivationSweepWork,
  segmentDeriveWork } from '../../src/core/page-body/segment-derive.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { __setPurgeProbeLimitsForTests } from '../../src/core/facts/purge-verify.ts';
import { derivationPurgeSweepsEntry } from '../../src/commands/doctor/checks/derivation-purge-sweeps.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import { categorizeCheck } from '../../src/core/doctor-categories.ts';
import { incrementalFactsFenceView, segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { deriveAll, KINDS, liveOccurrences, resetDeriveWork, storedPage } from './derivation-equivalence-cases.ts';
import { conversationBody } from './conversation-page.ts';
import { openAppendBrain, type AppendBrain } from './append-brain.ts';

const SOURCE = 'default';
const prose = (bytes: number, seed: number) => conversationBody(bytes, { seed }).replace(/^## Day \\d+$/gm, 'Next day.');

/**
 * A segmented page whose truth ends with a facts fence: `claim` in a row that also links a person, then a short
 * timeline.
 */
function purgePage(claim: string): string {
  return ['---\ntype: person\ntitle: Purge Example\n---\n\nIntro: met [[people/alice-example]].\n\n', prose(1_300_000, 41), '\n\n## Facts\n\n',
    '<!--- gbrain:facts:begin -->\n',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n',
    '|---|---|---|---|---|---|---|---|---|---|\n',
    `| 1 | ${claim} | fact | 0.9 | world | low | 2026-03-01 | | [[people/alice-example]] | |\n`,
    '| 2 | prefers email | preference | 0.8 | world | low | 2026-02-01 | | user | |\n',
    '<!--- gbrain:facts:end -->\n\n<!-- timeline -->\n\n- **2026-04-02** | Met [[people/alice-example]]\n'].join('');
}

/**
 * Derivation rows of a page whose output or receipt holds `claim` (as the purge receipt probes the store).
 */
async function holders(engine: BrainEngine, pageId: number, claim: string): Promise<Array<{ pipeline: string; occurrence_id: number }>> {
  return (await engine.executeRaw<{ pipeline: string; occurrence_id: string }>(`SELECT pipeline, occurrence_id::text AS occurrence_id FROM page_segment_derivations
    WHERE page_id=$1 AND (strpos(lower(COALESCE(output::text,'')),$2)>0 OR strpos(lower(COALESCE(receipt::text,'')),$2)>0) ORDER BY pipeline, occurrence_id`,
  [pageId, claim.toLowerCase()])).map(row => ({ pipeline: row.pipeline, occurrence_id: Number(row.occurrence_id) }));
}

/**
 * A segmented page whose last truth paragraph states `text` next to a link, so its links rows carry it in an excerpt.
 */
function prosePage(text: string, seed: number): string {
  return ['---\ntype: note\ntitle: Prose Example\n---\n\n', prose(1_300_000, seed), `\n\nClosing: met [[people/alice-example]]. ${text}.\n`].join('');
}

/**
 * Derivation rows of a page whose output or receipt holds `text` byte for byte (no case folding on either side).
 */
async function exactHolders(engine: BrainEngine, pageId: number, text: string): Promise<Array<{ pipeline: string; occurrence_id: number }>> {
  return (await engine.executeRaw<{ pipeline: string; occurrence_id: string }>(`SELECT pipeline, occurrence_id::text AS occurrence_id FROM page_segment_derivations
    WHERE page_id=$1 AND (strpos(COALESCE(output::text,''),$2)>0 OR strpos(COALESCE(receipt::text,''),$2)>0) ORDER BY pipeline, occurrence_id`,
  [pageId, text])).map(row => ({ pipeline: row.pipeline, occurrence_id: Number(row.occurrence_id) }));
}

/**
 * Per page of the source: derivation rows no live segment backs (occurrence retired, page inline or soft-deleted), and
 * whose lowercased output and receipt text match the LIKE `pattern` (ASCII, so lowercasing is the same everywhere).
 */
async function unbackedRows(engine: BrainEngine, pattern = '%'): Promise<Map<number, number>> {
  const rows = await engine.executeRaw<{ page_id: number; n: number }>(`SELECT d.page_id, count(*)::int AS n FROM page_segment_derivations d
    JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1 AND (p.deleted_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=d.page_id
      AND m.occurrence_id=d.occurrence_id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.sha256=d.segment_sha256))
      AND lower(COALESCE(d.output::text,'') || ' ' || COALESCE(d.receipt::text,'')) LIKE $2
    GROUP BY d.page_id`, [SOURCE, pattern]);
  return new Map(rows.map(row => [Number(row.page_id), Number(row.n)]));
}

/**
 * One brain per test, opened before it and closed after it, so no test's sweep walks, or waits on, rows and sweeps an
 * earlier test left in the source; and the helpers the cases share. Call it inside a describe.
 */
function derivationPurgeHarness(kind: 'pglite' | 'postgres') {
  let brain: AppendBrain;
  beforeEach(async () => {
    brain = await openAppendBrain(kind);
    await brain.engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example fixture.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
  }, 600_000);
  afterEach(() => brain.close(), 120_000);

  const seed = async (slug: string, claim: string) => {
    await brain.seed(slug, purgePage(claim));
    await runExtractFacts(brain.engine, { slugs: [slug] });
    const [fact] = await brain.engine.executeRaw<{ id: number }>(
      'SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3 AND expired_at IS NULL', [SOURCE, slug, claim]);
    expect(fact).toBeDefined();
    return Number(fact!.id);
  };

  const purge = async (id: number) => {
    const dry = await brain.call('purge_fact', { id, dry_run: true });
    expect(dry.body.confirm_token).toBeString();
    const done = await brain.call('purge_fact', { id, confirm: dry.body.confirm_token, expected_revision: dry.body.expected_revision });
    expect(done.body.state).toBe('committed');
    return done.body as Record<string, any>;
  };

  /** The receipt's page_segment_derivations report, and that no store is left incomplete. */
  const complete = (receipt: Record<string, any>) => {
    const stores = receipt.stores as Array<{ store: string; status: string }>;
    expect(stores.filter(s => s.status === 'incomplete')).toEqual([]);
    const store = stores.find(s => s.store === 'page_segment_derivations');
    expect(store && ['deleted', 'not_present'].includes(store.status)).toBe(true);
  };

  /**
   * A page that is not purged retires the occurrence whose links rows carry `planted` (an append replaces its last
   * segment), so only the purge's derivation sweep can reach those rows.
   */
  const retiredHolder = async (slug: string, planted: string, seedNo: number) => {
    await brain.seed(slug, prosePage(planted, seedNo));
    const page = await storedPage(brain.engine, slug);
    await deriveAll(brain.engine, page);
    const res = await brain.call('append_page', { slug, text: 'Appended note: nothing more.\n', region: 'truth', request_id: randomUUID() });
    expect(res).toMatchObject({ isError: false });
    const live = await liveOccurrences(brain.engine, page.id);
    const held = await exactHolders(brain.engine, page.id, planted);
    expect(held.length).toBeGreaterThan(0);
    expect(held.filter(row => live.has(row.occurrence_id))).toEqual([]);
    return page;
  };

  const derivationStore = (receipt: Record<string, any>) =>
    (receipt.stores as Array<{ store: string; status: string; remaining?: number }>).find(s => s.store === 'page_segment_derivations');

  /** An inline page whose derivation rows no live segment backs: `holding` state `claim`, `common` more state its words in order. */
  const candidateRowsPage = async (slug: string, claim: string, common: number, holding: number) => {
    await brain.engine.putPage(slug, { type: 'note', title: 'Batch Rows', compiled_truth: 'Batch rows fixture.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
    const [row] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
    const [first, ...rest] = claim.split(' ');
    await brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
      SELECT $1, 'links', g, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done',
        jsonb_build_object('candidates', jsonb_build_array(jsonb_build_object('context',
          CASE WHEN g <= $3 THEN 'Note: ' || $4 || ' today' ELSE $5 || ' row ' || g || ' said ' || $6 || ' not' END))), NULL
      FROM generate_series(1, $2::int) g`, [Number(row!.id), common + holding, holding, claim, first, rest.join(' ')]);
    expect(await exactHolders(brain.engine, Number(row!.id), claim)).toHaveLength(holding);
    return Number(row!.id);
  };

  /** Derivation rows of the source. */
  const sourceRows = async () => Number((await brain.engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM page_segment_derivations d JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1', [SOURCE]))[0]!.n);

  const sweepsRecorded = async () => Number((await brain.engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM page_segment_derivation_purges WHERE source_id=$1', [SOURCE]))[0]!.n);

  const sweepStatements = () => derivationSweepStatements.filter(s => s.phase === 'sweep');

  const confirmed = async (id: number) => {
    const dry = await brain.call('purge_fact', { id, dry_run: true });
    return { id, confirm: dry.body.confirm_token, expected_revision: dry.body.expected_revision, request_id: randomUUID() };
  };

  /** Continues purge request `requestId`'s derivation sweep through --status --continue until it is no longer pending (each call runs at least one batch); the last status. */
  const continueToEnd = async (requestId: string) => {
    let status: Record<string, any> = {};
    for (let calls = 0; calls < 1000; calls++) {
      status = (await brain.call('purge_fact', { status: true, request_id: requestId, continue: true })).body;
      if (status.derivation_sweep !== 'pending') break;
    }
    return status;
  };

  /**
   * Derivation rows of the source holding `text` byte for byte that a sweep of a purge of page `purged` covers: rows of that page, of a soft-deleted
   * page, or that no live segment backs.
   */
  const sweptHolders = async (text: string, purged: string) => Number((await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n
    FROM page_segment_derivations d JOIN pages p ON p.id=d.page_id WHERE p.source_id=$1 AND (strpos(COALESCE(d.output::text,''),$2)>0 OR strpos(COALESCE(d.receipt::text,''),$2)>0)
      AND (p.slug=$3 OR p.deleted_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=d.page_id AND m.occurrence_id=d.occurrence_id
        AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.sha256=d.segment_sha256))`, [SOURCE, text, purged]))[0]!.n);

  /**
   * A purge of page `purged` whose derivation sweep --continue finished (`status`, continueToEnd): no store of its receipt is incomplete but the
   * sweep's own (the derivations and the sweep's record, while it was pending), the sweep ended with the purge's completion not incomplete, and no
   * derivation row the sweep covers holds `claim`.
   */
  const completeAfterSweep = async (receipt: Record<string, any>, status: Record<string, any>, claim: string, purged: string) => {
    expect((receipt.stores as Array<{ store: string; status: string }>).filter(s => s.status === 'incomplete'
      && !['page_segment_derivations', 'page_segment_derivation_purges'].includes(s.store))).toEqual([]);
    expect({ sweep: status.derivation_sweep, completion: status.completion === 'incomplete' ? 'incomplete' : 'settled', holders: await sweptHolders(claim, purged) })
      .toEqual({ sweep: undefined, completion: 'settled', holders: 0 });
  };

  /** An inline page whose `n` derivation rows (no live segment backs them) each state `claim` inside about `bytes` of text. */
  const bigRowsPage = async (slug: string, claim: string, n: number, bytes: number) => {
    await brain.engine.putPage(slug, { type: 'note', title: 'Big Rows', compiled_truth: 'Big rows fixture.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
    const [row] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
    await brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
      SELECT $1, 'links', g, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done',
        jsonb_build_object('candidates', jsonb_build_array(jsonb_build_object('context', repeat('journal line text ', $4::int / 18) || ' Note: ' || $3 || ' today'))), NULL
      FROM generate_series(1, $2::int) g `, [Number(row!.id), n, claim, bytes]);
    expect(await exactHolders(brain.engine, Number(row!.id), claim)).toHaveLength(n);
    return Number(row!.id);
  };

  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  /**
   * A source of its own with one page holding one `pipeline` row, the page soft-deleted (so the row is in a sweep's scope), and a sweep recorded for
   * it. `backed`: a live manifest occurrence backs the row, so only the soft delete puts it in the scope.
   */
  const unreadFixture = async (source: string, pipeline: string, backed: boolean) => {
    await brain.engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [source]);
    await brain.engine.putPage('notes/unread-fixture', { type: 'note', title: 'Unread Fixture', compiled_truth: 'Unread fixture.', timeline: '', frontmatter: {} }, { sourceId: source });
    const [row] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [source, 'notes/unread-fixture']);
    const page = Number(row!.id);
    if (backed) {
      await brain.engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body) VALUES ($1, decode(repeat('00', 32), 'hex'), 1, 1, convert_to('x', 'UTF8'))`, [source]);
      await brain.engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, seq, region, source_id, sha256, byte_start, byte_len, line_start, line_count, cut_kind,
        entry_state, static_proj_bytes, static_proj_lines, hash_state)
        VALUES ($1, 1, 1, 0, 'truth', $2, decode(repeat('00', 32), 'hex'), 0, 1, 0, 1, 'eof', '{}'::jsonb, 0, 0, decode(repeat('00', 32), 'hex'))`, [page, source]);
    }
    await brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
      VALUES ($1, $2, 1, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done', '{"note":"a paid or unpaid result"}'::jsonb, NULL)`, [page, pipeline]);
    await brain.engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [page]);
    const requestId = randomUUID();
    await brain.engine.executeRaw(`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns) VALUES ($1::uuid, $2, ARRAY[' purge example never stated '], ARRAY['%purge%example%never%stated%'])`,
      [requestId, source]);
    return { page, requestId, rows: async () => (await brain.engine.readSegmentDerivations(page)).length };
  };

  /** A sweep's receipt while a write holds the scope lock past its wait, and doctor's view of it: the named reason, \`next\` and the doctor record. */
  const busyView = async (requestId: string, body: Record<string, any>) => {
    const [check] = await derivationPurgeSweepsEntry.run({ engine: brain.engine } as never) as Array<Record<string, any>>;
    return { sweep: body.derivation_sweep, reason: body.derivation_sweep_reason ?? null,
      next: (body.next as string[] | undefined ?? []).some(n => n.includes('Let that write finish, then continue') && n.includes(`--request-id ${requestId} --continue`)),
      doctor: (check!.details.records as Array<Record<string, any>> | undefined)?.find(r => r.request_id === requestId)?.reason ?? null,
      message: String(check!.message).includes('scope_lock_busy') && String(check!.message).includes('let that write finish') };
  };

  const busy = { sweep: 'pending', reason: 'scope_lock_busy', next: true, doctor: 'scope_lock_busy', message: true };

  const scopeKey = `hashtextextended('gbrain:derivation-scope:' || '${SOURCE}', 0)`;

  const advisoryLocks = (sql: any, mode: string) => sql.unsafe(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND mode = $1 AND NOT granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`, [mode]) as Promise<Array<{ pid: number }>>;

  return { get brain() { return brain; }, seed, purge, complete, retiredHolder, derivationStore, candidateRowsPage, sourceRows, sweepsRecorded, sweepStatements, confirmed, continueToEnd, sweptHolders, completeAfterSweep, bigRowsPage, timeout, unreadFixture, busyView, busy, scopeKey, advisoryLocks };
}

/**
 * A purge deletes the rows of occurrences an append retired, a racing derivation writes none after it, a demoted page
 * keeps none, the sweep reaches only rows in its scope (whole words), records no work unasked, and a statement
 * timeout of its recording fails the purge with a typed code.
 */
export function registerDerivationPurgeRetiredCases(kind: 'pglite' | 'postgres'): void {
  describe(`purge leaves no derivation row holding the claim (${kind}): retired rows, racing derivations, demotion, scope and the typed timeout`, () => {
    const h = derivationPurgeHarness(kind);
    const { seed, purge, complete, retiredHolder, derivationStore } = h;

    test('a purge after an append retired the occurrence holding the claim deletes its rows', async () => {
      const slug = 'notes/purge-retired', claim = 'Purge Example door code is 5528';
      const id = await seed(slug, claim);
      const page = await storedPage(h.brain.engine, slug);
      await deriveAll(h.brain.engine, page);
      const held = await holders(h.brain.engine, page.id, claim);
      expect(held.length).toBeGreaterThan(0);
      const res = await h.brain.call('append_page', { slug, text: 'Appended note: nothing about the claim.\n', region: 'truth', request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const live = await liveOccurrences(h.brain.engine, page.id);
      expect(held.filter(row => !live.has(row.occurrence_id)).length).toBeGreaterThan(0);
      complete(await purge(id));
      expect(await holders(h.brain.engine, page.id, claim)).toEqual([]);
    }, 600_000);

    test('a derivation that read the page before a purge does not write its rows after it', async () => {
      const slug = 'notes/purge-race', claim = 'Purge Example badge number is 7731';
      const id = await seed(slug, claim);
      const page = await storedPage(h.brain.engine, slug);
      let receipt: Record<string, any> | null = null;
      __setBeforeDerivationWriteForTests(async () => {
        if (receipt) return;
        receipt = {};
        receipt = await purge(id);
      });
      resetDeriveWork();
      try { await deriveAll(h.brain.engine, page); } finally { __setBeforeDerivationWriteForTests(null); }
      expect(receipt).not.toBeNull();
      expect(await holders(h.brain.engine, page.id, claim)).toEqual([]);
      complete(receipt!);
      expect(KINDS.reduce((n, k) => n + segmentDeriveWork[k].skipped, 0)).toBeGreaterThan(0);
    }, 600_000);

    test('a fences row keeps the fence digest, not its text; a current fence run is read again for it', async () => {
      const slug = 'notes/fence-digest', claim = 'Purge Example vault code is 9902';
      await seed(slug, claim);
      const page = await storedPage(h.brain.engine, slug);
      await deriveAll(h.brain.engine, page);
      const fences = await h.brain.engine.readSegmentDerivations(page.id, { kind: 'fences' });
      expect(fences.length).toBeGreaterThan(0);
      expect(fences.filter(row => JSON.stringify(row.output).includes('gbrain:facts:begin') || JSON.stringify(row.output).toLowerCase().includes(claim.toLowerCase()))).toEqual([]);
      resetDeriveWork();
      const view = await incrementalFactsFenceView(h.brain.engine, page);
      expect(view).toEqual(await segmentedFactsFenceView(h.brain.engine, page));
      expect(view.body.facts.map(f => f.claim)).toContain(claim);
      expect({ derived: segmentDeriveWork.fences.derived, reread: segmentDeriveWork.fences.reread }).toEqual({ derived: 0, reread: 1 });
    }, 600_000);

    test('a forget after an append retired an occurrence deletes the unpaid rows of every occurrence no longer live', async () => {
      const slug = 'notes/forget-retired', claim = 'Purge Example gate code is 3318';
      const id = await seed(slug, claim);
      const page = await storedPage(h.brain.engine, slug);
      await deriveAll(h.brain.engine, page);
      const res = await h.brain.call('append_page', { slug, text: 'Appended note: nothing about the claim.\n', region: 'truth', request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const retired = async () => {
        const live = await liveOccurrences(h.brain.engine, page.id);
        return (await h.brain.engine.readSegmentDerivations(page.id)).filter(row => KINDS.includes(row.kind as never) && !live.has(row.occurrenceId)).length;
      };
      expect(await retired()).toBeGreaterThan(0);
      expect((await forgetFactInFence(h.brain.engine, id, { sourceId: SOURCE })).ok).toBe(true);
      expect(await retired()).toBe(0);
    }, 600_000);

    test('a purge after the page was demoted to inline leaves no row of its segmented body', async () => {
      const slug = 'notes/purge-demoted', claim = 'Purge Example locker is 4410';
      const id = await seed(slug, claim);
      const page = await storedPage(h.brain.engine, slug);
      await deriveAll(h.brain.engine, page);
      expect((await holders(h.brain.engine, page.id, claim)).length).toBeGreaterThan(0);
      const [row] = await h.brain.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE id=$1', [page.id]);
      const small = purgePage(claim).replace(prose(1_300_000, 41), 'Short body now.');
      const res = await h.brain.call('put_page', { slug, content: small, expected_revision: row!.r, request_id: randomUUID() });
      expect(res).toMatchObject({ isError: false });
      const [after] = await h.brain.engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE id=$1', [page.id]);
      expect(after!.body_storage).toBe('inline');
      complete(await purge(id));
      expect(await holders(h.brain.engine, page.id, claim)).toEqual([]);
    }, 600_000);

    test('a purge sweeps only rows of the pages it rewrote and rows no live segment backs, matching whole words', async () => {
      const claim = 'Plays oboe';
      const unrelated = await retiredHolder('notes/sweep-unrelated', 'Alice Example plays oboes on weekends', 61);
      const retired = await retiredHolder('notes/sweep-retired', 'Alice Example PLAYS OBOE', 62);
      await h.brain.seed('notes/sweep-live', prosePage(claim, 63));
      const live = await storedPage(h.brain.engine, 'notes/sweep-live');
      await deriveAll(h.brain.engine, live);
      const liveHeld = await exactHolders(h.brain.engine, live.id, claim);
      expect(liveHeld.length).toBeGreaterThan(0);
      const id = await seed('notes/sweep-purge', claim);
      const target = await storedPage(h.brain.engine, 'notes/sweep-purge');
      await deriveAll(h.brain.engine, target);
      const unbacked = await unbackedRows(h.brain.engine);
      const unrelatedRows = (await h.brain.engine.readSegmentDerivations(unrelated.id)).length;
      const retiredHeld = (await exactHolders(h.brain.engine, retired.id, 'Alice Example PLAYS OBOE')).length;
      expect(unbacked.has(live.id)).toBe(false);
      const worded = await unbackedRows(h.brain.engine, '%plays%oboe%');
      __setDerivationSweepWorkForTests(true);
      let receipt: Record<string, any>;
      let work: typeof derivationSweepWork;
      try { receipt = await purge(id); work = [...derivationSweepWork]; } finally { __setDerivationSweepWorkForTests(false); }
      expect(work.some(w => w.pageId === target.id && w.scanned > 0)).toBe(true);
      const expected = [...unbacked].filter(([pageId]) => pageId !== target.id).sort((a, b) => a[0] - b[0])
        .map(([pageId, scanned]) => ({ pageId, scanned, normalized: worded.get(pageId) ?? 0, deleted: pageId === retired.id ? retiredHeld : 0 }));
      expect(work.filter(w => w.pageId !== target.id)).toEqual(expected);
      expect(work.find(w => w.pageId === live.id)).toBeUndefined();
      const others = work.filter(w => w.pageId !== target.id);
      expect(others.reduce((n, w) => n + w.normalized, 0)).toBe([...worded].filter(([pageId]) => pageId !== target.id).reduce((n, [, k]) => n + k, 0));
      expect(others.reduce((n, w) => n + w.normalized, 0)).toBeLessThan(others.reduce((n, w) => n + w.scanned, 0));
      expect(expected.find(w => w.pageId === unrelated.id)?.deleted).toBe(0);
      expect(unbacked.get(unrelated.id)).toBeLessThan(unrelatedRows);
      expect((await h.brain.engine.readSegmentDerivations(unrelated.id)).length).toBe(unrelatedRows);
      expect(await exactHolders(h.brain.engine, retired.id, 'Alice Example PLAYS OBOE')).toEqual([]);
      expect(await exactHolders(h.brain.engine, live.id, claim)).toEqual(liveHeld);
      expect(derivationStore(receipt!)).toMatchObject({ status: 'out_of_scope', reason: 'source_prose', remaining: liveHeld.length });
      expect((receipt!.stores as Array<{ status: string }>).filter(s => s.status === 'incomplete')).toEqual([]);
    }, 600_000);

    test('a sweep records no work unless a test asks for it', async () => {
      const id = await seed('notes/sweep-unrecorded', 'Purge Example shed code is 1186');
      __setDerivationSweepWorkForTests(false);
      await purge(id);
      expect(derivationSweepWork).toEqual([]);
    }, 600_000);

    test('a statement timeout of the derivation sweep fails the purge with the typed code and purges nothing', async () => {
      const claim = 'Purge Example safe code is 2093';
      const holder = await retiredHolder('notes/sweep-timeout-holder', claim, 64);
      const id = await seed('notes/sweep-timeout', claim);
      const held = await exactHolders(h.brain.engine, holder.id, claim);
      const dry = await h.brain.call('purge_fact', { id, dry_run: true });
      let seen = 0;
      installFaultHook(point => {
        if (point !== 'purge:derivation_sweep') return;
        seen++;
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      });
      let failed: { isError: boolean; body: Record<string, any> };
      try { failed = await h.brain.call('purge_fact', { id, confirm: dry.body.confirm_token, expected_revision: dry.body.expected_revision }); }
      finally { installFaultHook(undefined); }
      expect(seen).toBe(1);
      expect({ isError: failed.isError, code: failed.body.error ?? failed.body.code }).toEqual({ isError: true, code: 'purge_lookup_timeout' });
      expect(failed.body.state).not.toBe('committed');
      const [fact] = await h.brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id=$1', [id]);
      expect(Number(fact!.n)).toBe(1);
      expect(await exactHolders(h.brain.engine, holder.id, claim)).toEqual(held);
      const receipt = await purge(id);
      expect({ rows: await exactHolders(h.brain.engine, holder.id, claim), receipt: derivationStore(receipt)?.status }).toEqual({ rows: [], receipt: 'deleted' });
    }, 600_000);
  });
}

/**
 * A purge deletes a retired row stating the claim in a normalized form (Greek final sigma, Turkish dotted I, case and
 * spacing).
 */
export function registerDerivationPurgeNormalizedCases(kind: 'pglite' | 'postgres'): void {
  describe(`purge leaves no derivation row holding the claim (${kind}): claims stated in a normalized form`, () => {
    const h = derivationPurgeHarness(kind);
    const { seed, purge, complete, retiredHolder, derivationStore } = h;

    for (const variant of [
      { name: 'Greek capitals (final sigma)', claim: 'ΤΟ ΚΛΕΙΔΙ ΤΗΣ ΑΠΟΘΗΚΗΣ ΕΙΝΑΙ 2207', planted: 'ΤΟ ΚΛΕΙΔΙ ΤΗΣ ΑΠΟΘΗΚΗΣ ΕΙΝΑΙ 2207', n: 1 },
      { name: 'Turkish dotted capital I', claim: 'İSTANBUL DEPOSU KODU 6114', planted: 'İSTANBUL DEPOSU KODU 6114', n: 2 },
      { name: 'other case and spacing', claim: 'Purge Example  lift code is 6610', planted: 'purge example LIFT code is 6610', n: 3 },
      { name: 'Greek capitals, stored in lowercase with final sigma', claim: 'Ο ΚΩΔΙΚΟΣ ΤΗΣ ΑΠΟΘΗΚΗΣ ΕΙΝΑΙ 3308', planted: 'ο κωδικος της αποθηκης ειναι 3308', n: 4 },
      { name: 'Greek lowercase with final sigma, stored in capitals', claim: 'ο αριθμος της πορτας ειναι 7719', planted: 'Ο ΑΡΙΘΜΟΣ ΤΗΣ ΠΟΡΤΑΣ ΕΙΝΑΙ 7719', n: 5 },
      { name: 'Turkish dotted capital I, stored as JavaScript lowercases it', claim: 'İZMİR DEPOSU KODU 5521', planted: 'İZMİR DEPOSU KODU 5521'.toLowerCase(), n: 6 },
    ]) {
      test(`a purge deletes a retired row stating the claim in its normalized form: ${variant.name}`, async () => {
        const holder = await retiredHolder(`notes/normalized-holder-${variant.n}`, variant.planted, 50 + variant.n);
        const id = await seed(`notes/normalized-purge-${variant.n}`, variant.claim);
        const receipt = await purge(id);
        expect({ rows: await exactHolders(h.brain.engine, holder.id, variant.planted), receipt: derivationStore(receipt)?.status })
          .toEqual({ rows: [], receipt: 'deleted' });
        complete(receipt);
      }, 600_000);
    }
  });
}

/**
 * A sweep reads bounded batches, resumes from its cursor, refuses rows written behind it, lets other writes commit,
 * starts no batch past its deadline and halves a batch that outruns its statement budget.
 */
export function registerDerivationPurgeBatchingCases(kind: 'pglite' | 'postgres'): void {
  describe(`purge leaves no derivation row holding the claim (${kind}): sweep batches, cursors and deadlines`, () => {
    const h = derivationPurgeHarness(kind);
    const { seed, purge, complete, derivationStore, candidateRowsPage, sourceRows, sweepsRecorded, sweepStatements, confirmed, continueToEnd, completeAfterSweep, bigRowsPage, timeout } = h;

    test('a sweep and its receipt walk thousands of candidate rows in statements of bounded rows, and the purge completes', async () => {
      const claim = 'Purge Example hatch code is 6142', batch = 200, common = 1000, holding = 3;
      const rows = await candidateRowsPage('notes/sweep-batch-rows', claim, common, holding);
      const id = await seed('notes/sweep-batch-purge', claim);
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      try {
        const receipt = await purge(id);
        const sweeps = derivationSweepStatements.filter(s => s.phase === 'sweep'), probes = derivationSweepStatements.filter(s => s.phase === 'probe');
        expect(Math.max(...sweeps.map(s => s.scanned))).toBe(batch);
        expect(sweeps.length).toBeGreaterThanOrEqual(Math.ceil((common + holding) / batch));
        expect(sweeps.slice(0, -1).every(s => s.scanned === batch) && sweeps.at(-1)!.scanned < batch).toBe(true);
        expect(sweeps.reduce((n, s) => n + s.normalized, 0)).toBeGreaterThanOrEqual(common + holding);
        expect(probes.slice(0, -1).every(s => s.scanned === batch) && probes.at(-1)!.scanned < batch).toBe(true);
        expect(probes.reduce((n, s) => n + s.normalized, 0)).toBeGreaterThanOrEqual(common);
        expect(await exactHolders(h.brain.engine, rows, claim)).toEqual([]);
        expect((await h.brain.engine.readSegmentDerivations(rows)).length).toBe(common);
        complete(receipt);
        expect(derivationStore(receipt)?.status).toBe('deleted');
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
    }, 600_000);

    test('a large source\'s sweep resumes from its cursor on each replay and completes with no residual', async () => {
      const claim = 'Purge Example vent code is 8350', batch = 200, holding = 3;
      // A batch of rows ahead of the holders in key order, so the first call's one batch leaves them for a replay.
      await candidateRowsPage('notes/sweep-budget-pad', 'Purge Example padding row is 0006', batch, 0);
      const rows = await candidateRowsPage('notes/sweep-budget-rows', claim, 600, holding);
      const id = await seed('notes/sweep-budget-purge', claim);
      const params = await confirmed(id);
      __setDerivationSweepLimitsForTests({ batchRows: batch, totalMs: 0 });
      __setDerivationSweepWorkForTests(true);
      try {
        const first = await h.brain.call('purge_fact', params);
        expect({ isError: first.isError, state: first.body.state, completion: first.body.completion, sweep: first.body.derivation_sweep, store: derivationStore(first.body)?.status })
          .toEqual({ isError: false, state: 'committed', completion: 'incomplete', sweep: 'pending', store: 'incomplete' });
        expect(sweepStatements().map(s => s.scanned)).toEqual([batch]);
        const [fact] = await h.brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id=$1', [id]);
        expect(Number(fact!.n)).toBe(0);
        let last = first, calls = 1;
        while (last.body.derivation_sweep === 'pending' && calls < 1000) {
          last = await h.brain.call('purge_fact', params);
          calls++;
        }
        const sweeps = sweepStatements(), verifies = derivationSweepStatements.filter(s => s.phase === 'verify');
        expect(calls).toBeGreaterThan(2);
        expect(sweeps.length + verifies.length).toBe(calls);
        expect(sweeps.slice(0, -1).every(s => s.scanned === batch) && sweeps.at(-1)!.scanned < batch).toBe(true);
        expect(sweeps.reduce((n, s) => n + s.scanned, 0)).toBe(await sourceRows() + derivationSweepWork.reduce((n, w) => n + w.deleted, 0));
        expect(verifies.slice(0, -1).every(s => s.scanned === batch) && verifies.at(-1)!.scanned < batch).toBe(true);
        expect(verifies.reduce((n, s) => n + s.scanned, 0)).toBe(await sourceRows());
        expect({ replayed: last.body.replayed, sweep: last.body.derivation_sweep }).toEqual({ replayed: true, sweep: undefined });
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect(await exactHolders(h.brain.engine, rows, claim)).toEqual([]);
      expect((await h.brain.engine.readSegmentDerivations(rows)).length).toBe(600);
      expect(await sweepsRecorded()).toBe(0);
    }, 600_000);

    test('a row holding the claim written behind the sweep\'s cursor while it walks is refused, and no residual is left', async () => {
      const claim = 'Purge Example latch code is 4471', batch = 100;
      const behind = await candidateRowsPage('notes/sweep-behind-early', claim, 0, 1);
      const rows = await candidateRowsPage('notes/sweep-behind-rows', claim, 300, 2);
      const id = await seed('notes/sweep-behind-purge', claim);
      const written: number[] = [];
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      __setAfterDerivationSweepBatchForTests(async () => {
        if (sweepStatements().at(-1)!.scanned < batch) return;
        written.push((await h.brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256,
            context_hash, state, output, receipt) VALUES ($1, 'links', $2, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done',
            jsonb_build_object('candidates', jsonb_build_array(jsonb_build_object('context', 'Late: ' || $3::text))), NULL)
          ON CONFLICT (page_id, pipeline, occurrence_id) DO UPDATE SET output = EXCLUDED.output RETURNING 1`, [behind, 1000 + written.length, claim])).length);
      });
      let receipt: Record<string, any>, status: Record<string, any>;
      try {
        receipt = await purge(id);
        status = await continueToEnd(receipt.request_id);
      } finally {
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect(written.length).toBeGreaterThan(1);
      expect({ written: written.reduce((n, k) => n + k, 0), behind: await exactHolders(h.brain.engine, behind, claim), rows: await exactHolders(h.brain.engine, rows, claim) })
        .toEqual({ written: 0, behind: [], rows: [] });
      await completeAfterSweep(receipt!, status!, claim, 'notes/sweep-behind-purge');
    }, 600_000);

    test('writes to other pages of the source commit while a sweep walks a large source', async () => {
      const claim = 'Purge Example dock code is 3920', batch = 100;
      const rows = await candidateRowsPage('notes/sweep-writer-rows', claim, 300, 1);
      const id = await seed('notes/sweep-writer-purge', claim);
      const results: Array<{ isError: boolean; code: unknown }> = [];
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      __setAfterDerivationSweepBatchForTests(async () => {
        const k = results.length;
        const res = await h.brain.call('put_page', { slug: `notes/sweep-writer-other-${k}`, content: `---\ntype: note\ntitle: Writer Example ${k}\n---\n\nWritten during the sweep.\n`,
          request_id: randomUUID() });
        results.push({ isError: res.isError, code: res.body.error ?? res.body.code ?? null });
      });
      let receipt: Record<string, any>, status: Record<string, any>, statements = 0;
      try {
        receipt = await purge(id);
        status = await continueToEnd(receipt.request_id);
        statements = derivationSweepStatements.filter(s => s.phase !== 'probe').length;
      } finally {
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect(statements).toBeGreaterThan(3);
      expect({ writes: results.length, failed: results.filter(r => r.isError) }).toEqual({ writes: statements, failed: [] });
      const [pages] = await h.brain.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'notes/sweep-writer-other-%'", [SOURCE]);
      expect(Number(pages!.n)).toBe(statements);
      expect(await exactHolders(h.brain.engine, rows, claim)).toEqual([]);
      await completeAfterSweep(receipt!, status!, claim, 'notes/sweep-writer-purge');
    }, 600_000);

    test('a sweep call starts no batch past its deadline, also after the last short batch of a sweep', async () => {
      const claimA = 'Purge Example cellar code is 5307', claimB = 'Purge Example attic code is 6418';
      // Rows ahead of the holder in key order, so the first 100-row batch never reaches it, even when this test runs alone.
      await candidateRowsPage('notes/sweep-deadline-pad', 'Purge Example padding row is 0001', 150, 0);
      const rows = await candidateRowsPage('notes/sweep-deadline-rows', claimA, 300, 1);
      const a = await confirmed(await seed('notes/sweep-deadline-a', claimA));
      const idB = await seed('notes/sweep-deadline-b', claimB);
      try {
        __setDerivationSweepLimitsForTests({ batchRows: 100, totalMs: 0 });
        __setDerivationSweepWorkForTests(true);
        expect((await h.brain.call('purge_fact', a)).body.derivation_sweep).toBe('pending');
        expect(sweepStatements().map(s => s.scanned)).toEqual([100]);
        __setDerivationSweepLimitsForTests({ batchRows: 1_000_000, totalMs: 0 });
        __setDerivationSweepWorkForTests(true);
        const b = await purge(idB);
        const sweeps = sweepStatements();
        expect({ statements: derivationSweepStatements.filter(s => s.phase !== 'probe').length, short: sweeps[0]!.scanned < 1_000_000, sweep: b.derivation_sweep,
          recorded: await sweepsRecorded() }).toEqual({ statements: 1, short: true, sweep: 'pending', recorded: 2 });
        expect(await exactHolders(h.brain.engine, rows, claimA)).toHaveLength(1);
        __setDerivationSweepLimitsForTests(null);
        const replay = await h.brain.call('purge_fact', a);
        expect({ replayed: replay.body.replayed, sweep: replay.body.derivation_sweep, recorded: await sweepsRecorded() })
          .toEqual({ replayed: true, sweep: undefined, recorded: 0 });
        expect(await exactHolders(h.brain.engine, rows, claimA)).toEqual([]);
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
    }, 600_000);

    test('a sweep statement reads at most batchRows rows of the source, rows outside its scope included', async () => {
      const claim = 'Purge Example porch code is 7084', batch = 10;
      await h.brain.seed('notes/sweep-bounded-live', prosePage('Alice Example keeps bees', 65));
      const live = await storedPage(h.brain.engine, 'notes/sweep-bounded-live');
      await deriveAll(h.brain.engine, live);
      const rows = await candidateRowsPage('notes/sweep-bounded-rows', claim, 120, 1);
      const id = await seed('notes/sweep-bounded-purge', claim);
      const outside = (await h.brain.engine.readSegmentDerivations(live.id)).length;
      expect(outside).toBeGreaterThan(batch);
      expect((await unbackedRows(h.brain.engine)).has(live.id)).toBe(false);
      __setDerivationSweepLimitsForTests({ batchRows: batch });
      __setDerivationSweepWorkForTests(true);
      try {
        const receipt = await purge(id);
        const status = await continueToEnd(receipt.request_id);
        const sweeps = sweepStatements();
        expect(sweeps.length).toBeGreaterThan(2);
        expect(sweeps.slice(0, -1).every(s => s.scanned === batch) && sweeps.at(-1)!.scanned < batch).toBe(true);
        expect(sweeps.reduce((n, s) => n + s.scanned, 0)).toBe(await sourceRows() + derivationSweepWork.reduce((n, w) => n + w.deleted, 0));
        expect(derivationSweepWork.find(w => w.pageId === live.id)).toBeUndefined();
        expect(await exactHolders(h.brain.engine, rows, claim)).toEqual([]);
        await completeAfterSweep(receipt, status, claim, 'notes/sweep-bounded-purge');
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
    }, 600_000);

    test('a sweep whose batch outruns its statement budget halves the batch until it fits and completes (30 rows of about 730 KB)', async () => {
      const claim = 'Purge Example kiln code is 4410', fits = 8;
      const rows = await bigRowsPage('notes/sweep-big-rows', claim, 30, 730_000);
      const id = await seed('notes/sweep-big-purge', claim);
      const rounds: number[] = [];
      installFaultHook((point, detail) => {
        if (point !== 'purge:derivation_batch') return;
        rounds.push(Number(detail.round));
        if (Number(detail.round) > fits) throw timeout();
      });
      let receipt: Record<string, any>, status: Record<string, any>;
      try {
        receipt = await purge(id);
        status = await continueToEnd(receipt.request_id);
      } finally { installFaultHook(undefined); }
      expect(rounds.slice(0, 7)).toEqual([500, 250, 125, 62, 31, 15, 7]);
      expect(rounds.slice(7).every(r => r <= 7)).toBe(true);
      expect({ rows: await exactHolders(h.brain.engine, rows, claim), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
      await completeAfterSweep(receipt!, status!, claim, 'notes/sweep-big-purge');
    }, 600_000);
  });
}

/**
 * Rows that enter a sweep's scope while it walks (a retired occurrence, a soft delete, an import open before or
 * during the sweep) are swept before it ends, a sweep ends while writers keep committing, and a sweep blocked on the
 * scope lock says scope_lock_busy until it is free.
 */
export function registerDerivationPurgeScopeCases(kind: 'pglite' | 'postgres'): void {
  describe(`purge leaves no derivation row holding the claim (${kind}): rows entering the scope, open writers and the scope lock`, () => {
    const h = derivationPurgeHarness(kind);
    const { seed, purge, candidateRowsPage, sweepsRecorded, confirmed, continueToEnd, completeAfterSweep, timeout, busyView, busy, scopeKey, advisoryLocks } = h;

    test('a row that enters the sweep\'s scope behind its cursor (its occurrence retired during the last walk) is deleted before the sweep ends', async () => {
      const claim = 'Purge Example cistern code is 6077', planted = 'Alice Example said Purge Example cistern code is 6077';
      await h.brain.seed('notes/sweep-enter-live', prosePage(planted, 66));
      const live = await storedPage(h.brain.engine, 'notes/sweep-enter-live');
      await deriveAll(h.brain.engine, live);
      const held = await exactHolders(h.brain.engine, live.id, planted);
      expect(held.length).toBeGreaterThan(0);
      await candidateRowsPage('notes/sweep-enter-rows', claim, 300, 0);
      const id = await seed('notes/sweep-enter-purge', claim);
      let appended = false;
      __setDerivationSweepLimitsForTests({ batchRows: 50 });
      __setAfterDerivationSweepBatchForTests(async () => {
        if (appended) return;
        const [record] = await h.brain.engine.executeRaw<{ cursor_page: number | null; phase: string | null }>(
          "SELECT cursor_page, to_jsonb(x)->>'phase' AS phase FROM page_segment_derivation_purges x");
        if (!record || record.cursor_page === null || Number(record.cursor_page) <= live.id || (record.phase !== null && record.phase !== 'verify')) return;
        appended = true;
        const res = await h.brain.call('append_page', { slug: 'notes/sweep-enter-live', text: 'Appended note: nothing more.\n', region: 'truth', request_id: randomUUID() });
        expect(res).toMatchObject({ isError: false });
      });
      let receipt: Record<string, any>, status: Record<string, any>;
      try {
        receipt = await purge(id);
        status = await continueToEnd(receipt.request_id);
      } finally {
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
      }
      expect(appended).toBe(true);
      const occurrences = await liveOccurrences(h.brain.engine, live.id);
      expect(held.filter(row => occurrences.has(row.occurrence_id))).toEqual([]);
      expect({ rows: await exactHolders(h.brain.engine, live.id, planted), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
      await completeAfterSweep(receipt!, status!, claim, 'notes/sweep-enter-purge');
    }, 600_000);

    test('a page entering a sweep\'s scope in a transaction still open as the sweep would end is swept after it commits, leaving no row holding the claim', async () => {
      const claim = 'Purge Example well code is 4821', planted = 'Alice Example said Purge Example well code is 4821';
      await h.brain.seed('notes/sweep-race-live', prosePage(planted, 67));
      const live = await storedPage(h.brain.engine, 'notes/sweep-race-live');
      await deriveAll(h.brain.engine, live);
      expect((await exactHolders(h.brain.engine, live.id, planted)).length).toBeGreaterThan(0);
      const params = await confirmed(await seed('notes/sweep-race-purge', claim));
      __setDerivationSweepLimitsForTests({ totalMs: 0 });
      try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
      // The import soft-deletes the page, so its rows enter the sweep's scope; on Postgres it stays open while the sweep runs to its end.
      const softDelete = 'UPDATE pages SET deleted_at = now() WHERE id = $1';
      let commit = async () => {};
      if (kind === 'postgres') {
        const opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const held = (h.brain.engine as any).sql.begin(async (tx: any) => { await tx.unsafe(softDelete, [live.id]); opened.resolve(); await release.promise; });
        await opened.promise;
        commit = async () => { release.resolve(); await held; };
      } else await h.brain.engine.executeRaw(softDelete, [live.id]);
      let open: Record<string, any>;
      try { open = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body; } finally { await commit(); }
      expect(open!.derivation_sweep).toBe(kind === 'postgres' ? 'pending' : undefined);
      const done = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
      expect({ sweep: done.derivation_sweep, rows: await exactHolders(h.brain.engine, live.id, planted), recorded: await sweepsRecorded() })
        .toEqual({ sweep: undefined, rows: [], recorded: 0 });
    }, 600_000);

    test('an import that retired an occurrence before the purge recorded its sweep, still open, keeps the sweep from ending until it commits; then no holder is left', async () => {
      const claim = 'Purge Example silo code is 3947', planted = 'Alice Example said Purge Example silo code is 3947';
      await h.brain.seed('notes/sweep-early-live', prosePage(planted, 68));
      const live = await storedPage(h.brain.engine, 'notes/sweep-early-live');
      await deriveAll(h.brain.engine, live);
      expect((await exactHolders(h.brain.engine, live.id, planted)).length).toBeGreaterThan(0);
      // More than a batch of rows after the page in key order, so only a whole new walk, not a reread of the last batch, reaches its rows.
      await candidateRowsPage('notes/sweep-early-pad', 'Purge Example padding row is 0002', 600, 0);
      const params = await confirmed(await seed('notes/sweep-early-purge', claim));
      // The import retires every live occurrence of the page (its rows leave the live body) before the purge records its sweep; on Postgres it stays open.
      const retire = 'UPDATE page_body_manifest SET gen_to = gen_from + 1000000 WHERE page_id = $1 AND gen_to IS NULL AND staging_id IS NULL';
      let commit = async () => {};
      if (kind === 'postgres') {
        const opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const held = (h.brain.engine as any).sql.begin(async (tx: any) => { await tx.unsafe(retire, [live.id]); opened.resolve(); await release.promise; });
        await opened.promise;
        commit = async () => { release.resolve(); await held; };
      } else await h.brain.engine.executeRaw(retire, [live.id]);
      let first: Record<string, any>, open: Record<string, any>;
      try {
        first = (await h.brain.call('purge_fact', params)).body;
        open = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
      } finally { await commit(); }
      expect({ state: first!.state, open: open!.derivation_sweep }).toEqual({ state: 'committed', open: kind === 'postgres' ? 'pending' : undefined });
      const done = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
      expect({ sweep: done.derivation_sweep, rows: await exactHolders(h.brain.engine, live.id, planted), recorded: await sweepsRecorded() })
        .toEqual({ sweep: undefined, rows: [], recorded: 0 });
    }, 600_000);

    test('a sweep ends while writers bringing pages into its scope keep committing: it waits for the scope lock instead of walking again', async () => {
      const claim = 'Purge Example barn code is 2284';
      const rows = await candidateRowsPage('notes/steady-rows', claim, 300, 1);
      const fillers: number[] = [];
      for (const k of [0, 1]) {
        await h.brain.engine.putPage(`notes/steady-filler-${k}`, { type: 'note', title: 'Steady Filler', compiled_truth: 'Steady filler.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
        fillers.push(Number((await h.brain.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, `notes/steady-filler-${k}`]))[0]!.id));
      }
      const params = await confirmed(await seed('notes/steady-purge', claim));
      __setDerivationSweepLimitsForTests({ batchRows: 100, totalMs: 0 });
      try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
      // Each write soft-deletes a page of the source (the trigger takes the scope lock shared and notes the page) and restores it after it commits. On
      // Postgres two writers overlap, each holding the lock 300 ms, so one always holds it; PGLite has one connection, so one write runs after each batch.
      let running = true, commits = 0;
      const errors: unknown[] = [];
      const write = async (tx: { unsafe: (q: string, p?: unknown[]) => Promise<unknown> }, page: number) => {
        await tx.unsafe('UPDATE pages SET deleted_at = now() WHERE id = $1', [page]);
        if (kind === 'postgres') await tx.unsafe('SELECT pg_sleep(0.3)');
      };
      const writers: Promise<void>[] = [];
      if (kind === 'postgres') {
        const sql = (h.brain.engine as any).sql;
        for (const [i, page] of fillers.entries()) writers.push((async () => {
          await Bun.sleep(150 * i);
          while (running) {
            try {
              await sql.begin((tx: any) => write(tx, page));
              await sql.unsafe('UPDATE pages SET deleted_at = NULL WHERE id = $1', [page]);
              commits++;
            } catch (error) { errors.push(error); return; }
          }
        })());
        while (commits < 2) await Bun.sleep(50);
      } else {
        __setAfterDerivationSweepBatchForTests(async () => {
          await write({ unsafe: (q, p) => h.brain.engine.executeRaw(q, p as unknown[]) }, fillers[commits % 2]!);
          await h.brain.engine.executeRaw('UPDATE pages SET deleted_at = NULL WHERE id = $1', [fillers[commits % 2]]);
          commits++;
        });
      }
      const before = commits;
      let status: Record<string, any> = {}, calls = 0, during = 0;
      __setDerivationSweepLimitsForTests({ batchRows: 100, totalMs: 2_000 });
      try {
        do {
          status = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
          calls++;
        } while (status.derivation_sweep === 'pending' && calls < 10);
        during = commits - before;
      } finally {
        running = false;
        await Promise.all(writers);
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
      }
      expect({ errors, sweep: status.derivation_sweep, wrote: during > 0 }).toEqual({ errors: [], sweep: undefined, wrote: true });
      expect({ rows: await exactHolders(h.brain.engine, rows, claim), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
    }, 600_000);

    test('a sweep whose end waits past its bound on a write holding the scope lock says so (scope_lock_busy) until the write ends and the sweep finishes', async () => {
      const claim = 'Purge Example quarry code is 3371';
      const rows = await candidateRowsPage('notes/busy-hook-rows', claim, 50, 1);
      const params = await confirmed(await seed('notes/busy-hook-purge', claim));
      __setDerivationSweepLimitsForTests({ totalMs: 0 });
      try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
      // The hook models a write in the source holding the scope lock (55P03: the try fails, the bounded wait times out); PGLite has one connection.
      let open = true, tried = 0;
      installFaultHook(point => {
        if (point !== 'purge:derivation_scope_lock' || !open) return;
        tried++;
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      });
      try {
        const held = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
        expect({ tried: tried >= 2, ...await busyView(params.request_id, held) }).toEqual({ tried: true, ...busy });
        const again = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id }).then(r => r.body));
        expect(await busyView(params.request_id, again)).toEqual(busy);
        open = false;
        const done = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
        const [clear] = await derivationPurgeSweepsEntry.run({ engine: h.brain.engine } as never) as Array<Record<string, any>>;
        expect({ sweep: done.derivation_sweep, reason: done.derivation_sweep_reason, doctor: clear!.status }).toEqual({ sweep: undefined, reason: undefined, doctor: 'ok' });
      } finally { installFaultHook(undefined); }
      expect({ rows: await exactHolders(h.brain.engine, rows, claim), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
    }, 600_000);

    test('scope_lock_busy is cleared when a busy sweep stalls and when it is retried, so a retry that fails leaves no busy reason without a writer', async () => {
      const claim = 'Purge Example cooper code is 4927';
      await candidateRowsPage('notes/busy-cycle-rows', claim, 50, 1);
      const params = await confirmed(await seed('notes/busy-cycle-purge', claim));
      __setDerivationSweepLimitsForTests({ totalMs: 0 });
      try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
      const column = async () => (await h.brain.engine.executeRaw<{ pending_reason: string | null }>(`SELECT x.pending_reason FROM page_segment_derivation_purges x
        JOIN persistence_requests r ON r.id = x.request_id WHERE r.request_id::text = $1`, [params.request_id]))[0]?.pending_reason ?? null;
      const doctorReason = async () => ((await derivationPurgeSweepsEntry.run({ engine: h.brain.engine } as never) as Array<Record<string, any>>)[0]!.details.records as
        Array<Record<string, any>>).find(r => r.request_id === params.request_id)?.reason ?? null;
      const status = async (resume: boolean) => h.brain.call('purge_fact', { status: true, request_id: params.request_id, ...(resume ? { continue: true } : {}) });
      // 1. A write holds the scope lock past the wait: the sweep is busy.
      let mode: 'busy' | 'stall' | 'drop' | 'off' = 'busy';
      installFaultHook(point => {
        if (mode === 'busy' && point === 'purge:derivation_scope_lock') throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        if (mode === 'stall' && (point === 'purge:derivation_batch' || point === 'purge:derivation_unread')) throw timeout();
        if (mode === 'drop' && point === 'purge:derivation_batch') throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      });
      const seen: Array<Record<string, unknown>> = [];
      try {
        const busyBody = (await status(true)).body;
        seen.push({ step: 'busy', sweep: busyBody.derivation_sweep, reason: busyBody.derivation_sweep_reason ?? null, column: await column(), doctor: await doctorReason() });
        // 2. The writer is gone; the sweep's next batch outruns its budget down to one row, and the unread delete too: it stalls.
        mode = 'stall';
        const stalled = (await status(true)).body;
        seen.push({ step: 'stall', sweep: stalled.derivation_sweep, reason: stalled.derivation_sweep_reason ?? null, column: await column(), doctor: await doctorReason() });
        // 3. Its retry loses its connection after clearing the stall: no writer is open, so no busy reason may come back.
        mode = 'drop';
        const dropped = await status(true);
        const after = (await status(false)).body;
        seen.push({ step: 'retry', failed: dropped.isError, sweep: after.derivation_sweep, reason: after.derivation_sweep_reason ?? null, column: await column(), doctor: await doctorReason() });
        // 4. A retry that runs finishes the sweep.
        mode = 'off';
        const done = (await status(true)).body;
        seen.push({ step: 'done', sweep: done.derivation_sweep, reason: done.derivation_sweep_reason ?? null, recorded: await sweepsRecorded() });
      } finally { installFaultHook(undefined); }
      expect(seen).toEqual([
        { step: 'busy', sweep: 'pending', reason: 'scope_lock_busy', column: 'scope_lock_busy', doctor: 'scope_lock_busy' },
        { step: 'stall', sweep: 'stalled', reason: 'statement_timeout', column: null, doctor: 'statement_timeout' },
        { step: 'retry', failed: true, sweep: 'pending', reason: null, column: null, doctor: null },
        { step: 'done', sweep: undefined, reason: null, recorded: 0 },
      ]);
    }, 600_000);

    if (kind === 'postgres') {
      test('a write holding the scope lock longer than the sweep\'s wait leaves it pending with scope_lock_busy; once the write commits the sweep finishes and the reason is gone', async () => {
        const claim = 'Purge Example forge code is 8142';
        const rows = await candidateRowsPage('notes/busy-lock-rows', claim, 50, 1);
        const params = await confirmed(await seed('notes/busy-lock-purge', claim));
        __setDerivationSweepLimitsForTests({ totalMs: 0 });
        try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
        const sql = (h.brain.engine as any).sql;
        const opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const writer = sql.begin(async (tx: any) => { await tx.unsafe(`SELECT pg_advisory_xact_lock_shared(${scopeKey})`); opened.resolve(); await release.promise; });
        await opened.promise;
        let held: Record<string, any> = {}, waited = 0;
        try {
          const t0 = performance.now();
          held = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
          waited = performance.now() - t0;
          expect({ waited: waited >= DERIVATION_SWEEP_LIMITS.finalizeWaitMs, ...await busyView(params.request_id, held) }).toEqual({ waited: true, ...busy });
        } finally {
          release.resolve();
          await writer;
        }
        const done = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
        const [clear] = await derivationPurgeSweepsEntry.run({ engine: h.brain.engine } as never) as Array<Record<string, any>>;
        expect({ sweep: done.derivation_sweep, reason: done.derivation_sweep_reason, doctor: clear!.status }).toEqual({ sweep: undefined, reason: undefined, doctor: 'ok' });
        expect({ rows: await exactHolders(h.brain.engine, rows, claim), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
      }, 600_000);

      test('a sweep waiting for the scope lock holds no other lock, and writes that arrive meanwhile queue behind it', async () => {
        const claim = 'Purge Example mill code is 6630';
        const rows = await candidateRowsPage('notes/wait-rows', claim, 50, 1);
        const params = await confirmed(await seed('notes/wait-purge', claim));
        __setDerivationSweepLimitsForTests({ totalMs: 0 });
        try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
        const sql = (h.brain.engine as any).sql;
        const opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const writer = sql.begin(async (tx: any) => { await tx.unsafe(`SELECT pg_advisory_xact_lock_shared(${scopeKey})`); opened.resolve(); await release.promise; });
        await opened.promise;
        // The wait is long enough here for the test to look at it; the call still stops at its sweep deadline otherwise.
        __setDerivationSweepLimitsForTests({ totalMs: 5_000, finalizeWaitMs: 60_000 });
        let resumed: Promise<{ body: Record<string, any> }> | undefined, late: Promise<unknown> | undefined;
        let waiter: { pid: number } | undefined, held: unknown[] = ['not looked at'], queued = false;
        try {
          resumed = h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true });
          for (let i = 0; i < 300 && !waiter; i++) {
            [waiter] = await advisoryLocks(sql, 'ExclusiveLock');
            if (!waiter) await Bun.sleep(100);
          }
          if (waiter) {
            held = await sql.unsafe(`SELECT locktype, mode FROM pg_locks WHERE pid = $1 AND granted AND locktype <> 'virtualxid'`, [waiter.pid]);
            late = sql.begin((tx: any) => tx.unsafe(`SELECT pg_advisory_xact_lock_shared(${scopeKey})`));
            for (let i = 0; i < 300 && !queued; i++) {
              queued = (await advisoryLocks(sql, 'ShareLock')).length > 0;
              if (!queued) await Bun.sleep(50);
            }
          }
        } finally {
          release.resolve();
          await writer;
        }
        const done = (await resumed!).body;
        await late;
        __setDerivationSweepLimitsForTests(null);
        expect({ waiting: waiter !== undefined, held, queued, sweep: done.derivation_sweep }).toEqual({ waiting: true, held: [], queued: true, sweep: undefined });
        expect({ rows: await exactHolders(h.brain.engine, rows, claim), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
      }, 600_000);

      test('an import that retired an occurrence before the purge recorded its sweep and commits after the last walk passed its page leaves no holder', async () => {
        const claim = 'Purge Example mine code is 5829', planted = 'Alice Example said Purge Example mine code is 5829';
        await h.brain.seed('notes/sweep-late-commit-live', prosePage(planted, 69));
        const live = await storedPage(h.brain.engine, 'notes/sweep-late-commit-live');
        await deriveAll(h.brain.engine, live);
        expect((await exactHolders(h.brain.engine, live.id, planted)).length).toBeGreaterThan(0);
        await candidateRowsPage('notes/sweep-late-commit-pad', 'Purge Example padding row is 0005', 600, 0);
        const params = await confirmed(await seed('notes/sweep-late-commit-purge', claim));
        const sql = (h.brain.engine as any).sql;
        const opened = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        let open = true;
        const held = sql.begin(async (tx: any) => {
          await tx.unsafe('UPDATE page_body_manifest SET gen_to = gen_from + 1000000 WHERE page_id = $1 AND gen_to IS NULL AND staging_id IS NULL', [live.id]);
          opened.resolve();
          await release.promise;
        });
        await opened.promise;
        const commit = async () => { if (!open) return; open = false; release.resolve(); await held; };
        let phase: string | null = null;
        __setDerivationSweepLimitsForTests({ batchRows: 100, totalMs: 0 });
        try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
        // The import commits as soon as a verify walk is past the page, so that walk never sees the rows it brought into the scope.
        __setDerivationSweepLimitsForTests({ batchRows: 100 });
        __setAfterDerivationSweepBatchForTests(async () => {
          const [record] = await h.brain.engine.executeRaw<{ cursor_page: number | null; phase: string }>('SELECT cursor_page, phase FROM page_segment_derivation_purges');
          if (open && record?.phase === 'verify' && record.cursor_page !== null && Number(record.cursor_page) > live.id) await commit();
        });
        try {
          await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true });
          if (open) [{ phase }] = await h.brain.engine.executeRaw<{ phase: string }>('SELECT phase FROM page_segment_derivation_purges');
        } finally {
          await commit();
          __setAfterDerivationSweepBatchForTests(null);
        }
        const done = await continueToEnd(params.request_id);
        __setDerivationSweepLimitsForTests(null);
        expect({ phase, sweep: done.derivation_sweep, rows: await exactHolders(h.brain.engine, live.id, planted), recorded: await sweepsRecorded() })
          .toEqual({ phase: 'sweep', sweep: undefined, rows: [], recorded: 0 });
      }, 600_000);
    }
  });
}

/**
 * A row that alone outruns the budget stalls only its sweep; paid rows are never deleted unread; a purge returns
 * pending and --continue finishes it; the receipt probe and doctor report a pending, verified or residual sweep.
 */
export function registerDerivationPurgeStallsCases(kind: 'pglite' | 'postgres'): void {
  describe(`purge leaves no derivation row holding the claim (${kind}): stalls, paid work, receipts and doctor`, () => {
    const h = derivationPurgeHarness(kind);
    const { seed, purge, complete, derivationStore, candidateRowsPage, sweepsRecorded, sweepStatements, confirmed, continueToEnd, bigRowsPage, timeout, unreadFixture } = h;

    test('a row that alone outruns the budget stalls its sweep without blocking a later purge, and --status --continue finishes it once it fits', async () => {
      const claimA = 'Purge Example furnace code is 5521', claimB = 'Purge Example rarely seen chimney code 9930';
      const rowsA = await bigRowsPage('notes/sweep-stall-rows', claimA, 30, 730_000);
      const a = await confirmed(await seed('notes/sweep-stall-a', claimA));
      const idB = await seed('notes/sweep-stall-b', claimB);
      let stalledId: string | undefined, blocked = true, unread = 0;
      installFaultHook((point, detail) => {
        if (point !== 'purge:derivation_batch' && point !== 'purge:derivation_unread') return;
        stalledId ??= detail.requestId;
        if (!blocked || detail.requestId !== stalledId) return;
        if (point === 'purge:derivation_unread') unread++;
        throw timeout();
      });
      try {
        const first = await h.brain.call('purge_fact', a);
        expect({ state: first.body.state, completion: first.body.completion, exit: first.body.exit_code, sweep: first.body.derivation_sweep, unread })
          .toEqual({ state: 'committed', completion: 'incomplete', exit: 75, sweep: 'stalled', unread: 1 });
        expect((first.body.next as string[]).some(n => n.includes(`gbrain forget --purge --status --request-id ${a.request_id} --continue`))).toBe(true);
        const b = await purge(idB);
        expect({ completion: b.completion, sweep: b.derivation_sweep }).toEqual({ completion: b.completion === 'complete' ? 'complete' : 'committed', sweep: undefined });
        complete(b);
        const still = await h.brain.call('purge_fact', { status: true, request_id: a.request_id });
        expect({ sweep: still.body.derivation_sweep, completion: still.body.completion }).toEqual({ sweep: 'stalled', completion: 'incomplete' });
        expect((await exactHolders(h.brain.engine, rowsA, claimA)).length).toBeGreaterThan(0);
        blocked = false;
        const resumed = await h.brain.call('purge_fact', { status: true, request_id: a.request_id, continue: true });
        expect({ sweep: resumed.body.derivation_sweep, completion: resumed.body.completion === 'incomplete' ? 'incomplete' : 'done' }).toEqual({ sweep: undefined, completion: 'done' });
      } finally { installFaultHook(undefined); }
      expect({ rows: await exactHolders(h.brain.engine, rowsA, claimA), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
    }, 600_000);

    test('an unread delete keeps the row of a page restored after the sweep picked it (the scope is checked in the DELETE)', async () => {
      const fixture = await unreadFixture('unread-restore', 'links', true);
      installFaultHook(point => { if (point === 'purge:derivation_batch') throw timeout(); });
      __setBeforeUnreadDerivationDeleteForTests(async tx => { await tx.executeRaw('UPDATE pages SET deleted_at = NULL WHERE id = $1', [fixture.page]); });
      try { await continueDerivationPurges(h.brain.engine, 'unread-restore', { first: fixture.requestId }); } finally {
        installFaultHook(undefined);
        __setBeforeUnreadDerivationDeleteForTests(null);
      }
      expect({ rows: await fixture.rows(), sweep: await derivationPurgeState(h.brain.engine, fixture.requestId) }).toEqual({ rows: 1, sweep: null });
    }, 600_000);

    test('a paid row that alone outruns the budget is never deleted unread: the sweep stalls with a named reason, and a retry that fits sweeps it', async () => {
      const fixture = await unreadFixture('unread-paid', 'synopsis', false);
      installFaultHook(point => { if (point === 'purge:derivation_batch') throw timeout(); });
      try { await continueDerivationPurges(h.brain.engine, 'unread-paid', { first: fixture.requestId }); } finally { installFaultHook(undefined); }
      expect({ rows: await fixture.rows(), sweep: await derivationPurgeState(h.brain.engine, fixture.requestId) })
        .toEqual({ rows: 1, sweep: { state: 'stalled', reason: 'paid_row_unreadable' } });
      await continueDerivationPurges(h.brain.engine, 'unread-paid', { first: fixture.requestId, retry: fixture.requestId });
      expect({ rows: await fixture.rows(), sweep: await derivationPurgeState(h.brain.engine, fixture.requestId) }).toEqual({ rows: 1, sweep: null });
    }, 600_000);

    test('a purge returns pending once it recorded its sweep and its own bounded call ran, and --status --continue finishes it', async () => {
      const claim = 'Purge Example gate code is 7302';
      const rows = await candidateRowsPage('notes/sweep-inline-rows', claim, 300, 1);
      const params = await confirmed(await seed('notes/sweep-inline-purge', claim));
      __setDerivationSweepLimitsForTests({ batchRows: 100, inlineMs: 0 });
      __setDerivationSweepWorkForTests(true);
      try {
        const first = (await h.brain.call('purge_fact', params)).body;
        expect({ sweep: first.derivation_sweep, completion: first.completion, exit: first.exit_code, statements: sweepStatements().length })
          .toEqual({ sweep: 'pending', completion: 'incomplete', exit: 75, statements: 1 });
        expect((first.next as string[]).some(n => n.includes(`gbrain forget --purge --status --request-id ${params.request_id} --continue`))).toBe(true);
        const done = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
        expect(done.derivation_sweep).toBeUndefined();
      } finally {
        __setDerivationSweepLimitsForTests(null);
        __setDerivationSweepWorkForTests(false);
      }
      expect({ rows: await exactHolders(h.brain.engine, rows, claim), recorded: await sweepsRecorded() }).toEqual({ rows: [], recorded: 0 });
    }, 600_000);

    test('a receipt probe stopped by its deadline reports a verified, finished sweep\'s result and says so; with the sweep pending it is unverified and next continues it', async () => {
      const claimA = 'Purge Example dock code is 5190', claimB = 'Purge Example pier code is 6203';
      const rowsA = await candidateRowsPage('notes/sweep-probe-rows-a', claimA, 20, 2);
      const idA = await seed('notes/sweep-probe-a', claimA);
      __setPurgeProbeLimitsForTests({ totalMs: 0 });
      let verified: Record<string, any>;
      try { verified = await purge(idA); } finally { __setPurgeProbeLimitsForTests(null); }
      const store = derivationStore(verified!)! as Record<string, any>;
      expect({ sweep: verified!.derivation_sweep, status: store.status, reason: store.reason, probe: store.probe, rows: await exactHolders(h.brain.engine, rowsA, claimA) })
        .toEqual({ sweep: undefined, status: 'deleted', reason: 'verified_by_sweep', probe: 'verification_deadline', rows: [] });
      complete(verified!);
      await candidateRowsPage('notes/sweep-probe-rows-b', claimB, 20, 2);
      const params = await confirmed(await seed('notes/sweep-probe-b', claimB));
      __setPurgeProbeLimitsForTests({ totalMs: 0 });
      __setDerivationSweepLimitsForTests({ totalMs: 0 });
      let pending: Record<string, any>;
      try { pending = (await h.brain.call('purge_fact', params)).body; } finally {
        __setPurgeProbeLimitsForTests(null);
        __setDerivationSweepLimitsForTests(null);
      }
      const open = derivationStore(pending!)! as Record<string, any>;
      expect({ sweep: pending!.derivation_sweep, status: open.status, reason: open.reason }).toEqual({ sweep: 'pending', status: 'unverified', reason: 'verification_deadline' });
      expect((pending!.next as string[]).some(n => n.includes(`gbrain forget --purge --status --request-id ${params.request_id} --continue`))).toBe(true);
      const done = (await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body;
      expect({ sweep: done.derivation_sweep, recorded: await sweepsRecorded() }).toEqual({ sweep: undefined, recorded: 0 });
    }, 600_000);

    test('doctor names a pending sweep with its request id and the command that continues it, and fact receipts it blocked point there, not at the spend cap', async () => {
      const claim = 'Purge Example loft code is 8461';
      await candidateRowsPage('notes/sweep-doctor-rows', claim, 300, 0);
      const params = await confirmed(await seed('notes/sweep-doctor-purge', claim));
      __setDerivationSweepLimitsForTests({ batchRows: 50, totalMs: 0 });
      try { expect((await h.brain.call('purge_fact', params)).body.derivation_sweep).toBe('pending'); } finally { __setDerivationSweepLimitsForTests(null); }
      const [check] = await derivationPurgeSweepsEntry.run({ engine: h.brain.engine } as never) as Array<Record<string, any>>;
      const command = `gbrain forget --purge --status --request-id ${params.request_id} --continue`;
      expect({ status: check!.status, named: check!.message.includes(params.request_id), argv: check!.fix?.argv, category: categorizeCheck('derivation_purge_sweeps') })
        .toEqual({ status: 'warn', named: true, argv: command.split(' '), category: 'brain' });
      expect(check!.details.records).toContainEqual(expect.objectContaining({ request_id: params.request_id, state: 'pending', command }));
      const page = await storedPage(h.brain.engine, 'notes/sweep-doctor-purge');
      await h.brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
        VALUES ($1, 'conversation_facts', 999999, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'partial', '{"windows":[]}'::jsonb,
          jsonb_build_object('kind', 'unread_windows', 'pipeline', 'conversation_facts', 'reason', 'purge_sweep_pending', 'windows_read', 0, 'windows_total', 2))`, [page.id]);
      const [truncated] = (await extractionInputTruncatedEntry.run({ engine: h.brain.engine } as never) as Array<Record<string, any>>).filter(c => c.name === 'extraction_input_truncated');
      const group = (truncated!.details.groups as Array<Record<string, any>>).find(g => g.pipeline === 'conversation_facts' && g.kind === 'purge_sweep_pending');
      expect({ remedy: group?.remedy.includes('derivation_purge_sweeps'), cap: group?.remedy.includes(PAGE_DERIVATION_CAP_KEY) }).toEqual({ remedy: true, cap: false });
      await h.brain.engine.executeRaw("DELETE FROM page_segment_derivations WHERE page_id=$1 AND pipeline='conversation_facts' AND occurrence_id=999999", [page.id]);
      expect((await h.brain.call('purge_fact', { status: true, request_id: params.request_id, continue: true })).body.derivation_sweep).toBeUndefined();
      const [clear] = await derivationPurgeSweepsEntry.run({ engine: h.brain.engine } as never) as Array<Record<string, any>>;
      expect(clear!.status).toBe('ok');
    }, 600_000);

    test('a row holding the claim that the receipt probe counts after the sweep ended is reported, never covered by the sweep\'s verification, and --continue sweeps it', async () => {
      const claim = 'Purge Example vault code is 7716', planted = 'Late: Purge Example vault code is 7716';
      const late = await candidateRowsPage('notes/probe-late-rows', 'Purge Example padding row is 0003', 30, 0);
      await candidateRowsPage('notes/probe-late-pad', 'Purge Example padding row is 0004', 30, 0);
      const params = await confirmed(await seed('notes/probe-late-purge', claim));
      let plantedRows = 0, probes = 0;
      // Once the sweep has ended (its record is gone) a writer stores a row holding the claim first in key order, so the probe's first statement counts it.
      __setAfterDerivationSweepBatchForTests(async () => {
        if (plantedRows || await sweepsRecorded()) return;
        plantedRows = (await h.brain.engine.executeRaw(`INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash,
            state, output, receipt) VALUES ($1, 'links', 0, 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'done',
            jsonb_build_object('candidates', jsonb_build_array(jsonb_build_object('context', $2::text))), NULL) RETURNING 1`, [late, planted])).length;
      });
      // Every later probe statement outruns its budget, down to a single row: the probe stops at statement_deadline.
      installFaultHook(point => { if (point === 'purge:derivation_probe' && probes++ > 0) throw timeout(); });
      __setDerivationSweepLimitsForTests({ batchRows: 10 });
      let first: Record<string, any>;
      try { first = (await h.brain.call('purge_fact', params)).body; } finally {
        installFaultHook(undefined);
        __setAfterDerivationSweepBatchForTests(null);
        __setDerivationSweepLimitsForTests(null);
      }
      const store = derivationStore(first!)! as Record<string, any>;
      expect({ planted: plantedRows, status: store.status, remaining: store.remaining, probe: store.probe, sweep: first!.derivation_sweep, completion: first!.completion })
        .toEqual({ planted: 1, status: 'incomplete', remaining: 1, probe: 'statement_deadline', sweep: 'pending', completion: 'incomplete' });
      expect((first!.next as string[]).some(n => n.includes(`gbrain forget --purge --status --request-id ${params.request_id} --continue`))).toBe(true);
      const done = await continueToEnd(params.request_id);
      expect({ sweep: done.derivation_sweep, rows: await exactHolders(h.brain.engine, late, planted), recorded: await sweepsRecorded() }).toEqual({ sweep: undefined, rows: [], recorded: 0 });
    }, 600_000);
  });
}
