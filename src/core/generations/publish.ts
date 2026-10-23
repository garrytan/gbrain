/**
 * GBRA-161 PR 1a: the generation primitive. `publishGeneration` is the one way a derived producer replaces the set of
 * items one input owns (docs/architecture/generations.md). Under the item page locks and the generation key lock it
 * replays an identical operation, fences a stale producer (`generation_fenced`), plans the result (plan.ts), and either
 * records it as held (`generation_held`, nothing retired) or, in one attributed transaction, writes the new and changed
 * items, marks them complete, rechecks each at its identity hash, versions and retires what the new generation no longer
 * has with bounded preimages on the ledger, supersedes the previous generation and activates the new one. Nothing is
 * retired except in the transaction that makes a complete successor live (D2, unmanaged path). Managed sources keep
 * their coordinator path until PR 1b.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { LATEST_VERSION } from '../migrate.ts';
import { policyHash, readGenerationsConfig, type GenerationsConfig } from './config.ts';
import type { GenerationAdapter, GenerationKey, HeldReason, InputState, Preimage, ProposedItem } from './contract.ts';
import { planGeneration, type LiveGeneration } from './plan.ts';
import { proofHolds, type EmptySourceProof } from './proofs.ts';

/** The largest held proposal the ledger keeps (UTF-8 bytes of its JSON); a larger one is held without a releasable copy. */
export const HELD_PROPOSAL_MAX_BYTES = 4 * 1024 * 1024;

export interface PublishRequest<C = unknown> {
  key: GenerationKey;
  items: readonly ProposedItem[];
  /** For an empty result: the proof that the input really holds nothing (proofs.ts). */
  proof?: EmptySourceProof;
  /** The input the producer read; activation refuses when it moved (`pin_moved`). Omit for an `originGone` proof. */
  input?: InputState | null;
  /** The live generation number the producer planned against (0: none); a different live generation refuses (`stale_generation`). */
  expectedGeneration?: number;
  runId?: string;
  /** The input was cut short: write the items, retire nothing, leave them incomplete. */
  partial?: boolean;
  context?: C;
  /** An operator release of this held row (repair generations --mode release-held). */
  release?: { holdId: string; reason: HeldReason };
}

export type PublishOutcome =
  | { state: 'published'; generationId: number; generation: number; puts: string[]; kept: string[]; adopted: string[]; retired: string[]; protected: string[] }
  | { state: 'unchanged'; generation: number | null; retired: string[]; protected: string[] }
  | { state: 'held'; reason: HeldReason; holdId: string; context: Record<string, unknown> };

/** Item-set hash of a result: what an identical replay and a held row bind. */
export function itemSetHash(items: readonly Pick<ProposedItem, 'key' | 'identityHash'>[]): string {
  return digest(['generation-items-v1', [...items].map(item => [item.key, item.identityHash]).sort((a, b) => a[0]!.localeCompare(b[0]!))]);
}

const keyLock = (key: GenerationKey) => `gbrain:generation:${key.kind}:${key.sourceId}:${key.ownerKey}`;

/** Takes the item page locks (slug order) and then the generation key lock (D7). */
export async function lockGeneration(tx: BrainEngine, adapter: GenerationAdapter<unknown>, key: GenerationKey, itemKeys: readonly string[]): Promise<void> {
  const pages = adapter.lockKeys(key, itemKeys).sort((a, b) => a.slug.localeCompare(b.slug));
  if (pages.length) await tx.lockPageKeys(pages);
  await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [keyLock(key)]);
}

/** The live generation of `key` with its owned items, or null. */
export async function readLiveGeneration(db: BrainEngine, key: GenerationKey): Promise<LiveGeneration | null> {
  const [row] = await db.executeRaw<{ id: number; generation: number; input_pin: string | null; input_size: number | null }>(
    `SELECT id, generation, input_pin, input_size FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`,
    [key.sourceId, key.kind, key.ownerKey]);
  if (!row) return null;
  const items = await db.executeRaw<{ item_key: string; identity_hash: string }>(
    `SELECT item_key, identity_hash FROM derived_generation_items WHERE generation_id=$1 AND action IN ('published','kept','adopted','revived')`, [row.id]);
  return { id: Number(row.id), generation: Number(row.generation), inputPin: row.input_pin, inputSize: row.input_size === null ? null : Number(row.input_size),
    items: new Map(items.map(item => [item.item_key, item.identity_hash])) };
}

