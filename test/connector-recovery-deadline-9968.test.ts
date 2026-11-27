import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { readManagedConnectorState, writeManagedConnectorState, type ConnectorRunFailure } from '../src/core/persistence/connector-state.ts';
import { connectorStatusLines, readConnectorLastError, readConnectorSourceStatuses } from '../src/core/persistence/connector-status.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { initializeLocalPersistence } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, githubFetch, sourceCheckpoint, withGoogleAccount, settleConnectorWrites } from './helpers/connector-fixture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * #9968: a managed connector sync run as a job (with the job's deadline) used to ignore that deadline, so a long Gmail
 * backfill was killed at the job timeout every time, recorded nothing, and the connector kept showing a
 * `recovery_required` stop recorded before the upgrade although no retained publication was left. Fake Gmail and GitHub.
 */
const { engines, env, source: plainSource, boundSource, standaloneConnector, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
type GmailState = { gmail_backfill_done?: boolean; gmail_backfill_floor_ms?: number | null };
const config = { ...googleConfig, g_services: 'gmail', g_history_days: 400 };

/** 100 archive threads, 40..139 days old: one listing, four 25-thread batches. */
const OLD = Array.from({ length: 100 }, (_, i) => ({ tid: `17bb00000000c${String(i).padStart(3, '0')}`, ms: NOW_MS - (40 + i) * DAY }));

/** Sleeps `ms`, or until `signal` aborts (then throws its reason, as an aborted fetch does). */
function stall(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** Fake Gmail; `slowFrom` makes every thread fetch from that one on stall (abortably) for `slowMs`, like a slow provider. */
function gmail(account: string, opts: { slowFrom?: number; slowMs?: number; onThread?: (n: number) => void } = {}) {
  const fetched: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = OLD.filter(m => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map((m, i) => ({ id: `18d2f4a9b3e2${String(i).padStart(4, '0')}`, threadId: m.tid })) });
    }
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      fetched.push(m[1]);
      opts.onThread?.(fetched.length);
      if (opts.slowFrom !== undefined && fetched.length >= opts.slowFrom) await stall(opts.slowMs ?? 0, init?.signal);
      const t = OLD.find(x => x.tid === m[1])!;
      return json({ id: t.tid, messages: [{ id: `18d2f4a9b3e3${t.tid.slice(-4)}`, threadId: t.tid, labelIds: [], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }], body: { data: b64url(`Body ${t.tid}.`) } } }] });
    }
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  };
  return { fetcher: withGoogleAccount(fetcher, account), fetched };
}

async function gmailState(engine: BrainEngine, id: string): Promise<GmailState | undefined> {
  const [row] = await sourceCheckpoint(engine, id) as { completed_keys: { state?: GmailState }[] }[];
  return row?.completed_keys[0]?.state;
}

async function connectorState(engine: BrainEngine, id: string) {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]);
  return readManagedConnectorState(engine, id, source.incarnation);
}

/** The pre-upgrade record of the report: 29 runs in a row ended on recovery_required. */
async function recordRecoveryStop(engine: BrainEngine, id: string, consecutive = 29): Promise<ConnectorRunFailure> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]);
  const state = await readManagedConnectorState(engine, id, source.incarnation);
  const failure = { code: 'recovery_required', message: 'A retained connector publication still requires recovery.', slug: null, request_id: null,
    at: new Date(Date.now() - DAY).toISOString(), consecutive };
  await writeManagedConnectorState(engine, id, source.incarnation, { ...state, last_failure: failure });
  return failure;
}

/** A first run banks batch one and is cut off: the floor sits below batch one and the backfill is open. */
async function seedFrozenFloor(engine: BrainEngine) {
  const f = await boundSource(engine, config);
  const cfg = parseGoogleSourceConfig(config, f.dir);
  const controller = new AbortController();
  const seed = gmail(cfg.account, { onThread: n => { if (n >= 27) controller.abort(); } });
  await runGoogleSync(engine, f.id, cfg, { ...options, signal: controller.signal }, seed.fetcher).catch(() => undefined);
  await settleConnectorWrites(engine, f.id);
  expect(await gmailState(engine, f.id)).toMatchObject({ gmail_backfill_done: false, gmail_backfill_floor_ms: OLD[24].ms });
  return { f, cfg };
}

