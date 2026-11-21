/**
 * BrainEngine parity — the persistence protocol declaration (engine-sql/persistence-declaration.ts
 * `declarePersistence`) and the write admission it opens (persistence/journal.ts `admitWrite`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `declarePersistence` returns the brain's persistence id (the one `readPersistenceBrainId` reads), with
 *    or without the durable-write settings; inside a transaction it declares protocol 2, which
 *    `readTransactionSettings` reads back as '2' until the transaction ends. `admitWrite` then stores one queued
 *    request with the same digest on every arm and charges its counters by one. On every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that cannot declare the protocol refuses every write admission (a CLI put stops before its
 *    request is stored); one that keeps the declaration past its transaction lets a later transaction write journal
 *    rows the protocol triggers should refuse.
 *  - Why existing coverage misses it: the declaration was raw SQL in persistence/protocol.ts, which the parity cases
 *    cannot call (D18), so the Rust engine refused it at `executeRaw` and no case compared it across engines.
 *  - Seam: none. Typed members and the real admission path only (no executeRaw: D18). Generated values (the brain id,
 *    the local writer's id, journal ids) are compared by shape or against another member's answer.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { authorizeWrite, submissionAuthority } from '../../src/core/persistence/authority.ts';
import { withAdmissionOrigin } from '../../src/core/persistence/admission-origin.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, assertWriteHeadroom, readOutstandingRoom } from '../../src/core/persistence/journal.ts';
import { principalKey, type WriteAuthority } from '../../src/core/persistence/model.ts';
import { schemaAdmissionRefusal } from '../../src/core/persistence/schema-admission.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROTOCOL = 'gbrain.persistence_protocol';
const REQUESTS = ['b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-0000000000b2'];
const WORKTREE = 'd0000000-0000-4000-8000-0000000000d1';

/** Admits one put_page request for `slug` on `sourceId` through the real admission path, as a CLI put does. */
async function admitPut(engine: BrainEngine, slug: string, requestId: string, sourceId = 'default',
  operation = 'put_page', intent: Record<string, unknown> = { body: slug }) {
  const source = await engine.readSourceMembership(sourceId);
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, operation, sourceId, source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation, sourceId,
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: intent, intent });
}

/** Outstanding count and intent bytes per counter, read under the counter lock. */
async function counters(engine: BrainEngine, keys: string[]) {
  const rows = await engine.transaction((tx) => tx.lockPersistenceCounters(keys));
  return Object.fromEntries(rows.map((r) => [r.key.startsWith('principal:') ? 'principal' : r.key, Number(r.outstanding_count)]));
}

