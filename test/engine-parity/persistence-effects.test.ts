/**
 * BrainEngine parity — the effect-journal members (engine-sql/persistence-effects.ts): queue, claim, complete and
 * release a request's effects, the withdrawal-mirror gate and re-arm reads, the brain-row share lock, the
 * publishing-recovery probe, and the source row's `archived` flag under a share lock.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: one request's effects are queued in order (an existing kind kept, a gated `links` row skipped while
 *    auto-linking is off), the claimable pick honours the withdrawal-mirror gate, a claim stamps the row, completion
 *    needs the claim's token, a stale claim is released by its cutoff, and the gate and re-arm reads answer the same on
 *    every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of these differently publishes a page's Git, embedding or link effects in
 *    the wrong order, twice, or never; the Rust engine has no SQL, so each statement has to exist as a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside effect-journal.ts, effects.ts
 *    and effect-recovery.ts, which the parity cases cannot call (D18), so no case compared them across engines.
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). Generated values (effect ids, tokens, time
 *    stamps, the source incarnation) are compared by shape or left out of the returned value.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PersistenceEffect } from '../../src/core/persistence/effect-model.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const REQUEST = 'b0000000-0000-4000-8000-0000000000e1';
const OTHER = 'b0000000-0000-4000-8000-0000000000e2';
const TOKEN = 'c0000000-0000-4000-8000-0000000000e1';
const TOKEN2 = 'c0000000-0000-4000-8000-0000000000e2';
const WRONG = 'c0000000-0000-4000-8000-0000000000ff';
const HOST = 'a0000000-0000-4000-8000-0000000000a1';
const OWNER = JSON.stringify({ token: TOKEN, owner: { pid: 1, nonce: 'parity', start: 1 } });
const PARKED = { parked: [{ slug: 'notes/parity-example', error_code: 'withdrawal_mirror_failed' }] };

/** The effect columns every arm stores the same way, with generated values reduced to their shape. */
const view = (effect: PersistenceEffect | null) => {
  if (!effect) return effect;
  const row = effect as PersistenceEffect & { claim_owner?: unknown; updated_at?: unknown; next_attempt_at?: unknown };
  return {
  idIsNumberLike: /^\d+$/.test(String(row.id)), requestIsUuid: UUID.test(String(row.request_id)), kind: row.kind, revision: row.revision ?? null, data: row.data,
  state: row.state, token: row.execution_token ?? null, attempts: Number(row.attempts), leased: row.claim_expires_at != null,
  errorCode: row.error_code ?? null, outcome: row.outcome ?? null, recovery: row.recovery ?? null, source: row.source_id,
  incarnationIsUuid: UUID.test(String(row.source_incarnation)), worktree: row.worktree_id ?? null, owner: row.claim_owner ?? null,
  dated: row.updated_at instanceof Date && row.next_attempt_at instanceof Date,
  };
};

/**
 * Fixture: admits request `requestId` on the default source and returns its journal id. PGLite and Postgres insert the
 * row in a transaction; the Rust engine serves neither, so its arm admits through the store (as createRustSource does).
 */