test('#9968: a connector sync with a job deadline stops there partial, records its run and clears a settled recovery_required stop', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, cfg } = await seedFrozenFloor(engine);
    await recordRecoveryStop(engine, f.id);
    // Batch one of this run (threads 25..49) is quick; from the first thread of batch two the provider is slow, so the
    // sweep cannot finish before the deadline. The job's own timeout (the hard abort) comes a few seconds later.
    const sweep = gmail(cfg.account, { slowFrom: 26, slowMs: 120_000 });
    const deadlineAtMs = Date.now() + 20_000;
    const job = new AbortController();
    const timer = setTimeout(() => job.abort(new Error('aborted: timeout')), deadlineAtMs - Date.now() + 8_000);
    const outcome = await runGoogleSync(engine, f.id, cfg, { ...options, deadlineAtMs, signal: job.signal }, sweep.fetcher)
      .then(result => ({ result, error: null }), (error: unknown) => ({ result: null, error }))
      .finally(() => clearTimeout(timer));
    expect(outcome.error).toBeNull();
    expect(job.signal.aborted).toBe(false);
    expect(outcome.result).toMatchObject({ status: 'partial', reason: 'timeout' });
    const state = await connectorState(engine, f.id);
    expect(state.last_run?.finished_at).toBeString();
    // No retained publication is left behind the recorded stop, so the run that ended without an error cleared it.
    expect(state.last_failure).toBeNull();
    // Batch one's position is banked; the next run walks only what lies below it and finishes the backfill.
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    const floor = (await gmailState(engine, f.id))?.gmail_backfill_floor_ms ?? 0;
    expect(floor).toBeLessThanOrEqual(OLD[49].ms);
    const next = gmail(cfg.account);
    expect((await runGoogleSync(engine, f.id, cfg, options, next.fetcher)).status).not.toBe('partial');
    expect(next.fetched).toEqual(OLD.filter(o => o.ms < floor).map(o => o.tid));
    expect((await gmailState(engine, f.id))?.gmail_backfill_done).toBe(true);
    await settleConnectorWrites(engine, f.id);
    // Every thread was published once: no page of the archive has a second committed import.
    const imports = await engine.executeRaw<{ slug: string; n: number }>(`SELECT slug,count(*)::int AS n FROM persistence_requests
      WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' AND state='committed' GROUP BY slug HAVING count(*)>1`, [f.id]);
    expect(imports).toEqual([]);
  }
}), 300_000);

test('#9968: sources status and sync status do not report a recovery_required stop whose retained publication has settled', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    await runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), options, githubFetch());
    await settleConnectorWrites(engine, f.id);
    await recordRecoveryStop(engine, f.id);
    const status = (await readConnectorSourceStatuses(engine, [f.id])).get(f.id)!;
    expect(status.last_failure?.code).toBe('recovery_required');
    expect(status.stopped).toBe(false);
    expect(status.recovery_settled).toBe(true);
    expect(await readConnectorLastError(engine, f.id)).toMatchObject({ code: 'recovery_required', stopped: false, recovery_settled: true });
    expect(connectorStatusLines(f.id, status).join('\n')).toContain('so this is not a stop');
    // A retained publication of another source on the same worktree still blocks this connector's sync, so it is still a stop.
    await disposePersistenceConsumer(engine);
    const other = await plainSource(engine, githubConfig);
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence LIMIT 1', [f.id]);
    await engine.executeRaw(`UPDATE persistence_requests SET source_id=$2,recovery='{"version":1}'::jsonb WHERE id=$1::uuid`, [row.id, other.id]);
    try {
      const shared = (await readConnectorSourceStatuses(engine, [f.id])).get(f.id)!;
      expect(shared.stopped).toBe(true);
      expect(shared.recovery_settled).toBeUndefined();
      expect((await readConnectorLastError(engine, f.id))?.stopped).toBe(true);
    } finally {
      await engine.executeRaw('UPDATE persistence_requests SET source_id=$2,recovery=NULL WHERE id=$1::uuid', [row.id, f.id]);
    }
  }
}), 120_000);

