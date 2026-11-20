/**
 * The managed generation statements of generations/managed.ts as typed engine members: the activation row a managed
 * publication records with its batch (`recordActivation`), the flip to `activated` inside the activation request, the
 * member gate (`assertMemberPending`), the settle of a member's pending mark (`settleMember`), and the two operator
 * lists (`listPendingMembers`, `listOrphanCandidates`). One SQL implementation for both engines; each statement is the
 * text managed.ts sent through `executeRaw`, with the same parameters and a total row order that sorts text by bytes (`COLLATE "C"`, as PGLite and the Rust engine sort it), on the engine's own `executeRaw`.
 * The generation key lock is `lockGenerationKey` (engine-sql/fence-holds.ts), the same statement. These are ledger
 * reads, not page reads, so they take no page read policy. The Rust engine serves them from its
 * `derived_generation_activations` rows (rust/crates/gbrain-store/src/generations/activations.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { GenerationRowKey } from './derived-generations.ts';

/** One member an activation row records (generations/managed.ts ActivationMember, without its preimage). */
export interface ActivationMemberRow { slug: string; action: string; identity: string; before: string | null }

/** The activation row a managed publication admits with its batch. */
export interface GenerationActivationRecord {
  activationId: string;
  expectedGeneration: number;
  inputPin: string | null;
  setHash: string;
  members: readonly ActivationMemberRow[];
}

/** What the member gate reads: the activation's state, its generation's state and the item's pending mark. */
export interface GenerationActivationState { state: string; generation_state: string | null; pending: boolean | null }

/** An item a live generation still waits on a member request for. `generation_id` is BIGINT (text on Postgres). */
export interface PendingGenerationMemberRow {
  source_id: string; kind: string; owner_key: string; generation_id: number | string; activation_id: string;
  slug: string; item_action: string; identity: string;
}

/** A page a `create` member wrote for an activation that never happened. */
export interface GenerationOrphanRow { source_id: string; kind: string; owner_key: string; activation_id: string; slug: string; created_at: string }

const RECORD_ACTIVATION_SQL = `INSERT INTO derived_generation_activations (id, source_id, kind, owner_key, expected_generation, input_pin, item_set_hash, state, members)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::text::jsonb) ON CONFLICT (id) DO NOTHING`;

const MARK_ACTIVATED_SQL = `UPDATE derived_generation_activations SET state='activated', generation_id=$2, updated_at=now() WHERE id=$1`;

const ACTIVATION_STATE_SQL = `SELECT a.state, g.state AS generation_state, i.pending FROM derived_generation_activations a
       LEFT JOIN derived_generations g ON g.id=a.generation_id
       LEFT JOIN derived_generation_items i ON i.generation_id=a.generation_id AND i.item_key=$2
      WHERE a.id=$1 AND a.source_id=$3`;

const SETTLE_MEMBER_SQL = `UPDATE derived_generation_items SET pending=false
    WHERE generation_id=(SELECT generation_id FROM derived_generation_activations WHERE id=$1) AND item_key=$2`;

const PENDING_MEMBERS_SQL = `SELECT g.source_id, g.kind, g.owner_key, g.id AS generation_id, g.activation_id, i.item_key AS slug, i.action AS item_action, i.identity_hash AS identity
       FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE i.pending AND g.state='live' AND g.source_id=ANY($1::text[]) AND ($2::text IS NULL OR g.kind=$2) ORDER BY g.source_id COLLATE "C", g.kind COLLATE "C", g.owner_key COLLATE "C", i.item_key COLLATE "C"`;

const ORPHAN_CANDIDATES_SQL = `SELECT a.source_id, a.kind, a.owner_key, a.id AS activation_id, m->>'slug' AS slug, a.created_at::text AS created_at
       FROM derived_generation_activations a CROSS JOIN LATERAL jsonb_array_elements(a.members) m
      WHERE a.state='pending' AND a.source_id=ANY($1::text[]) AND ($2::text IS NULL OR a.kind=$2) AND m->>'action'='create'
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.request_id=a.id::uuid AND r.state IN ('queued','deferred','running','recovering'))
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=m->>'slug' AND p.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
          WHERE g.source_id=a.source_id AND g.kind=a.kind AND g.state='live' AND i.item_key=m->>'slug' AND i.action<>'retired')
      ORDER BY a.source_id COLLATE "C", a.kind COLLATE "C", a.owner_key COLLATE "C", (m->>'slug') COLLATE "C", a.id COLLATE "C"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refuses an activation id that is not a uuid (8-4-4-4-12 hex digits) on every engine. The orphan list casts each
 * pending activation id to `uuid` to match its request, so on Postgres one such row would fail that list for every
 * caller; managed.ts always writes a request uuid (`activationRequestId`).
 */
export function checkActivationId(activationId: string): void {
  if (!UUID.test(activationId)) throw new Error(`activation id must be a uuid (8-4-4-4-12 hex digits): ${JSON.stringify(activationId)}`);
}

/** Inserts the pending activation row of `key` unless a row with its id exists. Refuses an id that is not a uuid. */
export async function recordGenerationActivation(raw: EngineRawRead, key: GenerationRowKey, row: GenerationActivationRecord): Promise<void> {
  checkActivationId(row.activationId);
  await raw(RECORD_ACTIVATION_SQL, [row.activationId, key.sourceId, key.kind, key.ownerKey, row.expectedGeneration, row.inputPin, row.setHash,
    JSON.stringify(row.members.map(member => ({ slug: member.slug, action: member.action, identity: member.identity, before: member.before })))]);
}

/** Marks the activation `activationId` activated with the generation it made. */
export async function markGenerationActivated(raw: EngineRawRead, activationId: string, generationId: number): Promise<void> {
  await raw(MARK_ACTIVATED_SQL, [activationId, generationId]);
}

/** The activation `activationId` of `sourceId` with its generation's state and `slug`'s pending mark, or null. */
export async function readGenerationActivationState(raw: EngineRawRead, activationId: string, slug: string, sourceId: string): Promise<GenerationActivationState | null> {
  const [row] = await raw<GenerationActivationState>(ACTIVATION_STATE_SQL, [activationId, slug, sourceId]);
  return row ?? null;
}

/** Clears `slug`'s pending mark on the generation the activation made. */
export async function settleGenerationMember(raw: EngineRawRead, activationId: string, slug: string): Promise<void> {
  await raw(SETTLE_MEMBER_SQL, [activationId, slug]);
}

/** The pending items of the live generations of `sourceIds` (one kind when given), in key and item order. */
export async function listPendingGenerationMembers(raw: EngineRawRead, sourceIds: readonly string[], kind: string | null): Promise<PendingGenerationMemberRow[]> {
  return raw<PendingGenerationMemberRow>(PENDING_MEMBERS_SQL, [[...sourceIds], kind]);
}

/** The orphan candidates of the pending activations of `sourceIds` (one kind when given), in key and slug order. */
export async function listGenerationOrphanCandidates(raw: EngineRawRead, sourceIds: readonly string[], kind: string | null): Promise<GenerationOrphanRow[]> {
  return raw<GenerationOrphanRow>(ORPHAN_CANDIDATES_SQL, [[...sourceIds], kind]);
}