async function admit(engine: BrainEngine, backend: string, requestId: string, incarnation: string): Promise<string> {
  const intent = { kind: 'put_page', slug: 'notes/parity-example' };
  if (backend === 'rust') {
    const store = (engine as unknown as { openStore(member: string): { brain: { admitWrite(a: unknown): Promise<{ id: string }> } } }).openStore('admitWrite');
    const row = await store.brain.admitWrite({ principal: PRINCIPAL, operation: 'put_page', sourceId: 'default', sourceIncarnation: incarnation,
      slug: intent.slug, requestId, callerIntent: intent, authority: { scopes: ['write'] } });
    return row.id;
  }
  return engine.transaction(async (tx) => (await tx.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: intent.slug, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id);
}

/** Runs `body` with request REQUEST admitted; `body` gets its journal id and the source incarnation. */
async function withRequest<T>(engine: BrainEngine, backend: string, body: (tx: BrainEngine, id: string, incarnation: string) => Promise<T>): Promise<T> {
  const source = await engine.readSourceIncarnation('default');
  expect(source?.incarnation).toMatch(UUID);
  return body(engine, await admit(engine, backend, REQUEST, source!.incarnation), source!.incarnation);
}

const queueOf = (id: string, incarnation: string, queued: Array<{ kind: string; data: Record<string, unknown>; gated?: boolean }>) =>
  ({ requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null, queued });

describe('engine parity: effect journal', () => {
  parityTest('queueEffects inserts in order, keeps an existing kind and skips a gated row while auto-linking is off', {
    methods: ['setConfig', 'readSourceIncarnation', 'queueEffects'],
  }, async (engine, backend) => {
    await engine.setConfig('auto_link', ' Off ');
    const result = await withRequest(engine, backend, async (tx, id, incarnation) => {
      const first = await tx.queueEffects(queueOf(id, incarnation, [
        { kind: 'git', data: { slug: 'notes/parity-example' } }, { kind: 'embedding', data: {} }, { kind: 'links', data: {}, gated: true },
      ]));
      const again = await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'embedding', data: { other: true } }, { kind: 'facts-backstop', data: {} }]));
      const none = await tx.queueEffects(queueOf(id, incarnation, []));
      return { first, again, none };
    });
    expect(result).toEqual({ first: ['git', 'embedding'], again: ['facts-backstop'], none: [] });
    return result;
  });

  parityTest('a gated links row is queued while auto-linking is on', {
    methods: ['readSourceIncarnation', 'queueEffects'],
  }, async (engine, backend) => {
    const kinds = await withRequest(engine, backend, (tx, id, incarnation) => tx.queueEffects(queueOf(id, incarnation, [{ kind: 'links', data: {}, gated: true }])));
    expect(kinds).toEqual(['links']);
    return kinds;
  });

  parityTest('selectClaimableEffect picks the withdrawal mirror ahead of the effects it gates; claimEffect stamps it', {
    methods: ['readSourceIncarnation', 'queueEffects', 'selectClaimableEffect', 'claimEffect'],
  }, async (engine, backend) => {
    const result = await withRequest(engine, backend, async (tx, id, incarnation) => {
      const empty = await tx.selectClaimableEffect(HOST, []);
      await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'git', data: {} }, { kind: 'withdrawal-mirror', data: {} }]));
      const picked = await tx.selectClaimableEffect(HOST, []);
      const claimed = await tx.claimEffect(picked!.id, TOKEN, OWNER);
      const unknown = await tx.claimEffect(999_999, TOKEN, OWNER);
      // The mirror is running under a live lease, so the gated git effect still waits and nothing is claimable.
      const blocked = await tx.selectClaimableEffect(HOST, []);
      return { empty, picked: view(picked), claimed: view(claimed), sameRow: String(claimed?.id) === String(picked?.id), unknown, blocked: view(blocked) };
    });
    expect(result.empty).toBeNull();
    expect(result.picked).toMatchObject({ kind: 'withdrawal-mirror', state: 'queued', attempts: 0, token: null, leased: false, dated: true });
    expect(result.claimed).toMatchObject({ kind: 'withdrawal-mirror', state: 'running', attempts: 1, token: TOKEN, leased: true, owner: JSON.parse(OWNER) });
    expect(result.sameRow).toBe(true);
    expect(result.unknown).toBeNull();
    expect(result.blocked).toBeNull();
    return result;
  });

  parityTest('completeEffect needs the claim token and fails a row with parked targets as targets_parked', {
    methods: ['readSourceIncarnation', 'queueEffects', 'selectClaimableEffect', 'claimEffect', 'completeEffect', 'hasRearmableEffects'],
  }, async (engine, backend) => {
    const result = await withRequest(engine, backend, async (tx, id, incarnation) => {
      await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'git', data: { ...PARKED, retry_slugs: ['x'], busy_since: 1 } }, { kind: 'embedding', data: {} }]));
      const git = await tx.selectClaimableEffect(HOST, []);
      await tx.claimEffect(git!.id, TOKEN, OWNER);
      const wrongToken = await tx.completeEffect(git!.id, WRONG, { status: 'parity' });
      const noToken = await tx.completeEffect(git!.id, null, { status: 'parity' });
      const done = await tx.completeEffect(git!.id, TOKEN, { status: 'parity' });
      const twice = await tx.completeEffect(git!.id, TOKEN, { status: 'parity' });
      const embedding = await tx.selectClaimableEffect(HOST, []);
      await tx.claimEffect(embedding!.id, TOKEN2, OWNER);
      const committed = await tx.completeEffect(embedding!.id, TOKEN2, { status: 'ok' });
      const after = await tx.selectClaimableEffect(HOST, []);
      // The parked git row was failed, not committed: once a withdrawal mirror commits it is re-armable.
      await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'withdrawal-mirror', data: {} }]));
      const mirror = await tx.selectClaimableEffect(HOST, []);
      await tx.claimEffect(mirror!.id, TOKEN, OWNER);
      await tx.completeEffect(mirror!.id, TOKEN, { status: 'mirrored' });
      const parkedFailed = await tx.hasRearmableEffects([id]);
      return { wrongToken, noToken, done, twice, embeddingKind: embedding?.kind, committed, after, parkedFailed };
    });
    expect(result).toEqual({ wrongToken: false, noToken: false, done: true, twice: false, embeddingKind: 'embedding', committed: true, after: null, parkedFailed: true });
    return result;
  });

  parityTest('completeEffects completes the rows that still hold their claim and counts them', {
    methods: ['readSourceIncarnation', 'queueEffects', 'selectClaimableEffect', 'claimEffect', 'completeEffects'],
  }, async (engine, backend) => {
    const result = await withRequest(engine, backend, async (tx, id, incarnation) => {
      await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'git', data: {} }, { kind: 'embedding', data: {} }, { kind: 'links', data: {} }]));
      const claimed: Array<{ id: string | number; token: string | null }> = [];
      for (const token of [TOKEN, TOKEN2]) {
        const row = await tx.selectClaimableEffect(HOST, []);
        await tx.claimEffect(row!.id, token, OWNER);
        claimed.push({ id: row!.id, token });
      }
      const empty = await tx.completeEffects([], { status: 'batch' });
      const count = await tx.completeEffects([...claimed, { id: claimed[0]!.id, token: WRONG }, { id: 999_999, token: TOKEN }], { status: 'batch' });
      const again = await tx.completeEffects(claimed, { status: 'batch' });
      const left = view(await tx.selectClaimableEffect(HOST, []));
      return { empty, count, again, left };
    });
    expect(result).toMatchObject({ empty: 0, count: 2, again: 0, left: { kind: 'links', state: 'queued' } });
    return result;
  });

  parityTest('releaseAbandonedEffectClaims requeues a running claim last written before the cutoff, and only that', {
    methods: ['readSourceIncarnation', 'queueEffects', 'selectClaimableEffect', 'claimEffect', 'releaseAbandonedEffectClaims'],
  }, async (engine, backend) => {
    const result = await withRequest(engine, backend, async (tx, id, incarnation) => {
      await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'git', data: {} }]));
      const row = await tx.selectClaimableEffect(HOST, []);
      await tx.claimEffect(row!.id, TOKEN, OWNER);
      const early = await tx.releaseAbandonedEffectClaims(new Date(Date.now() - 3_600_000));
      const late = await tx.releaseAbandonedEffectClaims(new Date(Date.now() + 3_600_000));
      const again = await tx.releaseAbandonedEffectClaims(new Date(Date.now() + 3_600_000));
      const requeued = view(await tx.selectClaimableEffect(HOST, []));
      return { early, late, again, requeued };
    });
    expect(result).toMatchObject({ early: 0, late: 1, again: 0, requeued: { kind: 'git', state: 'queued', token: null, owner: null, leased: false, attempts: 1 } });
    return result;
  });

  parityTest('listMirrorGates and hasRearmableEffects follow the withdrawal mirror from queued to committed', {
    methods: ['readSourceIncarnation', 'queueEffects', 'selectClaimableEffect', 'claimEffect', 'completeEffect', 'listMirrorGates', 'hasRearmableEffects'],
  }, async (engine, backend) => {
    const result = await withRequest(engine, backend, async (tx, id, incarnation) => {
      const other = await admit(tx, backend, OTHER, incarnation);
      await tx.queueEffects(queueOf(id, incarnation, [{ kind: 'git', data: PARKED }, { kind: 'embedding', data: {} }, { kind: 'withdrawal-mirror', data: { slug: 'notes/parity-example' } }]));
      await tx.queueEffects(queueOf(other, incarnation, [{ kind: 'withdrawal-mirror', data: { published: ['x'] } }]));
      const none = await tx.listMirrorGates([]);
      const queuedGates = (await tx.listMirrorGates([id, id, other])).sort((a, b) => a.request_id.localeCompare(b.request_id));
      const rearmBefore = await tx.hasRearmableEffects([id]);
      const mirror = await tx.selectClaimableEffect(HOST, []);
      await tx.claimEffect(mirror!.id, TOKEN, OWNER);
      await tx.completeEffect(mirror!.id, TOKEN, { status: 'mirrored' });
      const afterGates = await tx.listMirrorGates([id]);
      const rearmAfter = await tx.hasRearmableEffects([id, id]);
      const rearmOther = await tx.hasRearmableEffects([other]);
      const rearmNone = await tx.hasRearmableEffects([]);
      return { none, queuedGates, rearmBefore, mirrorRequest: mirror?.request_id, afterGates, rearmAfter, rearmOther, rearmNone, ids: { id, other } };
    });
    expect(result.none).toEqual([]);
    expect(result.queuedGates as unknown[]).toEqual([
      { request_id: result.ids.id, state: 'queued', data: { slug: 'notes/parity-example' } },
      { request_id: result.ids.other, state: 'queued', data: { published: ['x'] } },
    ].sort((a, b) => a.request_id.localeCompare(b.request_id)));
    expect(result.rearmBefore).toBe(false);
    expect(result.afterGates).toEqual([]);
    expect(result.rearmAfter).toBe(true);
    expect(result.rearmOther).toBe(false);
    expect(result.rearmNone).toBe(false);
    const { ids, ...rest } = result;
    return { ...rest, ids: { id: UUID.test(ids.id), other: UUID.test(ids.other) }, mirrorRequest: rest.mirrorRequest === ids.id, queuedGates: rest.queuedGates.map(g => ({ ...g, request_id: g.request_id === ids.id ? 'id' : 'other' })).sort((a, b) => a.request_id.localeCompare(b.request_id)) };
  });

  parityTest('lockPersistenceBrainShare, requestsStillPublishing and the share-locked source read answer', {
    methods: ['lockPersistenceBrainShare', 'requestsStillPublishing', 'readSourceIncarnation'],
  }, async (engine) => {
    const result = await (async (tx: BrainEngine) => {
      const lock = await tx.lockPersistenceBrainShare();
      const publishing = await tx.requestsStillPublishing('d0000000-0000-4000-8000-0000000000d1');
      const shared = await tx.readSourceIncarnation('default', { lock: 'share' });
      const plain = await tx.readSourceIncarnation('default');
      const missing = await tx.readSourceIncarnation('no-such-source', { lock: 'share' });
      return { lock, publishing, shared: shared && { archived: shared.archived, incarnation: UUID.test(shared.incarnation) },
        plain: plain && { archived: plain.archived, same: plain.incarnation === shared?.incarnation }, missing };
    })(engine);
    expect(result).toEqual({ lock: undefined, publishing: null, shared: { archived: false, incarnation: true }, plain: { archived: false, same: true }, missing: null });
    return result;
  });

  parityTest('readSourceIncarnation reports an archived source under a share lock, as guardEffectSource reads it', {
    methods: ['readSourceIncarnation'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await createSource(engine, backend, 'old');
    await archiveSource(engine, backend, 'old');
    const view = (row: { archived: boolean; incarnation: string } | null) => row && { archived: row.archived, incarnation: UUID.test(String(row.incarnation)) };
    const result = { work: view(await engine.readSourceIncarnation('work', { lock: 'share' })), old: view(await engine.readSourceIncarnation('old', { lock: 'share' })),
      oldPlain: view(await engine.readSourceIncarnation('old')) };
    expect(result).toEqual({ work: { archived: false, incarnation: true }, old: { archived: true, incarnation: true }, oldPlain: { archived: true, incarnation: true } });
    return result;
  });
});
