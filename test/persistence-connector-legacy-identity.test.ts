import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { admitWriteInTransaction, claimNextWrite, compactWriteReceipts, completeWrite, intentDigest } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { beginConnectorSync, prepareConnectorMutation } from '../src/core/persistence/connector-sync.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { WriteAdmission } from '../src/core/persistence/journal.ts';
import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { runCycle } from '../src/core/cycle.ts';
import { createConnectorFixture, googleConfig, options } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const f = createConnectorFixture();
const checkpointSlug = '__managed_connector_checkpoint__';
const checkpointState = { gmail_backfill_done: true, gmail_history_id: 'synthetic-legacy-history' };

beforeAll(f.setup, 120_000);
afterAll(f.teardown);

function legacyStableId(value: unknown): string {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Reproduce the v1 connector submit packet inspected at 045a61381:
 * checkpoint identity and configHash include the whole stored source config;
 * caller intent excludes syncAuthority, newestContentAt, and checkpoint receipts.
 * The durable row itself is admitted by the real journal API, never rewritten.
 */
async function admitV1Checkpoint(engine: BrainEngine, sourceId: string, config: Record<string, unknown>) {
  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string; config: Record<string, unknown> }>(
    'SELECT incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  expect(source).toBeDefined();
  expect(source.config).toEqual(config);
  const authority = await managedSyncAuthority(engine, sourceId, source.incarnation, source.local_path);
  authority.writer.databaseOnlyReason = 'connector_database';
  const principal = authority.writer.principal;
  const checkpointKey = digest({ sourceId, incarnation: source.incarnation, connector: 'google', config: source.config });
  const intent = {
    kind: 'managed_connector_checkpoint', connector: 'google', sourceRoot: source.local_path,
    configHash: digest(source.config), syncAuthority: authority, expected_revision: null, sourcePath: null,
    noEmbed: true, noSchemaPack: true, checkpointKey, checkpointBefore: [], ownerEpoch: null,
    canonicalRoot: null, filePath: null, fileBeforeHash: null,
    checkpointAfter: [{ generation: 1, state: structuredClone(checkpointState) }], receipts: [], fresh: false,
  };
  const callerIntent = { ...intent, syncAuthority: undefined, newestContentAt: undefined, receipts: undefined };
  const requestId = legacyStableId({ principal, sourceId, incarnation: source.incarnation, callerIntent });
  const input: WriteAdmission = {
    principal, requestId, operation: 'submit_job', sourceId, sourceIncarnation: source.incarnation,
    slug: checkpointSlug, pageId: null, callerIntent, intent, authority: authority.writer,
  };
  expect(intentDigest(input)).toBe(digest({ operation: 'submit_job', source_id: sourceId, slug: checkpointSlug, intent: callerIntent }));
  const row = await engine.transaction(tx => admitWriteInTransaction(tx, input));
  expect(row.request_id).toBe(requestId);
  expect(row.digest).toBe(intentDigest(input));
  if (!row.intent) throw new Error('Legacy admission returned no durable intent');
  expect(row.intent).toEqual(intent);
  expect(row.intent.configIdentityVersion).toBeUndefined();
  return { row, requestId, checkpointKey, principal };
}

async function terminalizeLegacy(engine: BrainEngine, requestId: string, state: 'failed' | 'committed') {
  const claimed = await claimNextWrite(engine, localHostId());
  expect(claimed?.request_id).toBe(requestId);
  if (!claimed) throw new Error('Legacy fixture request was not claimable');
  if (state === 'failed') {
    return engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, {
      code: 'storage_error', message: 'Synthetic failure from the historical v1 fixture.',
    }));
  }
  const prepared = await prepareConnectorMutation(engine, claimed);
  return engine.transaction(async tx => {
    const outcome = await prepared.apply(tx);
    return completeWrite(tx, claimed, 'committed', outcome);
  });
}

