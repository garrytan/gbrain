/**
 * A typed Postgres write must still write on a server whose default is read-only (#7183).
 *
 * A pooler hands out server connections whose `default_transaction_read_only` is on; an autocommit write then fails with
 * 25006 "cannot execute INSERT in a read-only transaction". master's `executeRaw` runs the refused statement once more in
 * BEGIN READ WRITE. The trunk moved master's raw writes behind typed members, and a member that runs on the plain engine
 * executor (`engineSql`) lost that retry: five of them (upsertOpenLoop, closeOpenLoop, expireMemoryProposals,
 * purgeMemoryProposals, attachSourcePath) failed on a pooler until 24d52666d2 put them back on `autocommitSql`.
 *
 * This test reads src/core/postgres-engine.ts (test/helpers/postgres-write-executor-audit.ts) for every typed member that
 * writes and fails, naming the member and its line, when one runs its statements through an executor with no read-only
 * retry and no transaction. It needs no database.
 *
 * 1. Which members write: the owner socket's route table. A member forwarded to the Rust brain's owner is a write unless
 *    owner-ipc/typed-member-classes.ts lists it as a read (an unlisted member counts as a write, so a new member is checked
 *    until it is classified). Every public member of the engine is in that table, bar the three names listed below.
 * 2. The audit: each write's executor, with the getters it goes through (`cliReads`, `linkTemporal` ... are `engineSql`).
 * 3. The five fixed members and a sample of the others run on a fake server whose default is read-only.
 *
 * KNOWN_UNGUARDED_AS_ON_MASTER lists the writes that run on `engineSql` or a bare `this.sql` in master's postgres-engine.ts
 * (275870ad21) too: master has the same gap there, so the trunk did not lose anything. The list is exact: a member that
 * gains the retry must leave it, and a member that is not on it fails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { OWNER_IPC_ROUTES, ownerMemberOnlyReads } from '../src/core/rust-engine/owner-ipc/routes.ts';
import { auditWrites, declaredMembers, executorReferences } from './helpers/postgres-write-executor-audit.ts';
import { makeFakeSql, type RecordedStatement } from './helpers/fake-postgres-sql.ts';

// test-reads-source-ok[structural]: the guard audits which executor each typed write member runs on, so it reads the engine's own member bodies.
const ENGINE_SOURCE = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'postgres-engine.ts'), 'utf8');

/** Public engine members that are not on the owner socket: none of them writes. */
const NOT_ON_OWNER_SOCKET: readonly string[] = ['onCheckout', 'getPoolDiagnostics', 'explainVectorSearch'];

const forwarded = Object.entries(OWNER_IPC_ROUTES).filter(([, route]) => route === 'forward').map(([member]) => member);
const WRITES = forwarded.filter(member => !ownerMemberOnlyReads(member));

/**
 * Writes that run on `engineSql` (or `this.sql`) in master 275870ad21 as well. Not a regression of the trunk; the retry is
 * master's to give them. initSchema and runMigration are DDL on the schema pool.
 */