test('#9968: a --full sweep stopped at its deadline keeps unreached retries, its recorded failure and the re-walk', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const { f, cfg } = await seedFrozenFloor(engine);
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
    // A failed item carried from an earlier run that this run never reaches, an earlier failure and an open upgrade re-walk.
    const unreached = { itemRef: 'mail/unreached-example', requestId: randomUUID(), baseRequestId: randomUUID(), admittedAt: new Date().toISOString() };
    const failure = { code: 'storage_error', message: 'Synthetic earlier failure.', slug: null, request_id: null, at: new Date(Date.now() - DAY).toISOString(), consecutive: 1 };
    const before = await readManagedConnectorState(engine, f.id, source.incarnation);
    await writeManagedConnectorState(engine, f.id, source.incarnation,
      { ...before, pending: [...before.pending, unreached], last_failure: failure, upgrade_recovery: 'rewalking_once' });
    // Batch one of the re-walk banks its cursor; from batch two the provider is slow and the deadline stops the sweep.
    const sweep = gmail(cfg.account, { slowFrom: 26, slowMs: 120_000 });
    const result = await runGoogleSync(engine, f.id, cfg, { ...options, full: true, deadlineAtMs: Date.now() + 15_000 }, sweep.fetcher);
    expect(result).toMatchObject({ status: 'partial', reason: 'timeout' });
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    const state = await connectorState(engine, f.id);
    expect(state.pending.map(entry => entry.requestId)).toContain(unreached.requestId);
    expect(state.last_run?.dropped_upstream).toBe(0);
    expect(state.last_failure?.code).toBe('storage_error');
    expect(state.upgrade_recovery).toBe('rewalking_once');
  }
}), 300_000);

/** Fake GitHub that refuses a request made after the caller's signal aborted; with `stallListingMs` the open-PR listing, the last listing call, answers only after that delay, ignoring the signal. */
function githubIssues(numbers: number[], updatedAt: string, stallListingMs = 0) {
  const issue = (n: number) => ({ number: n, title: `Synthetic issue ${n}`, state: 'open', body: `Body ${n}.`, created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt, labels: [], assignees: [], user: { login: 'example-user' }, html_url: `https://github.com/acme-example/app/issues/${n}` });
  return async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return json(numbers.map(issue));
    if (path.endsWith('/pulls')) {
      if (stallListingMs) await new Promise(resolve => setTimeout(resolve, stallListingMs));
      return json([]);
    }
    if (path.endsWith('/comments')) return json([]);
    const detail = path.match(/\/issues\/(\d+)$/);
    if (detail) return json(issue(Number(detail[1])));
    if (path === '/repos/acme-example/app') return json({ full_name: 'acme-example/app', private: true, default_branch: 'main' });
    throw new Error('Unexpected external fixture route');
  };
}