function fenced(reason: 'stale_generation' | 'pin_moved', key: GenerationKey, detail: string) {
  return opError('generation_fenced', `The ${key.kind} generation of ${key.ownerKey} was not published: ${detail}; nothing was written.`,
    'Run the producer again; it reads the current generation and input and recomputes.', { reason, docs: 'docs/architecture/generations.md#publishing' });
}

export interface LedgerItem { key: string; identityHash: string; action: 'published' | 'retired' | 'revived' | 'kept' | 'adopted'; preimage?: Preimage }

/** Supersedes the live row (if any) and activates a new generation with its items, in the caller's transaction. */
export async function activateGeneration(tx: BrainEngine, key: GenerationKey, live: LiveGeneration | null, row: {
  operationId: string; runId?: string; input: InputState | null; setHash: string; completeness: Record<string, unknown>; restoreOf?: number;
}, items: readonly LedgerItem[]): Promise<{ id: number; generation: number }> {
  const generation = (live?.generation ?? 0) + 1;
  if (live) await tx.executeRaw(`UPDATE derived_generations SET state='superseded', updated_at=now() WHERE id=$1 AND state='live'`, [live.id]);
  const [created] = await tx.executeRaw<{ id: number }>(
    `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, run_id, operation_id, input_pin, input_size, completeness, item_set_hash, restore_of)
     VALUES ($1,$2,$3,$4,'live',$5,$6,$7,$8,$9::text::jsonb,$10,$11) RETURNING id`,
    [key.sourceId, key.kind, key.ownerKey, generation, row.runId ?? null, row.operationId, row.input?.pin ?? null, row.input?.size ?? null,
      JSON.stringify(row.completeness), row.setHash, row.restoreOf ?? null]);
  const id = Number(created!.id);
  if (live) await tx.executeRaw('UPDATE derived_generations SET superseded_by=$1 WHERE id=$2', [id, live.id]);
  for (const item of items) {
    await tx.executeRaw(`INSERT INTO derived_generation_items (generation_id, item_key, identity_hash, action, preimage, preimage_bytes) VALUES ($1,$2,$3,$4,$5::text::jsonb,$6)`,
      [id, item.key, item.identityHash, item.action, item.preimage?.json ? JSON.stringify(item.preimage.json) : null, item.preimage?.bytes ?? null]);
  }
  await tx.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held'`, [key.sourceId, key.kind, key.ownerKey]);
  await tx.executeRaw('DELETE FROM derived_generation_attempts WHERE source_id=$1 AND kind=$2 AND owner_key=$3', [key.sourceId, key.kind, key.ownerKey]);
  return { id, generation };
}

/** Rechecks that each item is live at the identity the generation records (Eng-outside r3). */
export async function assertItemsLive(tx: BrainEngine, adapter: GenerationAdapter<unknown>, key: GenerationKey, expected: ReadonlyMap<string, string>): Promise<void> {
  if (!expected.size) return;
  const rows = await adapter.readItems(tx, key, [...expected.keys()]);
  const wrong = [...expected].filter(([itemKey, identity]) => { const row = rows.get(itemKey); return !row?.live || row.identityHash !== identity; }).map(([itemKey]) => itemKey);
  if (wrong.length) {
    throw opError('generation_live_conflict', `The ${key.kind} generation of ${key.ownerKey} was not activated: ${wrong.slice(0, 5).join(', ')} is not live at the content just written; nothing was committed.`,
      'Run the producer again; it reads the items as they are now.', { docs: 'docs/architecture/generations.md#publishing' });
  }
}

