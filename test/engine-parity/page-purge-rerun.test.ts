/**
 * Engine parity: a page purge (`delete_page --purge`, src/core/persistence/page-purge.ts purgePageInTransaction) whose
 * transaction runs again, and the purge mirror's intent lines it leaves.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the page purge appends its mirror `intent` line (appendPurgeIntent) inside its transaction, before the commit.
 *    When that transaction runs again (a multi-user Rust `write_conflict`, a Postgres serialization retry), the page is
 *    purged once, and each run leaves one intent line. Every run names the same `request` (the persistence request row's
 *    id, admitted before the transaction) and reads the same source, epoch, content hashes, facts, takes and lifetimes,
 *    so the lines differ only in `recorded_at`. A restore from a backup older than the purge then replays that request
 *    once, with the outcome a purge with no rerun gets: the uncommitted run's line is covered, never `unverified` (a false
 *    doctor warning that asks the user to check a purge that is complete).
 *  - Regression probe: a fact purge's runs each admit their own request, so the run that did not commit is covered only
 *    by a match on every other field (purge-mirror.ts purgeTargetKey). A page purge line also carries `facts`, `takes`
 *    and `lifetimes`; a run that read one of them differently would read `unverified` on that rule. This file shows the
 *    page purge's runs share their request and every field but the time, so no such warning shows.
 *  - Why existing coverage misses it: page-purge.test.ts and belief-purge-ledger.test.ts purge with no rerun; the
 *    multi-user lanes meet a rerun only under contention, by chance.
 *  - Seam: force-rerun.ts forces the transaction run that reads the purged page's stored body (`readPurgePageBody`, called
 *    only by purgePageInTransaction) once. On a multi-user Rust brain the forced run ends with write_conflict, so the
 *    engine's own optimistic retry runs the callback again; every other arm runs it once in a transaction it rolls back
 *    and once for real. The restore case replays the mirror with raw SQL (a PGLite or Postgres restore), so it declares
 *    `requires: 'raw_sql'` and the Rust arm refuses it by design. It stands in for a backup older than the purge by
 *    removing the requests' tombstones (fact_purges, take_purges, page_purges) before the replay. Generated values (ids, times) are compared by relation.
 *  - Not forced on the served Rust arm (GBRAIN_TEST_RUST_SERVED=1): the owner runs the transaction out of the case's reach,
 *    and the served arm's PGLite reference runs unforced too, so both expect one run.
 *  - Real contention on a multi-user or served Rust brain: the owner's background writers commit keys the purge reads,
 *    so its transaction can run again on top of the forced run. Two writers do it: the effect runner's settlement
 *    true-up (receipt-true-up.ts trueUpRequests, which writes the persistence counter row `brain` the purge locks), and
 *    the purge's own publication claim stamp (consumer.ts holdClaimForPublication, renewWriteClaim on the request row),
 *    which an effect claim read and lost, so the effect claim's retry holds that row's queue when the purge reads it
 *    (occ_kv.rs row-lock queueing). There the case asserts at least the expected runs, and that every line names one
 *    request and one target, which is what lets the restore replay them once.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { purgeMirrorPath, readPurgeMirror, replayPurgesInRestore, type PurgeMirrorIntent, type PurgeMirrorLine } from '../../src/core/belief/purge-mirror.ts';
import { enableBeliefCoverage, parityArms, type ParityBackend } from './harness.ts';
import { rustMuArmRequested, rustServedRequested } from './rust-arm.ts';
import { forceRerunOnHit, type ForcedRerun } from './force-rerun.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'default';
const ARCHIVED_AT = '2000-01-01T00:00:00.000Z';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

const localCtx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {}, debug() {} },
  dryRun: false, remote: false, sourceId: SRC }) as unknown as OperationContext;
const fence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const notePage = (title: string, claim: string) => ['---', `title: ${title}`, 'type: note', '---', `# ${title}`, '', `${title} notes.`, '', '## Facts', '', fence(claim), ''].join('\n');

/** On the multi-user arm the engine must take the optimistic path, or the case proves nothing about it. */
function assertArm(engine: BrainEngine, backend: ParityBackend, rerun: ForcedRerun | null): void {
  if (backend === 'rust' && rustMuArmRequested() && !rustServedRequested()) {
    expect((engine as { multiuser?: boolean }).multiuser).toBe(true);
    expect(rerun?.seen.multiuser).toBe(true);
  }
}

/** A multi-user or served Rust brain, where the owner's background writers can make the purge's transaction run again. */
const contended = (engine: BrainEngine, backend: ParityBackend) =>
  backend === 'rust' && (rustServedRequested() || (engine as { multiuser?: boolean }).multiuser === true);

const inHome = async <T>(fn: () => Promise<T>): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-page-purge-rerun-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); } finally { rmSync(home, { recursive: true, force: true }); }
};

/** Writes a page with one fact on a ledger source, then purges it; `force` makes the purge's transaction run twice. */
async function purgePage(engine: BrainEngine, slug: string, force: boolean) {
  await operationsByName.put_page.handler(localCtx(engine), { slug, content: notePage(slug.split('/')[1]!, `The ${slug} gate code is 7731`), request_id: randomUUID() });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: SRC });
  const requestId = randomUUID();
  const rerun = force && !rustServedRequested() ? forceRerunOnHit(engine, { members: ['readPurgePageBody'], limit: 1 }) : null;
  let outcome: Record<string, unknown>;
  try {
    outcome = await operationsByName.delete_page.handler(localCtx(engine), { slug, purge: true, request_id: requestId, expected_revision: snapshot?.revision }) as Record<string, unknown>;
  } finally { rerun?.restore(); }
  const lines = readPurgeMirror(purgeMirrorPath()) ?? [];
  const intents = lines.filter((l): l is PurgeMirrorIntent => l.kind === 'intent' && l.request_id === requestId);
  const committed = new Set(lines.filter(l => l.kind === 'committed').map(l => l.request));
  return { outcome, rerun, lines, intents, committed };
}

