/**
 * Wave C 1H-a, ceo-r3-native-5 and eng-r3-outside-4: the git-first path's activation barrier. A writer stamped below the
 * git-first floor in the last seven days keeps the path off on every strict source (so no index effect is queued for a
 * worker that cannot run it), the barrier lifts once that writer is older than the window, and a worker without a
 * registered consumer never claims an `index-split-page` effect.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimPersistenceEffect } from '../../src/core/persistence/effect-journal.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, gitFirstStrictActive, gitFirstWriterBlockers,
  registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { pageBody, write } from './helpers.ts';

const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const olderWriter = (engine: BrainEngine, daysAgo: number) => engine.executeRaw(`INSERT INTO ingest_log (source_type, source_ref, writer_version, writer_host_id, writer_segment_reader, created_at)
  VALUES ('sync', 'older-binary', '0.60.1.0', gen_random_uuid(), true, now() - $1::int * interval '1 day')`, [daysAgo]);

for (const backend of testBackends()) describe(`[${backend}] git-first activation barrier`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a writer below the floor in the last 7 days keeps the path off; a strict 2 MiB put takes today\'s path', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    expect(await gitFirstStrictActive(engine, 'default', { fresh: true })).toBe(true);
    await olderWriter(engine, 1);
    expect((await gitFirstWriterBlockers(engine, { fresh: true })).map(row => row.version)).toEqual(['0.60.1.0']);
    expect(await gitFirstStrictActive(engine, 'default', { fresh: true })).toBe(false);
    const row = await write(engine, ctx, 'notes/barrier', pageBody(2 * 1024 ** 2, 'MARKERBARRIER'), 'put');
    expect(row.state).toBe('committed');
    expect(await engine.executeRaw('SELECT 1 FROM page_pending_heads')).toEqual([]);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE kind = 'index-split-page'")).toEqual([]);
  }, { databaseUrl, setup }), 120_000);

  test('the barrier lifts once the older writer is past the window', () => managedBrain(async ({ engine }) => {
    await strict(engine);
    await olderWriter(engine, 8);
    expect(await gitFirstStrictActive(engine, 'default', { fresh: true })).toBe(true);
  }, { databaseUrl, setup }), 60_000);

  test('a worker without a registered consumer never claims an index-split-page effect', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/queued-index', pageBody(2 * 1024 ** 2, 'MARKERQUEUED'), 'put');
    expect(row.state).toBe('indexing');
    _unregisterIndexSplitPageConsumerForTests();
    // The stub consumer the write ran under may have claimed it already; queue it again, as a worker crash would leave it.
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_effects SET state = 'queued', claim_expires_at = NULL, next_attempt_at = now() WHERE kind = 'index-split-page'");
    });
    const claimed: string[] = [];
    for (let effect = await claimPersistenceEffect(engine, localHostId()); effect; effect = await claimPersistenceEffect(engine, localHostId())) claimed.push(effect.kind);
    expect(claimed).not.toContain('index-split-page');
    registerIndexSplitPageConsumer({ run: async () => undefined });
    expect((await claimPersistenceEffect(engine, localHostId()))?.kind).toBe('index-split-page');
  }, { databaseUrl, setup }), 120_000);
});