/** A held result's identity: key, input pin, policy, item set and reason. The attempts counter and `heldForInput` share it. */
function holdIdFor(key: GenerationKey, pin: string | null, config: GenerationsConfig, setHash: string, reason: HeldReason): string {
  return digest(['generation-hold-v1', key, pin, policyHash(config), setHash, reason]).slice(0, 32);
}

/** Terminal failures of one hold identity before its result is held `attempts_exhausted` (plan D2, CEO r3 F4). */
export const MAX_GENERATION_ATTEMPTS = 3;

async function recordHeld(tx: BrainEngine, key: GenerationKey, config: GenerationsConfig, request: PublishRequest<unknown>, setHash: string,
  reason: HeldReason, context: Record<string, unknown>): Promise<PublishOutcome> {
  const holdId = holdIdFor(key, request.input?.pin ?? null, config, setHash, reason);
  const [existing] = await tx.executeRaw<{ id: number; hold_id: string }>(
    `SELECT id, hold_id FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held'`, [key.sourceId, key.kind, key.ownerKey]);
  if (existing?.hold_id === holdId) {
    await tx.executeRaw('UPDATE derived_generations SET attempts=attempts+1, updated_at=now() WHERE id=$1', [existing.id]);
    return { state: 'held', reason, holdId, context };
  }
  if (existing) await tx.executeRaw('DELETE FROM derived_generations WHERE id=$1', [existing.id]);
  const proposal = request.items.map(item => ({ key: item.key, content: item.content, identityHash: item.identityHash }));
  const bytes = jsonBytes(proposal);
  await tx.executeRaw(
    `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, run_id, operation_id, hold_id, input_pin, input_size, item_set_hash,
       held_reason, held_context, proposal, proposal_bytes, attempts)
     VALUES ($1,$2,$3,0,'held',$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12::text::jsonb,$13,1)`,
    [key.sourceId, key.kind, key.ownerKey, request.runId ?? null, `held:${holdId}`, holdId, request.input?.pin ?? null, request.input?.size ?? null, setHash,
      reason, JSON.stringify({ ...context, partial: request.partial === true }), bytes <= HELD_PROPOSAL_MAX_BYTES ? JSON.stringify(proposal) : null, bytes]);
  return { state: 'held', reason, holdId, context };
}

/** Whether `key` holds a result for this same input and policy, so the producer can skip recomputing it (CEO-outside r3 F5). */
export async function heldForInput(engine: BrainEngine, key: GenerationKey, pin: string): Promise<boolean> {
  const config = await readGenerationsConfig(engine);
  const rows = await engine.executeRaw<{ hold_id: string; item_set_hash: string; held_reason: string }>(
    `SELECT hold_id, item_set_hash, held_reason FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND input_pin=$4`,
    [key.sourceId, key.kind, key.ownerKey, pin]);
  return rows.some(row => row.hold_id === holdIdFor(key, pin, config, row.item_set_hash, row.held_reason as HeldReason));
}

/**
 * Counts one terminal failure of this hold identity (a fenced producer is not a failure of the result, so it is not
 * counted); the third holds the result `attempts_exhausted` with the last three error codes. Only codes are stored.
 */
async function recordAttempt(engine: BrainEngine, key: GenerationKey, config: GenerationsConfig, request: PublishRequest<unknown>, setHash: string, code: string): Promise<void> {
  const holdId = holdIdFor(key, request.input?.pin ?? null, config, setHash, 'attempts_exhausted');
  await maintenanceTransaction(engine, async tx => {
    const [row] = await tx.executeRaw<{ attempts: number; codes: string[] }>(
      `INSERT INTO derived_generation_attempts (hold_id, source_id, kind, owner_key, attempts, codes) VALUES ($1,$2,$3,$4,1,jsonb_build_array($5::text))
       ON CONFLICT (hold_id) DO UPDATE SET attempts=derived_generation_attempts.attempts+1, codes=derived_generation_attempts.codes || jsonb_build_array($5::text), updated_at=now()
       RETURNING attempts, codes`, [holdId, key.sourceId, key.kind, key.ownerKey, code]);
    if (Number(row!.attempts) < MAX_GENERATION_ATTEMPTS) return;
    await tx.executeRaw('DELETE FROM derived_generation_attempts WHERE hold_id=$1', [holdId]);
    await recordHeld(tx, key, config, request, setHash, 'attempts_exhausted', { attempts: Number(row!.attempts), codes: row!.codes.slice(-MAX_GENERATION_ATTEMPTS) });
  });
}