/** The fields of an intent line that name what it purges: everything but the time. */
const target = ({ recorded_at: _t, ...rest }: PurgeMirrorIntent) => JSON.stringify(Object.keys(rest).sort().map(k => [k, rest[k as keyof typeof rest]]));
/** The fields that differ between two lines, by name. */
const differing = (a: PurgeMirrorIntent, b: PurgeMirrorIntent) => Object.keys({ ...a, ...b }).filter(k => k !== 'recorded_at'
  && JSON.stringify(a[k as keyof PurgeMirrorIntent]) !== JSON.stringify(b[k as keyof PurgeMirrorIntent])).sort();

describe('engine parity: a page purge whose transaction runs again', () => {
  parityTest('a page purge whose transaction runs twice purges once and leaves one intent line per run, each naming the same request and target', {
    methods: ['readPageSnapshot', 'readPurgePageBody', 'getPage', 'countPagePurgeTombstones'],
    timeout: 120_000,
  }, async (engine, backend) => inHome(async () => {
    opened.push(engine);
    await enableBeliefCoverage(engine, backend, SRC);
    const { outcome, rerun, intents, committed } = await purgePage(engine, 'notes/doomed', true);
    assertArm(engine, backend, rerun);
    const result = {
      status: outcome.status,
      page: await engine.getPage('notes/doomed', { sourceId: SRC, includeDeleted: true }) === null ? 'gone' : 'present',
      tombstoned: (await engine.countPagePurgeTombstones(SRC, 'notes/doomed')) > 0,
      forced: rerun ? rerun.seen.forced : null,
      intent_lines: intents.length,
      // One persistence request, admitted before the transaction: every run names it, and it is committed.
      requests: new Set(intents.map(i => i.request)).size,
      request_committed: intents.every(i => committed.has(i.request)),
      // Fields that differ between the runs' lines (none, or the restore rule could read the lost run's line as unverified).
      differing: [...new Set(intents.slice(1).flatMap(i => differing(intents[0]!, i)))].sort(),
      // Every run's line names one target: the restore replays the request once, whichever line it reads.
      targets: new Set(intents.map(target)).size,
      carries: { facts: intents[0]!.facts.length > 0, lifetimes: intents[0]!.lifetimes.length > 0, content_hashes: (intents[0]!.content_hashes ?? []).length > 0 },
    };
    // The forced run, plus any run real contention adds where the owner's background writers share the brain.
    const minLines = rustServedRequested() ? 1 : 2;
    if (contended(engine, backend)) expect(result.intent_lines).toBeGreaterThanOrEqual(minLines);
    else expect(result.intent_lines).toBe(minLines);
    expect({ ...result, intent_lines: null }).toEqual({ status: 'purged', page: 'gone', tombstoned: true, forced: rustServedRequested() ? null : 1,
      intent_lines: null, requests: 1, request_committed: true, differing: [], targets: 1,
      carries: { facts: true, lifetimes: true, content_hashes: true } });
    return { ...result, forced: null, intent_lines: null };
  }));

  // The restore replay is raw SQL (a PGLite or Postgres restore); the Rust arm refuses raw_sql by design.
  parityTest('a restore from a backup older than the purge replays the rerun purge once, as it does a purge with no rerun, never as unverified', {
    methods: ['readPageSnapshot', 'readPurgePageBody', 'readPurgeReplaySchema'],
    requires: 'raw_sql',
    timeout: 120_000,
  }, async (engine, backend) => inHome(async () => {
    opened.push(engine);
    await enableBeliefCoverage(engine, backend, SRC);
    const plain = await purgePage(engine, 'notes/plain', false);
    const rerun = await purgePage(engine, 'notes/doomed', true);
    assertArm(engine, backend, rerun.rerun);
    // A backup taken before both purges holds neither request's page tombstones.
    const requests = [...new Set([...plain.intents, ...rerun.intents].map(i => i.request))];
    await engine.transaction(async tx => {
      for (const table of ['fact_purges', 'take_purges', 'page_purges']) await tx.executeRaw(`DELETE FROM ${table} WHERE request_id = ANY($1::uuid[])`, [requests]);
    });
    const lines: PurgeMirrorLine[] = rerun.lines;
    const restore = await engine.transaction(tx => replayPurgesInRestore(tx, { lines, archivedAt: ARCHIVED_AT, restoreId: 'page-rerun-restore' }));
    const outcomeOf = (intents: PurgeMirrorIntent[]) => restore.replays.filter(r => r.request === intents[0]!.request).map(r => r.outcome);
    const result = { intent_lines: rerun.intents.length, plain: outcomeOf(plain.intents), rerun: outcomeOf(rerun.intents),
      unverified: restore.replays.filter(r => r.outcome === 'unverified').length };
    // The served arm does not force, and its PGLite reference runs unforced too.
    expect(result.intent_lines).toBe(rustServedRequested() ? 1 : 2);
    expect(result.rerun).toEqual(result.plain);
    expect(result.rerun).toHaveLength(1);
    expect(result.unverified).toBe(0);
    // Both runs' lines name one target, so the restore cannot pick a line that purges something else.
    expect(new Set(rerun.intents.map(target)).size).toBe(1);
    return result;
  }));
});
