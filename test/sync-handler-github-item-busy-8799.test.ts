/**
 * #8799: a GitHub webhook's single-item refresh that finds its source busy is deferred with its item and delete intent.
 * Before the fix the sync handler completed it as a sync_in_progress skip, which records only a source-wide pull marker,
 * so the item's refresh, or its deletion, was lost while another sync of the source ran. A plain sync job still skips.
 * Real PGLite, the real sync handler, the per-source sync lock held by a stand-in holder; no network.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { JobDeferredError } from '../src/core/minions/errors.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const home = mkdtempSync(join(tmpdir(), 'gbrain-8799-busy-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::jsonb)', [SOURCE, join(home, SOURCE),
    JSON.stringify({ kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' })]);
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

const job = (data: Record<string, unknown>) => ({ id: 9201, name: 'sync', data: { sourceId: SOURCE, ...data }, attempts_made: 0,
  signal: new AbortController().signal, shutdownSignal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000,
  updateProgress: async () => undefined, updateTokens: async () => undefined, log: async () => undefined, isActive: async () => true,
  readInbox: async () => [] }) as unknown as MinionJobContext;

const deferral = async (run: Promise<unknown>) => {
  const err = await run.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(JobDeferredError);
  return { reason: (err as JobDeferredError).reason, retryInMs: (err as JobDeferredError).retryInMs, message: (err as JobDeferredError).message };
};

test('an item refresh or deletion on a busy source is deferred, burning no attempt; a plain sync job still skips', async () => withEnv({ GBRAIN_HOME: home, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
  const held = await tryAcquireDbLock(engine, syncLockId(SOURCE), 5);
  expect(held).not.toBeNull();
  try {
    const handler = makeSyncHandler(engine);
    expect(await deferral(handler(job({ github_item: { repo: 'acme-example/app', number: 1, kind: 'issue' } }))))
      .toMatchObject({ reason: 'sync_in_progress', retryInMs: 30_000, message: expect.stringMatching(/refresh of acme-example\/app#1/) });
    expect(await deferral(handler(job({ github_item: { repo: 'acme-example/app', number: 2, kind: 'issue', deleted: true } }))))
      .toMatchObject({ reason: 'sync_in_progress', retryInMs: 30_000, message: expect.stringMatching(/deletion of acme-example\/app#2/) });
    expect(await handler(job({ pull: false }))).toMatchObject({ skipped: true, reason: 'sync_in_progress', source_id: SOURCE });
  } finally { await held!.release(); }
}), 120_000);
