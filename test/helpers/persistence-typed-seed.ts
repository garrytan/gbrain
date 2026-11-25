/**
 * Typed fixtures for persistence journal rows: a request admitted and settled, and the effects a publication queues,
 * written through the BrainEngine journal members (`insertWriteRequest`, `completeWriteRow`, `insertPublicationEffects`)
 * on every engine arm. A row seeded this way is one the managed journal itself can write, so the Rust arm reads the
 * same rows PGLite and Postgres read, and no case needs raw SQL to seed them.
 *
 * The request charges no counters (`counterKeys: []`), so a case that lists counter rows sees only the rows it seeds.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';

export interface TypedRequest {
  source: string;
  slug?: string | null;
  operation?: string;
  /** The terminal state; `queued` leaves the request admitted. */
  state?: 'queued' | 'committed' | 'conflict' | 'failed' | 'cancelled';
  errorCode?: string | null;
  errorMessage?: string | null;
  intent?: unknown;
  outcome?: unknown;
  digest?: string;
  principalId?: string;
  requestId?: string;
}

/** Admits one request of `r.source` and, unless it stays queued, settles it. Returns its row id and request id. */
export async function seedTypedRequest(engine: BrainEngine, r: TypedRequest): Promise<{ id: string; requestId: string; incarnation: string }> {
  const source = await engine.readSourceMembership(r.source);
  if (!source) throw new Error(`seedTypedRequest: no source ${r.source}`);
  const requestId = r.requestId ?? randomUUID();
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: r.principalId ?? 'collate', requestId, operation: r.operation ?? 'put_page', sourceId: r.source,
    sourceIncarnation: source.incarnation, pageId: null, slug: r.slug === undefined ? 'notes/x' : r.slug, worktreeId: null, topologyGeneration: null,
    digest: r.digest ?? 'x', intent: r.intent ?? {}, authority: {}, intentBytes: 0, terminalReservation: 0, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'v-collate', admitterHostId: null, counterKeys: [], clientRequestId: null,
    state: 'queued', deferredRefreshId: null,
  });
  const state = r.state ?? 'failed';
  if (state !== 'queued') await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.completeWriteRow({
      id: row.id, state, outcome: r.outcome ?? null, errorCode: r.errorCode ?? null, errorMessage: r.errorMessage ?? null,
      consumerVersion: 'v-collate', consumerHostId: null, errorDetail: null, resultBytes: 0, counterKeys: [], intentBytes: 0,
      retainedBytes: 0, terminalReservation: 0, probePurges: false,
    });
  });
  return { id: row.id, requestId, incarnation: source.incarnation };
}

/** Queues `kinds` (in that order) as the effects of request row `id` of `source`. */
export async function seedTypedEffects(engine: BrainEngine, request: { id: string; source: string; incarnation: string },
  effects: ReadonlyArray<{ kind: string; data?: Record<string, unknown> }>): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.insertPublicationEffects({
      requestId: request.id, revision: null, sourceId: request.source, sourceIncarnation: request.incarnation, worktreeId: null,
      effects: effects.map(effect => ({ kind: effect.kind, data: effect.data ?? {} })),
    });
  });
}

export type EffectSettlement =
  | { to: 'failed'; reason: string }
  | { to: 'parked'; data: Record<string, unknown> }
  | { to: 'busy'; data: Record<string, unknown> };

/**
 * Settles every claimable effect the way the effect worker does: claim it (`selectClaimableEffect`, `stampEffectClaim`),
 * then fail it with a code, park its targets, or requeue it busy (`failEffectRow`, `parkEffectRow`, `retryBusyEffectRow`).
 * `settle` picks the settlement per effect kind. Returns how many effects it settled.
 */
export async function settleTypedEffects(engine: BrainEngine, settle: (kind: string) => EffectSettlement): Promise<number> {
  const host = randomUUID();
  let settled = 0;
  for (;;) {
    const effect = await engine.selectClaimableEffect<{ id: string | number; kind: string; state: string }>(host, []);
    if (!effect || effect.state !== 'queued') return settled;
    const token = randomUUID();
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.stampEffectClaim({ id: effect.id, token, ownerJson: JSON.stringify({ token, owner: { pid: 1, nonce: 'collate', start: 'collate' } }) });
      const how = settle(effect.kind);
      if (how.to === 'failed') await tx.failEffectRow({ id: effect.id, token, reason: how.reason });
      else if (how.to === 'parked') await tx.parkEffectRow({ id: effect.id, token, dataJson: JSON.stringify(how.data) });
      else await tx.retryBusyEffectRow({ id: effect.id, token, dataJson: JSON.stringify(how.data), delayMs: 3_600_000 });
    });
    settled++;
  }
}
