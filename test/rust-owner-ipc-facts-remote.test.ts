/**
 * A facts-absorb job a remote write queued is a remote caller wherever it runs, so the Rust owner socket client sends
 * none of its writes (src/core/persistence/effect-facts.ts, src/core/minions/handlers/facts-absorb.ts,
 * src/core/rust-engine/owner-ipc/client.ts `callerIsRemote`).
 *
 * 1. Protects: (a) the facts job queued for a remote write carries `remote_write: true`, and the job queued for a local
 *    write carries no such key, so a local write's job data is as it was; (b) the facts-absorb handler runs a job with
 *    `remote_write: true` as a remote caller and any other job as it always did.
 * 2. Fails on: a dispatcher that queues the job of a remote write with no mark, one that marks a local write's job, a
 *    handler that ignores the mark, and one that reads a mark that is not exactly `true`.
 * 3. Existing coverage: persistence-facts-backstop.test.ts covers the queued job's other fields and its recheck;
 *    rust-owner-ipc-remote-scope.test.ts covers jobs queued through submit_job and submit_agent, which carry a durable
 *    submission authority. A facts-absorb job queued by a write effect has none, so neither reaches it.
 * 4. Seam: none. The dispatcher runs against PGLite and the real journal; the handler runs on an engine that records
 *    whether its caller is remote at its first use and then stops.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../src/core/persistence/effect-facts.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { makeFactsAbsorbHandler } from '../src/core/minions/handlers/facts-absorb.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { callerIsRemote } from '../src/core/rust-engine/owner-ipc/client.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' as const, embedding_disabled: true };
const content = `---\ntype: note\ntitle: Field notes\n---\n\n${'A useful substantive record of this project and its current status. '.repeat(4)}`;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function fixture(run: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-remote-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await resetPgliteState(engine);
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await registerLocalWriter(engine, 'cli');
      await run();
    });
  } finally { rmSync(home, { force: true, recursive: true }); }
}

async function prepare(overrides: Partial<OperationContext> = {}) {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} }, ...overrides };
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/example');
  const intent = { content };
  const current = await engine.readPageSnapshot('notes/example', { sourceId: 'default', includeDeleted: true });
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: 'notes/example', pageId: current?.page.id ?? null, requestId: randomUUID(), callerIntent: intent, intent });
  const row = (await claimNextWrite(engine, localHostId()))!;
  return { row, prepared: await preparePageMutation(engine, row, config) };
}

async function publishLocal() { const input = await prepare(); return publishMutation(engine, input.row, input.prepared); }
async function publishRemote() {
  const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
  return withVerifiedLocalRegistration(engine, registration, async () => {
    const input = await prepare({ remote: true, auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default' } } as Partial<OperationContext>);
    return publishMutation(engine, input.row, input.prepared);
  });
}

async function queuedJobData(row: WriteRequest): Promise<Record<string, unknown>> {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'facts-backstop'");
  const effect = (await claimPersistenceEffect(engine, localHostId()))!;
  expect(effect.request_id).toBe(row.id);
  expect(effect.kind).toBe('facts-backstop');
  await dispatchFactsBackstopEffect(engine, effect, localHostId());
  const jobs = await engine.executeRaw<{ data: Record<string, unknown> }>("SELECT data FROM minion_jobs WHERE name='facts-absorb'");
  expect(jobs).toHaveLength(1);
  return jobs[0]!.data;
}

describe('the facts-absorb job a write queues', () => {
  // Value: protects=the job queued for a remote write is marked remote so the owner socket client sends none of its writes; fails_when=the dispatcher drops the mark; why_new=the facts job carries no submission authority, so no existing test sees its caller kind; seam=none; no_claim=what the job does once it runs
  test('a remote write queues its job with remote_write true', () => fixture(async () => {
    const row = await publishRemote();
    expect(row.state).toBe('committed');
    expect(row.authority.remote).toBe(true);
    expect((await queuedJobData(row)).remote_write).toBe(true);
  }));

  // Value: protects=a local write's job data is as it was, with no new key; fails_when=the mark is set for a local write; why_new=same as above; seam=none; no_claim=other fields of the job data
  test('a local write queues its job with no remote_write key', () => fixture(async () => {
    const row = await publishLocal();
    expect(row.authority.remote).toBe(false);
    const data = await queuedJobData(row);
    expect('remote_write' in data).toBe(false);
    expect(Object.keys(data).sort()).toEqual(['notabilityFilter', 'page_id', 'persistence_request_id', 'revision', 'sessionId', 'slug', 'source', 'sourceId', 'visibility']);
  }));
});

describe('the facts-absorb handler', () => {
  /** What `callerIsRemote()` says when the handler first uses its engine; the engine then stops the job. */
  async function remoteAtFirstUse(data: Record<string, unknown>): Promise<boolean | null> {
    let seen: boolean | null = null;
    const stop = new Error('stop at first use of the engine');
    const probe = new Proxy({}, { get: () => { seen ??= callerIsRemote(); throw stop; } }) as unknown as BrainEngine;
    const job = { id: 1, name: 'facts-absorb', data: { slug: 'notes/example', ...data }, attempts_made: 0, idempotency_key: null, signal: new AbortController().signal } as unknown as MinionJobContext;
    await makeFactsAbsorbHandler(probe)(job).then(() => undefined, error => { expect(error).toBe(stop); });
    return seen;
  }

  // Value: protects=a job marked remote_write runs as a remote caller, and one that is not marked, or marked with anything but true, runs as before; fails_when=the handler ignores the mark or accepts a value other than true; why_new=no test runs the handler as a remote caller; seam=none; no_claim=the writes the handler later makes
  test('runs a job with remote_write true as a remote caller, and any other job as a local one', async () => {
    expect(await remoteAtFirstUse({ remote_write: true })).toBe(true);
    expect(await remoteAtFirstUse({})).toBe(false);
    expect(await remoteAtFirstUse({ remote_write: false })).toBe(false);
    expect(await remoteAtFirstUse({ remote_write: 'true' })).toBe(false);
  });
});
