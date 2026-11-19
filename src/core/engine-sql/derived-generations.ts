/**
 * The derived generation ledger statements of generations/publish.ts as typed engine members: the live generation read
 * (`readLiveGeneration`), the activation of a new generation (`activateGeneration`) and the held row a result that may
 * not publish records (`recordHeld`). One SQL implementation for both engines; each statement is the text publish.ts
 * sent through `executeRaw`, byte for byte, with the same parameters, on the engine's own `executeRaw`. Only its home
 * moved. The Rust engine serves them from its `derived_generations` family (rust/crates/gbrain-store/src/generations.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** A generation key (generations/contract.ts GenerationKey). */
export interface GenerationRowKey { sourceId: string; kind: string; ownerKey: string }

/** The live generation of a key with the items it owns (`published`, `kept`, `adopted`, `revived`). */
export interface LiveGenerationRow {
  id: number;
  generation: number;
  input_pin: string | null;
  input_size: number | null;
  locator: string | null;
  items: Array<{ item_key: string; identity_hash: string }>;
}

/** The new live row `activateGenerationRows` inserts. `completeness` is JSON text. */
export interface GenerationActivationRow {
  generation: number;
  runId: string | null;
  operationId: string;
  inputPin: string | null;
  inputSize: number | null;
  completeness: string;
  setHash: string;
  restoreOf: number | null;
  activationId: string | null;
  locator: string | null;
}

/** One ledger item of a new generation, in the column order of `derived_generation_items`. */
export interface GenerationLedgerRow {
  item_key: string;
  identity_hash: string;
  action: string;
  preimage: unknown;
  preimage_bytes: number | null;
  pending: boolean;
}

/** The held row `recordHeldGenerationRow` keeps. `context` and `proposal` are JSON text; a null `proposal` keeps no copy. */
export interface HeldGenerationRow {
  holdId: string;
  runId: string | null;
  inputPin: string | null;
  inputSize: number | null;
  setHash: string;
  reason: string;
  context: string;
  proposal: string | null;
  proposalBytes: number;
}

/** The live row of a key: $1 source, $2 kind, $3 owner key. */
const LIVE_ROW_SQL = `SELECT id, generation, input_pin, input_size, locator FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`;
/** The items a generation owns: $1 the generation id. */
const LIVE_ITEMS_SQL = `SELECT item_key, identity_hash FROM derived_generation_items WHERE generation_id=$1 AND action IN ('published','kept','adopted','revived')`;
/** Supersedes the live row $1. */
const SUPERSEDE_SQL = `UPDATE derived_generations SET state='superseded', updated_at=now() WHERE id=$1 AND state='live'`;
/** Inserts the new live row and returns its id. */
const ACTIVATE_SQL = `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, run_id, operation_id, input_pin, input_size, completeness, item_set_hash, restore_of,
       activation_id, locator)
     VALUES ($1,$2,$3,$4,'live',$5,$6,$7,$8,$9::text::jsonb,$10,$11,$12,$13) RETURNING id`;
/** Points the superseded row $2 at its successor $1. */
const SUPERSEDED_BY_SQL = `UPDATE derived_generations SET superseded_by=$1 WHERE id=$2`;
/** Records the new generation's ledger items: $1 the generation id, $2 the items as JSON text. */
const LEDGER_ITEMS_SQL = `INSERT INTO derived_generation_items (generation_id, item_key, identity_hash, action, preimage, preimage_bytes, pending)
      SELECT $1, i.item_key, i.identity_hash, i.action, i.preimage, i.preimage_bytes, i.pending
      FROM jsonb_to_recordset($2::text::jsonb) AS i(item_key text, identity_hash text, action text, preimage jsonb, preimage_bytes integer, pending boolean)`;
/** Deletes the key's held row and its attempt counters: a live successor answers both. */
const CLEAR_HELD_SQL = `WITH held AS (DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' RETURNING 1)
    DELETE FROM derived_generation_attempts WHERE source_id=$1 AND kind=$2 AND owner_key=$3`;
/** The held row of a key. */
const HELD_ROW_SQL = `SELECT id, hold_id FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held'`;
/** Counts one more attempt of the held row $1. */
const BUMP_ATTEMPTS_SQL = `UPDATE derived_generations SET attempts=attempts+1, updated_at=now() WHERE id=$1`;
/** Deletes the row $1. */
const DELETE_ROW_SQL = `DELETE FROM derived_generations WHERE id=$1`;
/** Inserts the key's held row. */
const INSERT_HELD_SQL = `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, run_id, operation_id, hold_id, input_pin, input_size, item_set_hash,
       held_reason, held_context, proposal, proposal_bytes, attempts)
     VALUES ($1,$2,$3,0,'held',$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12::text::jsonb,$13,1)`;

/** The live generation of `key` with its owned items, or null. */
export async function readLiveGenerationRow(raw: EngineRawRead, key: GenerationRowKey): Promise<LiveGenerationRow | null> {
  const [row] = await raw<{ id: number; generation: number; input_pin: string | null; input_size: number | null; locator: string | null }>(
    LIVE_ROW_SQL, [key.sourceId, key.kind, key.ownerKey]);
  if (!row) return null;
  const items = await raw<{ item_key: string; identity_hash: string }>(LIVE_ITEMS_SQL, [row.id]);
  return { id: Number(row.id), generation: Number(row.generation), input_pin: row.input_pin, input_size: row.input_size === null ? null : Number(row.input_size),
    locator: row.locator, items };
}

/**
 * Supersedes the live row `liveId` (when not null), inserts `row` as the key's live generation with `items`, and deletes
 * the key's held row and attempt counters. Resolves the new row's id. Runs in the caller's transaction.
 */
export async function activateGenerationRows(raw: EngineRawRead, key: GenerationRowKey, liveId: number | null, row: GenerationActivationRow,
  items: readonly GenerationLedgerRow[]): Promise<number> {
  if (liveId !== null) await raw(SUPERSEDE_SQL, [liveId]);
  const [created] = await raw<{ id: number }>(ACTIVATE_SQL,
    [key.sourceId, key.kind, key.ownerKey, row.generation, row.runId, row.operationId, row.inputPin, row.inputSize,
      row.completeness, row.setHash, row.restoreOf, row.activationId, row.locator]);
  const id = Number(created!.id);
  if (liveId !== null) await raw(SUPERSEDED_BY_SQL, [id, liveId]);
  if (items.length) await raw(LEDGER_ITEMS_SQL, [id, JSON.stringify(items)]);
  await raw(CLEAR_HELD_SQL, [key.sourceId, key.kind, key.ownerKey]);
  return id;
}

/**
 * Records `row` as the held row of `key`: the same hold counts one more attempt; another hold replaces it. Runs in the
 * caller's transaction.
 */
export async function recordHeldGenerationRow(raw: EngineRawRead, key: GenerationRowKey, row: HeldGenerationRow): Promise<void> {
  const [existing] = await raw<{ id: number; hold_id: string }>(HELD_ROW_SQL, [key.sourceId, key.kind, key.ownerKey]);
  if (existing?.hold_id === row.holdId) {
    await raw(BUMP_ATTEMPTS_SQL, [existing.id]);
    return;
  }
  if (existing) await raw(DELETE_ROW_SQL, [existing.id]);
  await raw(INSERT_HELD_SQL, [key.sourceId, key.kind, key.ownerKey, row.runId, `held:${row.holdId}`, row.holdId, row.inputPin, row.inputSize, row.setHash,
    row.reason, row.context, row.proposal, row.proposalBytes]);
}