for (const stamped of [false, true]) {
  const label = stamped ? 'stamped' : 'unstamped';
  const sourceConfig = stamped ? {
    ...googleConfig,
    last_source_cycle_at: '2030-01-02T03:04:43.000Z',
    last_full_cycle_at: '2030-01-02T03:04:43.000Z',
  } : { ...googleConfig };

  test(`${label} v1 failed receipt requires explicit retry and stays immutable`, async () => withEnv(f.env, async () => {
    for (const engine of f.engines) {
      const source = await f.source(engine, sourceConfig);
      const built = await admitV1Checkpoint(engine, source.id, sourceConfig);
      const failed = await terminalizeLegacy(engine, built.requestId, 'failed');
      let before = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]);
      expect(before).toHaveLength(1);
      expect(before[0]).toEqual(failed);
      if (!stamped) {
        await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [failed.id]);
        expect(await compactWriteReceipts(engine)).toBeGreaterThanOrEqual(1);
        before = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]);
        expect(before[0]).toMatchObject({ compacted: true, intent: null, digest: failed.digest });
      }

      const cfg = parseGoogleSourceConfig(sourceConfig, source.dir);
      const ordinary = (await beginConnectorSync(engine, source.id, 'google', cfg, options))!;
      let failure: unknown;
      try { await ordinary.saveState(checkpointState); } catch (error) { failure = error; }
      const afterOrdinary = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [source.id]);

      if (stamped) {
        // This is the intentional RED: cycle stamps produce a new candidate ID,
        // so the old failed v1 receipt is silently bypassed on the candidate.
        expect(failure).toBeDefined();
        expect(afterOrdinary).toHaveLength(1);
      } else {
        expect(failure).toMatchObject({ code: 'storage_error', writeRequest: { request_id: built.requestId } });
        expect(afterOrdinary).toHaveLength(1);
      }

      const oldAfterReplay = (await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]))[0];
      expect(oldAfterReplay).toEqual(before[0]);

      if (!stamped) {
        const retry = (await beginConnectorSync(engine, source.id, 'google', cfg, { ...options, retryFailed: true }))!;
        await retry.saveState(checkpointState);
        const replacements = await engine.executeRaw<WriteRequest>(
          "SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [source.id, built.requestId]);
        expect(replacements).toHaveLength(1);
        expect(replacements[0].state).toBe('committed');
        expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]))[0]).toEqual(before[0]);
      }
    }
  }), 120_000);

  test(`${label} v1 accepted pending request is reused, not re-admitted`, async () => withEnv(f.env, async () => {
    for (const engine of f.engines) {
      const source = await f.source(engine, sourceConfig);
      const built = await admitV1Checkpoint(engine, source.id, sourceConfig);
      const cfg = parseGoogleSourceConfig(sourceConfig, source.dir);
      const replay = (await beginConnectorSync(engine, source.id, 'google', cfg, options))!;
      await replay.saveState(checkpointState);
      const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [source.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].request_id).toBe(built.requestId);
      expect(rows[0].state).toBe('committed');
    }
  }), 120_000);

  test(`${label} successful cycle leaves an admitted connector checkpoint replayable`, async () => withEnv(f.env, async () => {
    for (const engine of f.engines) {
      const source = await f.source(engine, sourceConfig);
      const built = await admitV1Checkpoint(engine, source.id, sourceConfig);
      const beforeConfig = await engine.executeRaw<{ config: string }>(
        'SELECT config::text AS config FROM sources WHERE id=$1', [source.id]);
      const beforeReceipt = await engine.executeRaw<WriteRequest>(
        'SELECT * FROM persistence_requests WHERE request_id=$1', [built.requestId]);

      const cycle = await runCycle(engine, {
        brainDir: source.dir,
        sourceId: source.id,
        phases: ['recompute_emotional_weight'],
      });
      expect(['ok', 'clean']).toContain(cycle.status);

      const afterConfig = await engine.executeRaw<{ config: string }>(
        'SELECT config::text AS config FROM sources WHERE id=$1', [source.id]);
      expect(afterConfig[0]?.config).toBe(beforeConfig[0]?.config);
      const cfg = parseGoogleSourceConfig(sourceConfig, source.dir);
      const replay = (await beginConnectorSync(engine, source.id, 'google', cfg, options))!;
      await replay.saveState(checkpointState);
      const afterReceipt = await engine.executeRaw<WriteRequest>(
        'SELECT * FROM persistence_requests WHERE request_id=$1', [built.requestId]);
      expect(afterReceipt).toHaveLength(1);
      expect(afterReceipt[0]).toMatchObject({
        request_id: beforeReceipt[0]!.request_id,
        digest: beforeReceipt[0]!.digest,
        intent: beforeReceipt[0]!.intent,
        state: 'committed',
      });
      expect(await engine.executeRaw<WriteRequest>(
        'SELECT * FROM persistence_requests WHERE source_id=$1', [source.id])).toHaveLength(1);
    }
  }), 120_000);

  test(`${label} v1 completed receipt replays a pre-created lost-ack caller without another admission`, async () => withEnv(f.env, async () => {
    for (const engine of f.engines) {
      const source = await f.source(engine, sourceConfig);
      const built = await admitV1Checkpoint(engine, source.id, sourceConfig);
      const cfg = parseGoogleSourceConfig(sourceConfig, source.dir);
      // Capture the candidate's caller before the historical caller commits.
      const replay = (await beginConnectorSync(engine, source.id, 'google', cfg, options))!;
      const committed = await terminalizeLegacy(engine, built.requestId, 'committed');
      expect(committed.state).toBe('committed');
      const before = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [source.id]);
      expect(before).toHaveLength(1);
      expect(before[0].request_id).toBe(built.requestId);
      expect(before[0].state).toBe('committed');

      await replay.saveState(checkpointState);
      const after = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [source.id]);
      expect(after).toEqual(before);
      expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [committed.id]))[0]).toEqual(before[0]);
    }
  }), 120_000);
}