describe('engine parity: persistence declaration', () => {
  parityTest('declarePersistence returns the brain id, with and without the durable settings', {
    methods: ['declarePersistence', 'readPersistenceBrainId', 'transaction'],
  }, async (engine) => {
    const id = await engine.readPersistenceBrainId();
    expect(id).toMatch(UUID);
    const outside = await engine.declarePersistence();
    const inside = await engine.transaction((tx) => tx.declarePersistence());
    const durable = await engine.transaction((tx) => tx.declarePersistence({ durable: { lockTimeout: '100ms', statementTimeout: '5s' } }));
    const idle = await engine.transaction((tx) => tx.declarePersistence({ durable: { lockTimeout: '1s', statementTimeout: '5s', idleInTransaction: '30s' } }));
    return { outside: outside === id, inside: inside === id, durable: durable === id, idle: idle === id };
  });

  parityTest('a declaration inside a transaction reads back as protocol 2 and ends with the transaction', {
    methods: ['declarePersistence', 'transaction', 'readTransactionSettings'],
  }, async (engine) => {
    const inside = await engine.transaction(async (tx) => {
      const before = await tx.readTransactionSettings([PROTOCOL]);
      await tx.declarePersistence();
      return { before: before.map((v) => v ?? ''), after: await tx.readTransactionSettings([PROTOCOL]) };
    });
    const durable = await engine.transaction(async (tx) => {
      await tx.declarePersistence({ durable: { lockTimeout: '1s', statementTimeout: '5s' } });
      return tx.readTransactionSettings([PROTOCOL]);
    });
    const later = await engine.transaction((tx) => tx.readTransactionSettings([PROTOCOL]));
    return { ...inside, durable, later: later.map((v) => v ?? '') };
  });

  parityTest('admitWrite stores one queued request with the same digest and charges its counters by one', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequest'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const first = await admitPut(engine, 'notes/parity-admit-a', REQUESTS[0]!);
    const keys = ['brain', principalKey({ kind: first.principal_kind, id: first.principal_id })];
    const afterFirst = await counters(engine, keys);
    const second = await admitPut(engine, 'notes/parity-admit-b', REQUESTS[1]!);
    const afterSecond = await counters(engine, keys);
    const stored = await engine.readWriteRequest(first.principal_kind, first.principal_id, REQUESTS[0]!);
    const view = (row: typeof first | null) => row && {
      principalKind: row.principal_kind, requestId: row.request_id, operation: row.operation, source: row.source_id, slug: row.slug,
      state: row.state, digest: row.digest, intent: row.intent, targetKind: row.target_kind, protocol: row.protocol_version,
      idIsUuid: UUID.test(row.id),
    };
    for (const key of Object.keys(afterSecond)) expect(afterSecond[key]).toBe(afterFirst[key]! + 1);
    return { first: view(first), second: view(second), stored: view(stored), afterFirst, afterSecond };
  });

  parityTest('a local writer at its outstanding cap still admits a write for a source under its share, and refuses one naming the fullest source', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'countOutstandingBySource'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await registerLocalWriter(engine, 'cli');
    await createSource(engine, backend, 'ab');
    await engine.setConfig('persistence.limits.principal_outstanding', '2');
    await admitPut(engine, 'notes/parity-cap-a', REQUESTS[0]!);
    await admitPut(engine, 'notes/parity-cap-b', REQUESTS[1]!);
    // The cap is full, but `ab` holds none of the two slots: its share (2 sources, 1 slot each) admits it.
    const shared = await admitPut(engine, 'notes/parity-cap-c', 'b0000000-0000-4000-8000-0000000000b3', 'ab');
    const refused = await admitPut(engine, 'notes/parity-cap-d', 'b0000000-0000-4000-8000-0000000000b4').then(
      () => null, (err: { code?: string; message?: string }) => ({ code: err.code, message: err.message }));
    expect(shared.state).toBe('queued');
    expect(refused).toEqual({ code: 'queue_capacity', message: 'Write capacity exhausted: principal outstanding requests (source default holds 2).' });
    return { shared: { source: shared.source_id, state: shared.state }, refused };
  });

  parityTest('a run past the request-id and receipt-byte caps refuses with the same one-year value, and the outstanding room reads the counters', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'readCounterRows', 'readAdmissionRate'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('persistence.limits.principal_outstanding', '5');
    const first = await admitPut(engine, 'notes/parity-quota-a', REQUESTS[0]!);
    await admitPut(engine, 'notes/parity-quota-b', REQUESTS[1]!);
    const principal = { kind: first.principal_kind, id: first.principal_id } as Parameters<typeof readOutstandingRoom>[1];
    const room = await readOutstandingRoom(engine, principal);
    const key = principalKey(principal);
    const [own] = (await engine.transaction((tx) => tx.lockPersistenceCounters([key])));
    const usedBytes = Number(own!.terminal_bytes);
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '3');
    await engine.setConfig('persistence.limits.principal_terminal_bytes', String(usedBytes + 20_000));
    const refusal = (needed: { ids: number; bytes?: number }) => assertWriteHeadroom(engine, principal, needed).then(
      () => null, (err: { code?: string; message?: string; fix?: { argv?: string[] } }) => ({ code: err.code, message: err.message, argv: err.fix?.argv }));
    const ids = await refusal({ ids: 5 });
    const bytes = await refusal({ ids: 0, bytes: 50_000 });
    expect(room).toEqual({ room: 3, scope: 'principal', used: 2, limit: 5 });
    expect(ids?.code).toBe('write_quota_insufficient');
    expect(bytes?.code).toBe('write_quota_insufficient');
    return { room, ids, bytes: bytes && { ...bytes, message: bytes.message?.replace(String(usedBytes), '<used>') } };
  });

  parityTest('a write while the schema is behind refuses migrations_pending with the schema owner as the actor', {
    methods: ['ownsSchemaTables', 'getConfig', 'setConfig'],
  }, async (engine) => {
    const owns = await engine.ownsSchemaTables();
    const version = await engine.getConfig('version');
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION - 1));
    try {
      const refusal = await schemaAdmissionRefusal(engine);
      expect(refusal?.code).toBe('migrations_pending');
      return { owns, code: refusal?.code, reason: refusal?.reason, actor: refusal?.fix?.actor, argv: refusal?.fix?.argv };
    } finally {
      await engine.setConfig('version', version ?? String(LATEST_SCHEMA_VERSION));
    }
  });

  parityTest('a write owned by an OAuth client or legacy token with no live grant refuses permission_denied', {
    methods: ['readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential', 'readSourceMembership'],
  }, async (engine) => {
    const source = await engine.readSourceMembership('default');
    const ids = { oauth_client: 'parity-unknown-client', legacy_token: 'c0000000-0000-4000-8000-0000000000c1' } as const;
    const out: unknown[] = [];
    for (const kind of ['oauth_client', 'legacy_token'] as const) {
      for (const lock of [false, true]) {
        const id = ids[kind];
        const authority: WriteAuthority = { version: 1, principal: { kind, id }, remote: true, sourceId: 'default',
          sourceIncarnation: source!.incarnation, scopes: ['read', 'write'], operations: null, slugPrefixes: null };
        await engine.shareLockWriteCredential(kind, id);
        const grant = kind === 'oauth_client' ? await engine.readOAuthClientWriteGrant(id, { lock }) : await engine.readAccessTokenWriteGrant(id, { lock });
        const refusal = await authorizeWrite(engine, authority, 'put_page', 'notes/grant-check', lock).then(() => null, (e: { code?: string; message?: string }) => e);
        expect(refusal?.code).toBe('permission_denied');
        out.push({ kind, lock, grant, code: refusal?.code, message: refusal?.message });
      }
    }
    return out;
  });

  parityTest('a write to a managed worktree that is not bound to its source is refused source_changed', {
    methods: ['readSourceMembership', 'declarePersistence', 'transaction'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const source = await engine.readSourceMembership('default');
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, 'notes/parity-worktree');
    const refusal = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source!.incarnation, slug: 'notes/parity-worktree', requestId: REQUESTS[0]!, worktreeId: WORKTREE, topologyGeneration: 1,
      callerIntent: { body: 'x' }, intent: { body: 'x' } }).then(() => null, (e: { code?: string; reason?: string; message?: string }) => e);
    // The admission reads the worktree binding; this worktree is not bound to the source, so nothing is accepted.
    expect(refusal?.code).toBe('source_changed');
    return { managed: engine.capabilities.has('managed_persistence'), code: refusal?.code, reason: refusal?.reason ?? null };
  });

  parityTest('a skill bundle write with no activated shared-skill owner is refused writer_not_quiesced', {
    methods: ['readSourceMembership', 'declarePersistence', 'transaction'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const source = await engine.readSourceMembership('default');
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    const authority = await submissionAuthority(ctx, 'put_skill', 'default', source!.incarnation, 'skills/parity-pack/parity-skill');
    const refusal = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_skill', sourceId: 'default',
      sourceIncarnation: source!.incarnation, slug: 'skills/parity-pack/parity-skill', requestId: REQUESTS[1]!, targetKind: 'skill_bundle', protocolVersion: 2,
      callerIntent: { name: 'parity-skill' }, intent: { name: 'parity-skill' } }).then(() => null, (e: { code?: string; reason?: string; message?: string }) => e);
    // The admission checks the shared-skill owner; none was activated, so nothing is accepted.
    expect(refusal?.code).toBe('writer_not_quiesced');
    return { code: refusal?.code, message: refusal?.message };
  });

  parityTest('every admission branch a plain write reaches ends typed: admit, replay, changed replay, background pause, and a managed sync job past the cap', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'readWriteRequest', 'readAdmissionRate', 'getConfigValues'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const first = await admitPut(engine, 'notes/parity-replay', REQUESTS[0]!);
    const replay = await admitPut(engine, 'notes/parity-replay', REQUESTS[0]!);
    const changed = await admitPut(engine, 'notes/parity-replay-other', REQUESTS[0]!).then(() => null, (e: { code?: string }) => e.code);
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '10');
    await engine.setConfig('persistence.capacity.background_pause_pct', '10');
    const paused = await withAdmissionOrigin('background', () => admitPut(engine, 'notes/parity-background', REQUESTS[1]!))
      .then(() => null, (e: { code?: string }) => e.code);
    expect(replay.id).toBe(first.id);
    expect(changed).toBe('idempotency_conflict');
    expect(paused).toBe('write_capacity_backpressure');
    // A managed sync job past the outstanding cap counts the writes held behind its import, which needs managed persistence.
    await engine.setConfig('persistence.limits.principal_outstanding', '1');
    const sync = await admitPut(engine, 'jobs/parity-sync', 'b0000000-0000-4000-8000-0000000000b5', 'default', 'submit_job', { kind: 'managed_sync_import' })
      .then(() => null, (e: { code?: string; reason?: string }) => e);
    return { replayed: true, state: replay.state, changed, paused, sync: sync?.code };
  });
});
