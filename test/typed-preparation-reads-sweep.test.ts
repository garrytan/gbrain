/**
 * Typed engine reads that replaced a raw statement inside write preparation keep the preparation deadline the raw
 * statement had through the preparer's bounded view (persistence/bounded-reads.ts `TYPED_PREPARATION_READS`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for every read in the table, on Postgres and through either preparer view (with or without
 *    `engineReads`), the read past the budget is refused before its statement is sent; a read stalled on its connection
 *    ends at the clock's abort with the abort reason and its connection is discarded; the claim's last statement names
 *    the read. Without a deadline the read's statement goes out as before. On PGLite a preparer's view is the engine
 *    itself, so the read, like the raw statement it replaced, takes no deadline and answers past the budget.
 *  - Regression: each read replaced a raw statement a preparer sent through its bounded view; outside the set the
 *    typed read ran on the plain pool, so a lock or a dead connection held the preparation past its deadline.
 *  - Why existing coverage misses it: the deadline tests cover the seal-state read and the caller access reads only.
 *  - Seam: the recording fake postgres.js client (test/helpers/fake-postgres-sql.ts); PGLite runs in memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { boundedReads, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { makeFakeSql, type FakeSql } from './helpers/fake-postgres-sql.ts';
import { KEYWORD_STATEMENT_TIMEOUT_CONFIG_SQL } from '../src/core/postgres-engine/keyword-statement-timeout.ts';

/** [member, a fragment of its statement, a call of it that sends the statement, the engine state the call assumes] */
const members: ReadonlyArray<readonly [string, string, (e: BrainEngine) => Promise<unknown>, ((e: PostgresEngine) => void)?]> = [
  ['listGuestSourceIds', 'SELECT s.id FROM sources s WHERE s.id = ANY', e => e.listGuestSourceIds(['default'])],
  ['readDatabaseClock', 'clock_timestamp()', e => e.readDatabaseClock()],
  ['listStoredTimelineRowsOrdered', 'FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL', e => e.listStoredTimelineRowsOrdered(1)],
  ['matchTakeRows', 'FROM takes k', e => e.matchTakeRows(1, [{ row_num: 1, claim: 'a claim', kind: 'take', holder: 'self' }], 10)],
  ['listFactWithdrawalDates', 'JOIN fact_withdrawals w', e => e.listFactWithdrawalDates('default', [{ row_num: 1, claim: 'a claim', visibility: 'world' }], null)],
  ['listCorePageRows', 'FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter @>', e => e.listCorePageRows({ limit: 10 })],
  ['lockRegisteredSourceIds', 'FROM sources WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', e => e.lockRegisteredSourceIds(['default'])],
  ['getConfig', 'SELECT value FROM config WHERE key = $1', e => e.getConfig('a.key')],
  // The sync.admission read (persistence/sync-admission.ts readSyncAdmission) a managed sync and a keep_db reconcile prepare with.
  ['readStoredConfigValue', 'SELECT value FROM config WHERE key=$1', e => e.readStoredConfigValue('sync.admission')],
  ['readCredentialMemberId', 'SELECT member_id FROM access_tokens WHERE id::text = $1', e => e.readCredentialMemberId({ kind: 'token', id: 'token-1' })],
  ['readCredentialMemberId', 'SELECT member_id FROM oauth_clients WHERE client_id = $1', e => e.readCredentialMemberId({ kind: 'client', id: 'client-1' })],
  ['readLinkedMember', 'FROM access_member_links l JOIN access_members m', e => e.readLinkedMember('qm', 'person-1')],
  ['getAllConfig', 'SELECT key, value FROM config', e => e.getAllConfig()],
  ['listConfigKeys', 'SELECT key FROM config WHERE key LIKE', e => e.listConfigKeys('a.')],
  ['readPageSnapshot', 'WITH chosen AS (', e => e.readPageSnapshot('a', { sourceId: 'default' })],
  ['getPage', 'WITH chosen AS (', e => e.getPage('a', { sourceId: 'default' })],
  ['findDuplicatePage', 'SELECT id, slug FROM pages', e => e.findDuplicatePage!('default', { hash: 'h' })],
  ['findByTitleFuzzy', 'SELECT slug, similarity(title,', e => e.findByTitleFuzzy('A title', undefined, 0.55, 'default')],
  ['readSegmentTexts', 'FROM page_segment_texts t', e => e.readSegmentTexts('default', [new Uint8Array(32)])],
  ['readManifest', 'FROM page_body_manifest m', e => e.readManifest(1)],
  // The fact-fence adoption's facts read (prepared-maintenance.ts `readFacts`), unlocked in preparation.
  ['readFactSnapshots', 'AS value FROM facts f', e => e.readFactSnapshots('default', [1], false)],
  // The segmented-storage writer gate a page or sync preparation reads through readPageBodyPolicy (page-body/limits.ts).
  ['readSegmentedGateEvidence', 'FROM ingest_log l CROSS JOIN win', e => e.readSegmentedGateEvidence(7)],
  // A remote sync job's checks in validateSyncAuthority (sync-authority.ts): the source's creation time and a legacy token's row.
  ['readJobSourceState', 'SELECT archived, created_at, local_path, config FROM sources WHERE id = $1', e => e.readJobSourceState('default')],
  ['readJobPrincipal', 'FROM access_tokens WHERE id = $1', e => e.readJobPrincipal({ kind: 'legacy_token', id: '00000000-0000-4000-8000-000000000001' })],
  // Page preparation reads an OAuth client's member binding (persistence/page-visibility.ts defaultSourceMemberWriter).
  ['readOauthClient', 'FROM oauth_clients WHERE client_id', e => e.readOauthClient('a-client')],
  ['hasLabelledOnlyMember', 'FROM access_members WHERE labelled_only', e => e.hasLabelledOnlyMember()],
  // A labelled-only test of the writer's members (persistence/page-visibility.ts assertLabelledOnlyCreate via labelledOnlyFor).
  ['hasLabelledOnlyMemberAmong', 'FROM access_members WHERE labelled_only AND id = ANY', e => e.hasLabelledOnlyMemberAmong(['alice-example'])],
  ['readSegmentedPageHead', 'segmenter_version, knowledge_revision::text AS revision FROM pages WHERE id=$1', e => e.readSegmentedPageHead(1)],
  // The segmented write path's reads a page preparation makes (stageSegmentedImport, the seal probe, chunk-vector reuse): raw statements on the bounded view before the Rust store served them.
  ['readSegmentedLivePage', 'FROM pages WHERE id=$1', e => e.readSegmentedLivePage(1)],
  ['listChunkedOccurrences', 'FROM unnest($2::bigint[]) AS o', e => e.listChunkedOccurrences(1, [1], 1)],
  ['readRetiredChunkVectors', 'FROM content_chunks c JOIN pages p ON p.id = c.page_id', e => e.readRetiredChunkVectors(1, [1], 'embedding')],
  ['hasStaleSegmentChunks', 'WITH RECURSIVE occ(o) AS', e => e.hasStaleSegmentChunks(1, 1, [1])],
  // The withdrawal overlay a page preparation runs on the incoming file (overlayCanonicalBodiesTyped in page-prepare.ts):
  // the fence normalization and the '*' purge lookup, raw statements on the bounded view before they were typed.
  ['normalizeFenceLines', 'string_to_array', e => e.normalizeFenceLines(['a'], [''])],
  ['listGlobalPurgeWithdrawals', 'fact_purges', e => e.listGlobalPurgeWithdrawals('default', ['h'], false)],
  ['readSourceIncarnation', 'SELECT config,incarnation FROM sources WHERE id=$1', e => e.readSourceIncarnation('default')],
  ['readStoredPageTier', 'SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', e => e.readStoredPageTier('default', 'a')],
  ['readJournalCeiling', 'SELECT max(sequence)::text AS ceiling FROM persistence_requests', e => e.readJournalCeiling('default')],
  ['sweepJournalChunk', 'WITH chunk AS MATERIALIZED', e => e.sweepJournalChunk({ sourceId: 'default', needles: ['a claim'], after: '0', ceiling: '9', limit: 10, ids: null, exclude: null })],
  // The page purge's preparation (persistence/page-purge.ts preparePagePurge) and the managed sync's purged-page screen.
  ['listPurgeClaimFacts', 'SELECT id,fact,source FROM facts WHERE source_id=', e => e.listPurgeClaimFacts('default', 'notes/a')],
  ['listPurgeClaimTakes', 'SELECT id,claim FROM takes WHERE page_id=$1', e => e.listPurgeClaimTakes(1)],
  ['listQueuedPagePurges', 'FROM persistence_requests r\n    LEFT JOIN pages p', e => e.listQueuedPagePurges('default', '0', 7)],
  ['listPageLinkStreams', 'SELECT DISTINCT COALESCE(o.slug, f.slug) AS slug FROM links l', e => e.listPageLinkStreams('default', 1)],
  ['listPagePurgeTombstones', 'SELECT content_hash,slug FROM page_purges WHERE source_id=$1', e => e.listPagePurgeTombstones('default', 10)],
  // The segmented-storage writer gate a page or sync preparation reads through readPageBodyPolicy (page-body/limits.ts).
  ['readSegmentedGateEvidence', 'FROM ingest_log l CROSS JOIN win', e => e.readSegmentedGateEvidence(7)],
  // The segmented body's chunk reads a page preparation makes (page-body/ingest.ts, import-chunk-reuse.ts, page-body/projection.ts).
  ['listChunkedOccurrences', 'FROM unnest($2::bigint[]) AS o', e => e.listChunkedOccurrences(1, [1], 1)],
  ['readRetiredChunkVectors', 'SELECT c.chunk_text, c.chunk_source', e => e.readRetiredChunkVectors(1, [1], 'embedding')],
  ['hasStaleSegmentChunks', 'WITH RECURSIVE occ(o) AS', e => e.hasStaleSegmentChunks(1, 1, [1])],
  // The withdrawal overlay a page preparation runs on the incoming file (overlayCanonicalBodiesTyped in page-prepare.ts):
  // the fence normalization and the '*' purge lookup, raw statements on the bounded view before they were typed.
  ['normalizeFenceLines', 'string_to_array', e => e.normalizeFenceLines(['a'], [''])],
  ['listGlobalPurgeWithdrawals', 'fact_purges', e => e.listGlobalPurgeWithdrawals('default', ['h'], false)],
  // The link preparation's alias and source slug reads (persistence/links-preparation.ts).
  ['readLiveSlugAliases', 'FROM slug_aliases a', e => e.readLiveSlugAliases('default', ['a'])],
  ['readSourceSlugProbe', 'hashtextextended(slug, 0)', e => e.readSourceSlugProbe('default', 0)],
  // The owner write's reads of the stored page (persistence/page-visibility.ts ownerRewriteOf, authorizePageVisibility's hiddenUnder and probe).
  ['readPagePrivacyHidden', 'AS hidden FROM pages p', e => e.readPagePrivacyHidden('default', 'a')],
  ['readLinkTargetPages', 'AS visible', e => e.readLinkTargetPages('default', ['a'], null)],
  ['readWriteVisibilityProbe', 'AS identity_may_open', e => e.readWriteVisibilityProbe('default', 'a')],
  // The keyword timeout is resolved once per engine; its own read under a deadline has the test below.
  ['searchKeyword', 'count(*) OVER () AS bounded_rows', e => e.searchKeyword('a title', { limit: 3, sourceId: 'default' }), keywordTimeoutResolved],
];
const views = [['managed sync (engineReads)', { engineReads: true }], ['page/maintenance preparer', {}]] as const;
const never = () => new Promise<never>(() => {});