const failureCode = (error: unknown): string => error instanceof OperationError ? error.code
  : typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'error';

function logFailure(key: GenerationKey, operationId: string, mode: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[generations] ${mode} failed: kind=${key.kind} source=${key.sourceId} schema=v${LATEST_VERSION} mode=unmanaged operation=${operationId}: ${message.slice(0, 300)}`);
}

export async function publishGeneration<C>(engine: BrainEngine, adapter: GenerationAdapter<C>, request: PublishRequest<C>): Promise<PublishOutcome> {
  const { key } = request;
  const config = await readGenerationsConfig(engine);
  const setHash = itemSetHash(request.items);
  const operationId = digest(['generation-publish-v1', key, request.expectedGeneration ?? null, request.input?.pin ?? null, setHash,
    request.partial === true, request.release?.holdId ?? null]);
  const itemKeys = request.items.map(item => item.key);
  if (!request.release) {
    const exhausted = holdIdFor(key, request.input?.pin ?? null, config, setHash, 'attempts_exhausted');
    const [stopped] = await engine.executeRaw<{ held_context: Record<string, unknown> | null }>(
      `SELECT held_context FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND hold_id=$4`, [key.sourceId, key.kind, key.ownerKey, exhausted]);
    if (stopped) return { state: 'held', reason: 'attempts_exhausted', holdId: exhausted, context: stopped.held_context ?? {} };
  }
  try {
    const outcome = await maintenanceTransaction(engine, async tx => {
      await lockGeneration(tx, adapter as GenerationAdapter<unknown>, key, itemKeys);
      const [replay] = await tx.executeRaw<{ generation: number }>(`SELECT generation FROM derived_generations WHERE operation_id=$1 AND state = 'live'`, [operationId]);
      if (replay) return { state: 'unchanged', generation: Number(replay.generation), retired: [], protected: [] } satisfies PublishOutcome;
      const live = await readLiveGeneration(tx, key);
      if (request.expectedGeneration !== undefined && (live?.generation ?? 0) !== request.expectedGeneration) {
        throw fenced('stale_generation', key, `the live generation is ${live?.generation ?? 0}, the producer planned against ${request.expectedGeneration}`);
      }
      const input = await adapter.readInput(tx, key, request.context);
      if (request.input && input?.pin !== request.input.pin) throw fenced('pin_moved', key, 'its input changed after the producer read it');
      const rows = await adapter.readItems(tx, key, itemKeys);
      const unrecorded = [...rows.values()].filter(row => row.owned && row.live && !live?.items.has(row.key) && !itemKeys.includes(row.key));
      const evidence = unrecorded.length ? await adapter.legacyEvidence(tx, key, unrecorded) : new Set<string>();
      const valve = await readValve(tx, key, request.runId);
      const plan = planGeneration({ live, rows, proposal: request.items, input, config, modelProduced: adapter.modelProduced, strictOrder: adapter.strictOrder, additive: request.partial === true,
        proofHolds: request.proof ? proofHolds(request.proof, input, live?.inputPin) : false, evidence, valve, release: request.release?.reason });
      if (plan.kind === 'held') return recordHeld(tx, key, config, request, setHash, plan.reason, plan.context);
      if (plan.kind === 'unchanged') {
        if (!request.partial) await adapter.completeItems?.(tx, key, itemKeys, request.context);
        return { state: 'unchanged', generation: live?.generation ?? null, retired: [], protected: plan.protectedKeys } satisfies PublishOutcome;
      }
      const preimage = (itemKey: string) => rows.get(itemKey)?.preimage();
      if (plan.puts.length) await adapter.publishItems(tx, key, plan.puts, request.context);
      await faultPoint('generation:published', { sourceId: key.sourceId, operation: key.kind });
      const current = [...plan.puts.map(item => [item.key, item.identityHash] as const), ...[...plan.kept, ...plan.adopted].map(itemKey => [itemKey, rows.get(itemKey)!.identityHash] as const)];
      if (!request.partial) await adapter.completeItems?.(tx, key, current.map(([itemKey]) => itemKey), request.context);
      await assertItemsLive(tx, adapter as GenerationAdapter<unknown>, key, new Map(current));
      await adapter.retireItems(tx, key, plan.retires, adapter.retiredBy);
      await faultPoint('generation:retired', { sourceId: key.sourceId, operation: key.kind });
      const items: LedgerItem[] = [
        ...plan.puts.map(item => ({ key: item.key, identityHash: item.identityHash, action: 'published' as const, ...(rows.get(item.key)?.live ? { preimage: preimage(item.key) } : {}) })),
        ...plan.kept.map(itemKey => ({ key: itemKey, identityHash: rows.get(itemKey)!.identityHash, action: 'kept' as const })),
        ...plan.adopted.map(itemKey => ({ key: itemKey, identityHash: rows.get(itemKey)!.identityHash, action: 'adopted' as const })),
        ...plan.carried.map(itemKey => ({ key: itemKey, identityHash: live!.items.get(itemKey)!, action: 'kept' as const })),
        ...plan.retires.map(itemKey => ({ key: itemKey, identityHash: rows.get(itemKey)!.identityHash, action: 'retired' as const, preimage: preimage(itemKey) })),
      ];
      const activated = await activateGeneration(tx, key, live, { operationId, runId: request.runId, input, setHash,
        completeness: { complete: !request.partial, proof: request.proof?.kind ?? null, released: request.release?.reason ?? null } }, items);
      if (plan.retires.length) await bumpValve(tx, key, request.runId, plan.retires.length);
      return { state: 'published', generationId: activated.id, generation: activated.generation, puts: plan.puts.map(item => item.key), kept: plan.kept,
        adopted: plan.adopted, retired: plan.retires, protected: plan.protectedKeys } satisfies PublishOutcome;
    });
    if (outcome.state === 'published') await faultPoint('generation:activated', { sourceId: key.sourceId, operation: key.kind });
    return outcome;
  } catch (error) {
    logFailure(key, operationId, 'publish', error);
    const code = failureCode(error);
    if (code !== 'generation_fenced') {
      await recordAttempt(engine, key, config, request as PublishRequest<unknown>, setHash, code)
        .catch(counted => logFailure(key, operationId, 'attempt count', counted));
    }
    throw error;
  }
}

const windowKey = (runId: string | undefined) => runId ? `run:${runId}` : `day:${new Date().toISOString().slice(0, 10)}`;

async function readValve(tx: BrainEngine, key: GenerationKey, runId: string | undefined): Promise<{ windowRetired: number; ownedTotal: number }> {
  const [row] = await tx.executeRaw<{ retired: number | null; owned: number }>(
    `SELECT (SELECT retired FROM derived_generation_valve WHERE source_id=$1 AND kind=$2 AND window_key=$3) AS retired,
            (SELECT count(*)::int FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
              WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live' AND i.action IN ('published','kept','adopted','revived')) AS owned`,
    [key.sourceId, key.kind, windowKey(runId)]);
  return { windowRetired: Number(row?.retired ?? 0), ownedTotal: Number(row?.owned ?? 0) };
}

async function bumpValve(tx: BrainEngine, key: GenerationKey, runId: string | undefined, retired: number): Promise<void> {
  await tx.executeRaw(`INSERT INTO derived_generation_valve (source_id, kind, window_key, retired) VALUES ($1,$2,$3,$4)
    ON CONFLICT (source_id, kind, window_key) DO UPDATE SET retired=derived_generation_valve.retired+EXCLUDED.retired, updated_at=now()`,
    [key.sourceId, key.kind, windowKey(runId), retired]);
}