const KNOWN_UNGUARDED_AS_ON_MASTER: readonly string[] = [
  'initSchema', 'deletePage', 'deletePages', 'softDeletePage', 'softDeletePages', 'purgeDeletedPages', 'refreshPageBody',
  'updatePageContextualRetrievalState', 'migrateFactsToCanonical', 'updateSourceConfig', 'setPageEmbeddingSignature',
  'ownerOnlyMarkTriggers', 'deleteChunks', 'markPagesExtractedBatch', 'markPagesAttendanceBlocked', 'stripStaleFrontmatterKeys',
  'addLink', 'addLinksBatch', 'removeLinksByPagesAndSource', 'removeLink', 'addTimelineEntry', 'addTimelineEntriesBatch',
  'upsertEventProjection', 'mergeOntologyFact', 'putRawData', 'upsertFile', 'putDreamVerdict', 'sweepDreamVerdicts',
  'insertFact', 'expireFact', 'insertFacts', 'deleteFactsForPage', 'consolidateFact', 'allocateBodyOccurrenceIds',
  'stageSegmentTexts', 'stageManifestRows', 'stageSegmentChunks', 'createSegmentedPageShell', 'flipBodyGeneration',
  'sealSegmentedPage', 'openBodyStaging', 'setBodyStagingState', 'sweepSegments', 'upsertSegmentDerivations',
  'retireSegmentDerivations', 'addTakesBatch', 'writeContradictionsRun', 'putContradictionCacheEntry',
  'sweepContradictionCache', 'updateTakeEmbeddings', 'updateTake', 'supersedeTake', 'resolveTake', 'addSynthesisEvidence',
  'revertToVersion', 'logIngest', 'setConfig', 'unsetConfig', 'runMigration', 'addCodeEdges', 'deleteCodeEdgesForChunks',
  'deleteEvalCandidatesBefore', 'logEvalCaptureFailure', 'setEmotionalWeightBatch',
];

describe('the typed writes the audit covers', () => {
  // Value: protects=a new engine member is classified (route table) before it can skip the audit; fails_when=a public
  // member of PostgresEngine is in neither the owner route table nor the three-name list; why_new=the audit takes its write
  // list from the table; seam=none; no_claim=the table's read list is right (test/rust-owner-ipc-read-classes.test.ts scans it)
  test('every public engine member is in the owner route table or listed as outside it', () => {
    const declared = declaredMembers(ENGINE_SOURCE);
    const methods = [...declared.entries()].filter(([name, d]) => d.kind !== 'getter' && !/^\s*(private|protected)\b/.test(d.text) && !name.startsWith('_') && name !== 'constructor');
    const unrouted = methods.map(([name]) => name).filter(name => !(name in OWNER_IPC_ROUTES) && !NOT_ON_OWNER_SOCKET.includes(name)
      && typeof (PostgresEngine.prototype as unknown as Record<string, unknown>)[name] === 'function');
    expect(unrouted).toEqual([]);
    expect(WRITES.length).toBeGreaterThan(500);
  });

  test('every write is declared in the engine, and the three outside the table are not writes', () => {
    const { missing } = auditWrites(ENGINE_SOURCE, WRITES);
    expect(missing).toEqual([]);
    expect(NOT_ON_OWNER_SOCKET.filter(name => name in OWNER_IPC_ROUTES)).toEqual([]);
  });
});

describe('a typed write runs through an executor that retries a read-only refusal', () => {
  // Value: protects=a typed write moved off executeRaw keeps its read-only retry; fails_when=a write member's own text
  // reaches engineSql, a bare this.sql or a getter built on them (cliReads, linkTemporal, writeMiscReads) with no engine
  // transaction, `_pageTransaction` branch or retryReadOnlyAutocommit beside it, and the member is not in
  // KNOWN_UNGUARDED_AS_ON_MASTER; why_new=24d52666d2 fixed five members by hand after master's pooler test caught them;
  // seam=none; no_claim=a guarded member's helpers write through guarded executors (the audit reads the member's own text)
  test('no write outside the master baseline runs on an executor with no retry', () => {
    const { audits } = auditWrites(ENGINE_SOURCE, WRITES);
    const unguarded = audits.filter(a => a.verdict === 'unguarded');
    const fresh = unguarded.filter(a => !KNOWN_UNGUARDED_AS_ON_MASTER.includes(a.member));
    expect(fresh.map(a => `src/core/postgres-engine.ts:${a.line} ${a.member} runs on ${a.unguarded.join(', ')} with no read-only retry (use this.autocommitSql)`)).toEqual([]);
  });

  test('the master baseline names only members that still write and still lack the retry', () => {
    const { audits } = auditWrites(ENGINE_SOURCE, WRITES);
    const unguarded = new Set(audits.filter(a => a.verdict === 'unguarded').map(a => a.member));
    expect(KNOWN_UNGUARDED_AS_ON_MASTER.filter(member => !unguarded.has(member))).toEqual([]);
    expect(new Set(KNOWN_UNGUARDED_AS_ON_MASTER).size).toBe(KNOWN_UNGUARDED_AS_ON_MASTER.length);
  });
});