function fakeEngine(fake: FakeSql, setup?: (e: PostgresEngine) => void): PostgresEngine {
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  setup?.(engine);
  return engine;
}

function keywordTimeoutResolved(e: PostgresEngine): void {
  (e as unknown as { keywordStatementTimeout: Promise<string> }).keywordStatementTimeout = Promise.resolve('8000ms');
}

describe('typed preparation reads keep the preparation deadline (Postgres)', () => {
  for (const [name, mark, run, setup] of members) {
    test(`without a deadline ${name} sends its statement as before`, async () => {
      const fake = makeFakeSql();
      await run(boundedReads(fakeEngine(fake, setup), startClaimPhase())).catch(() => undefined);
      expect(fake.statements().some(s => s.text.includes(mark))).toBe(true);
    });

    for (const [view, opts] of views) {
      test(`${view}: ${name} past the budget is refused before its statement is sent`, async () => {
        const fake = makeFakeSql();
        const reads = boundedReads(fakeEngine(fake, setup), startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts);
        const error = await run(reads).then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(PreparationDeadlineError);
        expect((error as PreparationDeadlineError).sqlstate).toBeNull();
        expect(fake.statements().filter(s => s.text.includes(mark))).toEqual([]);
      });

      test(`${view}: ${name} stalled on its connection ends at the clock's abort and discards the connection`, async () => {
        const counts = { discards: 0, releases: 0 };
        const fake = makeFakeSql(stmt => (stmt.text.includes(mark) ? never() : undefined));
        const reserve = fake.sql.reserve;
        fake.sql.reserve = async () => {
          const r = await reserve();
          r.discard = () => { counts.discards++; };
          const release = r.release;
          r.release = () => { counts.releases++; release(); };
          return r;
        };
        const controller = new AbortController();
        const reason = { code: 'preparation_deadline' };
        const clock = startClaimPhase(Date.now(), controller.signal, 60_000);
        const call = run(boundedReads(fakeEngine(fake, setup), clock, opts));
        setTimeout(() => controller.abort(reason), 20);
        const outcome = await Promise.race([call.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
        expect(outcome).toBe(reason);
        expect(counts).toEqual({ discards: 1, releases: 0 });
        expect(clock.lastSql?.label).toBe(`SELECT ${name}`);
      });
    }
  }
});

describe('a store a preparer opens through its bounded view keeps the preparation deadline (Postgres)', () => {
  // Page preparation asks whether an earlier write waits on an import through the publication journal store
  // (persistence/page-prepare.ts compareFileTarget); the store's statement replaced a raw one the view bounded.
  const mark = 'r.deferred_import_from IS NOT NULL';
  const run = async (e: BrainEngine) => (await e.publicationJournalStore()).heldBehindImport('default', 'a', 2);

  test('without a deadline the store sends its statement as before', async () => {
    const fake = makeFakeSql();
    await run(boundedReads(fakeEngine(fake), startClaimPhase())).catch(() => undefined);
    expect(fake.statements().some(s => s.text.includes(mark))).toBe(true);
  });

  for (const [view, opts] of views) {
    test(`${view}: the store's read past the budget is refused before its statement is sent`, async () => {
      const fake = makeFakeSql();
      const reads = boundedReads(fakeEngine(fake), startClaimPhase(Date.now() - 2_000, undefined, 1_000), opts);
      const error = await run(reads).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(PreparationDeadlineError);
      expect((error as PreparationDeadlineError).sqlstate).toBeNull();
      expect(fake.statements().filter(s => s.text.includes(mark))).toEqual([]);
    });

    test(`${view}: the store's read stalled on its connection ends at the clock's abort`, async () => {
      const fake = makeFakeSql(stmt => (stmt.text.includes(mark) ? never() : undefined));
      const controller = new AbortController();
      const reason = { code: 'preparation_deadline' };
      const clock = startClaimPhase(Date.now(), controller.signal, 60_000);
      const call = run(boundedReads(fakeEngine(fake), clock, opts));
      setTimeout(() => controller.abort(reason), 20);
      const outcome = await Promise.race([call.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
      // It ends as the raw statement did through the view's `executeRaw`: rejected at the abort, not left pending.
      expect(outcome === reason || (outcome as Error).name === 'AbortError').toBe(true);
      expect(clock.lastSql?.label).toContain('persistence_requests');
    });
  }
});

describe('searchKeyword under a preparation deadline: the keyword timeout config read', () => {
  test('a stalled read of the timeout ends at the clock\'s abort, the failure is not kept, and the timeout stays inside the time left', async () => {
    let stall = true;
    const fake = makeFakeSql(stmt => (stmt.text.includes(KEYWORD_STATEMENT_TIMEOUT_CONFIG_SQL) && stall ? never() : undefined));
    const engine = fakeEngine(fake);
    const controller = new AbortController();
    const reason = { code: 'preparation_deadline' };
    const call = boundedReads(engine, startClaimPhase(Date.now(), controller.signal, 60_000)).searchKeyword('a title', { limit: 3, sourceId: 'default' });
    setTimeout(() => controller.abort(reason), 20);
    const outcome = await Promise.race([call.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
    expect(outcome).toBe(reason);
    stall = false;
    const before = fake.statements().filter(s => s.text.includes(KEYWORD_STATEMENT_TIMEOUT_CONFIG_SQL)).length;
    await boundedReads(engine, startClaimPhase(Date.now(), undefined, 2_000)).searchKeyword('a title', { limit: 3, sourceId: 'default' });
    expect(fake.statements().filter(s => s.text.includes(KEYWORD_STATEMENT_TIMEOUT_CONFIG_SQL)).length).toBe(before + 1);
    const timeouts = fake.statements().filter(s => s.text.includes('set_config') && s.text.includes('statement_timeout'));
    expect(timeouts.length).toBeGreaterThan(0);
    const last = timeouts.at(-1)!;
    const slot = Number(/set_config\('statement_timeout', \$(\d+)/.exec(last.text)![1]);
    expect(Number(last.params[slot - 1])).toBeLessThanOrEqual(2_000);
  });
});

describe('typed preparation reads on PGLite match the raw statements: no preparation deadline', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  for (const [name, , run] of members) {
    test(`${name} answers past the budget`, async () => {
      const view = boundedReads(engine, startClaimPhase(Date.now() - 2_000, undefined, 1_000));
      expect(view).toBe(engine);
      await run(view);
    });
  }
});