test('#9968: a GitHub sweep whose listing returns after the deadline imports nothing more and deletes nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    expect((await runGitHubSync(engine, f.id, cfg, options, githubIssues([1, 2, 3], '2026-01-02T00:00:00Z'))).status).not.toBe('partial');
    await settleConnectorWrites(engine, f.id);
    const imports = async () => (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
      WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'`, [f.id]))[0].n;
    const before = await imports();
    const pages = async () => (await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL
      AND slug LIKE 'gh/acme-example/app/%' ORDER BY slug`, [f.id])).map(row => row.slug);
    const kept = await pages();
    expect(kept).toContain('gh/acme-example/app/1');
    // A --full sweep lists everything again, but the listing answers only after the job's deadline has passed.
    const listed = Array.from({ length: 30 }, (_, i) => i + 1);
    const result = await runGitHubSync(engine, f.id, cfg, { ...options, full: true, deadlineAtMs: Date.now() + 1_500 },
      githubIssues(listed, '2026-01-05T00:00:00Z', 3_000));
    expect(result).toMatchObject({ status: 'partial', reason: 'timeout' });
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    expect(await imports()).toBe(before);
    expect(await pages()).toEqual(kept);
    expect((await connectorState(engine, f.id)).last_failure).toBeNull();
  }
}), 120_000);

test('#9968: a first GitHub import whose listing returns after the deadline stops on time with no failed item', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    const result = await runGitHubSync(engine, f.id, cfg, { ...options, deadlineAtMs: Date.now() + 1_500 },
      githubIssues([1, 2, 3], '2026-01-02T00:00:00Z', 3_000));
    expect(result).toMatchObject({ status: 'partial', reason: 'timeout' });
    expect(result).not.toHaveProperty('failedFiles');
    await settleConnectorWrites(engine, f.id);
    await disposePersistenceConsumer(engine);
    expect((await connectorState(engine, f.id)).last_failure).toBeNull();
  }
}), 120_000);

test('#9968: a real retained publication keeps the stop, and the sync refuses within its deadline naming the receipt to read', async () => withEnv({ ...env, GBRAIN_WRITE_WAIT_MS: '30000' }, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    await runGitHubSync(engine, f.id, cfg, options, githubFetch());
    await disposePersistenceConsumer(engine);
    const crash = await standaloneConnector(engine, f, githubConfig, true);
    expect(crash.stdout).toContain('CONNECTOR_AFTER_PUBLICATION_BEFORE_COMMIT');
    const [retained] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL', [f.id]);
    expect(retained).toBeDefined();
    const path = join(f.dir, 'gh/acme-example/app/1.md');
    const published = readFileSync(path, 'utf8');
    writeFileSync(path, `${published}\nOperator edit blocks the recovery.\n`);
    try {
      await recordRecoveryStop(engine, f.id, 3);
      expect((await readConnectorSourceStatuses(engine, [f.id])).get(f.id)).toMatchObject({ stopped: true });
      expect((await readConnectorSourceStatuses(engine, [f.id])).get(f.id)?.recovery_settled).toBeUndefined();
      const started = performance.now();
      const failure = await runGitHubSync(engine, f.id, cfg, { ...options, deadlineAtMs: Date.now() + 1_500 }, githubFetch())
        .then(() => null, (e: { code?: string; fix?: { argv?: string[] }; suggestion?: string; writeRequest?: { request_id?: string } }) => e);
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(failure?.code).toBe('recovery_required');
      expect(failure?.writeRequest?.request_id).toBe(retained.request_id);
      expect(failure?.fix?.argv).toEqual(['gbrain', 'write-request', '--', retained.request_id]);
      expect(failure?.suggestion).toContain(retained.request_id);
      expect((await connectorState(engine, f.id)).last_failure).toMatchObject({ code: 'recovery_required', consecutive: 4, request_id: retained.request_id });
      const diagnostics = await readWriterDiagnostics(engine);
      expect(diagnostics.blockers.map(b => b.request_id)).toContain(retained.request_id);
    } finally {
      await disposePersistenceConsumer(engine);
      writeFileSync(path, published);
    }
  }
}), 120_000);

// Reported and first fixed by @Masashi-Ono0611 (#9969): writer status listed only queued, running or recovering requests and
// blocked ones, so a request that ended but still holds a recovery record (which blocks its worktree) was invisible there.
test('#9968: writer status lists a request that ended but still holds a recovery record', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await initializeLocalPersistence(ctx);
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const slug = `inbox/retained-${randomUUID().slice(0, 8)}`;
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, slug);
    const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug, requestId: randomUUID(), callerIntent: {}, intent: { content: 'x' } });
    await engine.executeRaw(`UPDATE persistence_requests SET state='cancelled',execution_token=NULL,completed_at=now(),
      recovery='{"version":1}'::jsonb WHERE id=$1::uuid`, [row.id]);
    try {
      const diagnostics = await readWriterDiagnostics(engine);
      expect(diagnostics.blockers.map(b => b.request_id)).toContain(row.request_id);
    } finally {
      await engine.executeRaw('UPDATE persistence_requests SET recovery=NULL WHERE id=$1::uuid', [row.id]);
    }
  }
}), 120_000);