describe('the audit flags the members as they were before 24d52666d2 and passes them after', () => {
  const engineClass = (lines: string[]) => `class PostgresEngine {\n${lines.join('\n')}\n}`;
  // The five lines of src/core/postgres-engine.ts at b7b18e5ab3 (the batch 10 head), byte for byte.
  const BEFORE = [
    "  expireMemoryProposals(reason: string) { return whenNotAborted(() => writeMiscImpl.expireMemoryProposals(this.engineSql, reason)); }",
    "  purgeMemoryProposals(retentionDays: number) { return whenNotAborted(() => writeMiscImpl.purgeMemoryProposals(this.engineSql, retentionDays)); }",
    "  attachSourcePath(sourceId: string, localPath: string, opts?: writeMiscImpl.AttachSourcePathOptions) { return whenNotAborted(() => writeMiscImpl.attachSourcePath(this.engineSql, sourceId, localPath, opts)); }",
    "  upsertOpenLoop(loop: OpenLoopUpsertInput) { return whenNotAborted(() => openLoopsImpl.upsertOpenLoop(this.engineSql, loop)); }",
    "  closeOpenLoop(sourceId: string | null, id: number, status: string, closedBy: string) { return whenNotAborted(() => openLoopsImpl.closeOpenLoop(this.engineSql, sourceId, id, status, closedBy)); }",
  ];
  const FIVE = ['expireMemoryProposals', 'purgeMemoryProposals', 'attachSourcePath', 'upsertOpenLoop', 'closeOpenLoop'];

  // Value: protects=the guard fails on the five members' shape, so it is not vacuous; fails_when=the audit passes a member
  // on engineSql; why_new=the guard is new; seam=none; no_claim=the lines match the file today (the real-file test above does)
  test('engineSql: all five are unguarded', () => {
    const { audits } = auditWrites(engineClass(BEFORE), FIVE);
    expect(audits.map(a => [a.member, a.verdict])).toEqual(FIVE.map(member => [member, 'unguarded']));
  });

  test('autocommitSql: all five are guarded', () => {
    const { audits } = auditWrites(engineClass(BEFORE.map(line => line.replace('this.engineSql', 'this.autocommitSql'))), FIVE);
    expect(audits.map(a => [a.member, a.verdict])).toEqual(FIVE.map(member => [member, 'guarded']));
  });

  test('a getter built on engineSql is unguarded, a transaction branch and the retry helper guard', () => {
    const source = engineClass([
      "  private get linkTemporal() { return unscopedExecutor(this.engineSql, 'link temporal'); }",
      "  writeThroughGetter(x: number) { return impl.write(this.linkTemporal, x); }",
      "  writeThroughTransaction(x: number) { return this._pageTransaction ? impl.write(this.engineSql, x) : this.transaction(tx => impl.write((tx as PostgresEngine).engineSql, x)); }",
      "  writeThroughRetry(x: number) { return retryReadOnlyAutocommit(this.sql, c => impl.write(this.engineSqlOn(c), x)); }",
      "  writeThroughRaw(x: number) { return impl.write(this, x); }",
      "  writeThroughDelegate(x: number) { return this.writeThroughGetter(x); }",
    ]);
    const names = ['writeThroughGetter', 'writeThroughTransaction', 'writeThroughRetry', 'writeThroughRaw', 'writeThroughDelegate'];
    const { audits } = auditWrites(source, names);
    expect(audits.map(a => [a.member, a.verdict])).toEqual([
      ['writeThroughGetter', 'unguarded'], ['writeThroughTransaction', 'guarded'], ['writeThroughRetry', 'guarded'],
      ['writeThroughRaw', 'guarded'], ['writeThroughDelegate', 'unguarded'],
    ]);
    expect(executorReferences('writeThroughGetter', declaredMembers(source), new Set(names))).toEqual(['engineSql']);
  });
});

describe('on a server whose default is read-only', () => {
  const READ_ONLY = Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
  const WRITE = /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b|^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b/i;

  /** A pool statement is refused as the server's default would refuse it; a statement inside begin() runs (BEGIN READ WRITE). */
  function readOnlyEngine() {
    const fake = makeFakeSql((stmt: RecordedStatement) => (stmt.lane === 'pool' && WRITE.test(stmt.text) ? READ_ONLY : undefined));
    const engine = new PostgresEngine() as unknown as Record<string, any>;
    engine._sql = fake.sql;
    engine._connectionStyle = 'instance';
    return { engine, fake };
  }
  const ranInTransaction = (fake: ReturnType<typeof makeFakeSql>) => fake.statements().some(s => s.lane === 'tx' && WRITE.test(s.text));

  // Value: protects=the audit's premise (autocommitSql retries, engineSql does not) holds in the code; fails_when=the
  // autocommit executor stops retrying a 25006 refusal or the engine executor starts to; why_new=the guard rests on it;
  // seam=none; no_claim=a real server's behavior (test/e2e/pooler-inherited-read-only-7183.test.ts runs that)
  test('autocommitSql retries a refused write in a read-write transaction and engineSql does not', async () => {
    const insert = 'INSERT INTO sources (id, name) VALUES ($1, $1)';
    const retrying = readOnlyEngine();
    await retrying.engine.autocommitSql.executeRaw(insert, ['a']);
    expect(ranInTransaction(retrying.fake)).toBe(true);
    const plain = readOnlyEngine();
    await expect(plain.engine.engineSql.executeRaw(insert, ['a'])).rejects.toMatchObject({ code: '25006' });
    expect(ranInTransaction(plain.fake)).toBe(false);
  });

  // Value: protects=the typed writes master's pooler test pins keep the retry, plus a sample of the members that moved
  // off executeRaw; fails_when=one of them rejects with 25006 on a refused autocommit write; why_new=the five members
  // regressed at the sync; seam=none; no_claim=every member runs here (the audit covers the rest by reading the source)
  const CALLS: Array<[string, (e: any) => Promise<unknown>]> = [
    ['expireMemoryProposals', e => e.expireMemoryProposals('lapsed')],
    ['purgeMemoryProposals', e => e.purgeMemoryProposals(30)],
    ['attachSourcePath', e => e.attachSourcePath('src-a', '/work/a')],
    ['closeOpenLoop', e => e.closeOpenLoop('src-a', 1, 'done', 'manual')],
    ['upsertOpenLoop', e => e.upsertOpenLoop({
      sourceId: 'src-a', dedupKey: 'thread:a', loopType: 'unanswered_inbound', counterpartyEmail: 'a@example.com', summary: 's',
      evidence: [{ message_id: 'm1', quote: 'hi' }], threadId: 't-a', detector: 'deterministic_thread',
    })],
    ['insertSource', e => e.insertSource({ id: 'src-a', name: 'src-a', local_path: null, config: {} })],
    ['writeSourceSyncHeartbeat', e => e.writeSourceSyncHeartbeat('src-a')],
    ['archiveSource', e => e.archiveSource('src-a', 24)],
    ['addLoopSuppression', e => e.addLoopSuppression('src-a', 'sender', 'a@example.com')],
    ['bumpSourcePurgeEpoch', e => e.bumpSourcePurgeEpoch('src-a')],
  ];
  for (const [member, call] of CALLS) {
    test(`${member} writes`, async () => {
      const { engine, fake } = readOnlyEngine();
      const outcome = await call(engine).then(() => undefined, (error: unknown) => error);
      expect((outcome as { code?: string } | undefined)?.code).not.toBe('25006');
      expect(ranInTransaction(fake)).toBe(true);
    });
  }
});
