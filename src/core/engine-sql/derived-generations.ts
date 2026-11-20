/**
 * The derived generation ledger statements of generations/publish.ts as typed engine members: the live generation read
 * (`readLiveGeneration`), the activation of a new generation (`activateGeneration`) and the held row a result that may
 * not publish records (`recordHeld`), and the producer-path statements of `publishGeneration`: the identical-replay
 * check, the held rows of one input (`heldForInput`), the stopped `attempts_exhausted` row (`exhaustedHold`), the
 * attempt counter (`recordAttempt`) and the retirement valve (`readValve`, `bumpValve`). One SQL implementation for both engines; each statement is the text publish.ts
 * sent through `executeRaw`, with the same parameters and a total row order that sorts text by bytes (`COLLATE "C"`, as PGLite and the Rust engine sort it), on the engine's own `executeRaw`.
 * The Rust engine serves them from its `derived_generations` family (rust/crates/gbrain-store/src/generations.rs).
 * Every engine refuses a JSON number past the double range in the written JSON text first (`checkGenerationJsonNumbers`).
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

/** A held row of one input (`heldGenerationRowsForInput`). */
export interface HeldInputRow { hold_id: string; item_set_hash: string; held_reason: string }

/** One hold's terminal failure count and its error codes, oldest first (`countGenerationAttempt`). */
export interface GenerationAttemptCount { attempts: number; codes: string[] }

/** The valve window's retirements (null: none yet) and the items the live generations of the source and kind own. */
export interface GenerationValveRow { retired: number | null; owned: number }

/** The live row of a key: $1 source, $2 kind, $3 owner key. */
const LIVE_ROW_SQL = `SELECT id, generation, input_pin, input_size, locator FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`;
/** The items a generation owns: $1 the generation id. */
const LIVE_ITEMS_SQL = `SELECT item_key, identity_hash FROM derived_generation_items WHERE generation_id=$1 AND action IN ('published','kept','adopted','revived') ORDER BY item_key COLLATE "C"`;
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

/** The held rows of one input: $1 source, $2 kind, $3 owner key, $4 the input pin. */
const HELD_FOR_INPUT_SQL = `SELECT hold_id, item_set_hash, held_reason FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND input_pin=$4`;
/** Counts one terminal failure of the hold $1 with error code $5 and returns the count and the codes. */
const ATTEMPT_UPSERT_SQL = `INSERT INTO derived_generation_attempts (hold_id, source_id, kind, owner_key, attempts, codes) VALUES ($1,$2,$3,$4,1,jsonb_build_array($5::text))
       ON CONFLICT (hold_id) DO UPDATE SET attempts=derived_generation_attempts.attempts+1, codes=derived_generation_attempts.codes || jsonb_build_array($5::text), updated_at=now()
       RETURNING attempts, codes`;
/** Deletes the attempt counter of the hold $1. */
const ATTEMPT_DELETE_SQL = `DELETE FROM derived_generation_attempts WHERE hold_id=$1`;
/** The context of the held row $4 of a key. */
const HELD_CONTEXT_SQL = `SELECT held_context FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND hold_id=$4`;
/** The live generation an identical operation $1 already activated. */
const REPLAY_SQL = `SELECT generation FROM derived_generations WHERE operation_id=$1 AND state = 'live'`;
/** The retirements of the valve window $3 and the items the live generations of $1/$2 own. */
const VALVE_READ_SQL = `SELECT (SELECT retired FROM derived_generation_valve WHERE source_id=$1 AND kind=$2 AND window_key=$3) AS retired,
            (SELECT count(*)::int FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
              WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live' AND i.action IN ('published','kept','adopted','revived')) AS owned`;
/** Adds $4 retirements to the valve window $3. */
const VALVE_BUMP_SQL = `INSERT INTO derived_generation_valve (source_id, kind, window_key, retired) VALUES ($1,$2,$3,$4)
    ON CONFLICT (source_id, kind, window_key) DO UPDATE SET retired=derived_generation_valve.retired+EXCLUDED.retired, updated_at=now()`;

/** Whether the key's live row is a restore (generations/adapters/fact-rows.ts `consolidationRestored`). */
const RESTORED_SQL = `SELECT restore_of IS NOT NULL AS restored FROM derived_generations
    WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`;
/** Deletes the `tie` held rows of $1/$2 whose owner key starts with $4 ($3 is its length; fact-rows.ts `clearConsolidationTies`). */
const CLEAR_TIES_SQL = `DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND state='held' AND held_reason='tie' AND left(owner_key, $3)=$4`;

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
 * Refuses JSON text that holds a number past the double range (such as `1e400`) on every engine, before anything is
 * written. Postgres stores it as `numeric`, but every gbrain reader parses it to `Infinity`, which `JSON.stringify`
 * writes back as `null`; the Rust store cannot parse it. gbrain's own writers build this text with `JSON.stringify`,
 * which never writes such a number. Text that is not JSON is left to the engine's own refusal.
 */
export function checkGenerationJsonNumbers(op: string, column: string, text: string | null): void {
  if (text === null) return;
  let huge = false;
  try {
    JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) huge = true;
      return value;
    });
  } catch {
    return;
  }
  if (huge) throw new Error(`${op}: a JSON number in ${column} is past the double range`);
}

/** The JSON text checks of `recordHeldGenerationRow`. */
export function checkHeldGenerationRow(row: HeldGenerationRow): void {
  checkGenerationJsonNumbers('recordHeldGenerationRow', 'held_context', row.context);
  checkGenerationJsonNumbers('recordHeldGenerationRow', 'proposal', row.proposal);
}

/**
 * Supersedes the live row `liveId` (when not null), inserts `row` as the key's live generation with `items`, and deletes
 * the key's held row and attempt counters. Resolves the new row's id. Runs in the caller's transaction.
 */
export async function activateGenerationRows(raw: EngineRawRead, key: GenerationRowKey, liveId: number | null, row: GenerationActivationRow,
  items: readonly GenerationLedgerRow[]): Promise<number> {
  checkGenerationJsonNumbers('activateGenerationRows', 'completeness', row.completeness);
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
  checkHeldGenerationRow(row);
  const [existing] = await raw<{ id: number; hold_id: string }>(HELD_ROW_SQL, [key.sourceId, key.kind, key.ownerKey]);
  if (existing?.hold_id === row.holdId) {
    await raw(BUMP_ATTEMPTS_SQL, [existing.id]);
    return;
  }
  if (existing) await raw(DELETE_ROW_SQL, [existing.id]);
  await raw(INSERT_HELD_SQL, [key.sourceId, key.kind, key.ownerKey, row.runId, `held:${row.holdId}`, row.holdId, row.inputPin, row.inputSize, row.setHash,
    row.reason, row.context, row.proposal, row.proposalBytes]);
}

/** The held rows of `key` for the input pinned `pin`. */
export async function heldGenerationRowsForInput(raw: EngineRawRead, key: GenerationRowKey, pin: string): Promise<HeldInputRow[]> {
  return raw<HeldInputRow>(HELD_FOR_INPUT_SQL, [key.sourceId, key.kind, key.ownerKey, pin]);
}

/** The `held_context` of the held row `holdId` of `key`, or null when the key holds no such row. */
export async function readHeldGenerationContext(raw: EngineRawRead, key: GenerationRowKey, holdId: string): Promise<{ held_context: Record<string, unknown> | null } | null> {
  const [row] = await raw<{ held_context: Record<string, unknown> | null }>(HELD_CONTEXT_SQL, [key.sourceId, key.kind, key.ownerKey, holdId]);
  return row ?? null;
}

/** The generation number the identical operation `operationId` made live, or null. Runs in the caller's transaction. */
export async function liveGenerationForOperation(raw: EngineRawRead, operationId: string): Promise<number | null> {
  const [row] = await raw<{ generation: number }>(REPLAY_SQL, [operationId]);
  return row ? Number(row.generation) : null;
}

/** Counts one terminal failure of the hold `holdId` of `key` with `code`. Runs in the caller's transaction. */
export async function countGenerationAttempt(raw: EngineRawRead, key: GenerationRowKey, holdId: string, code: string): Promise<GenerationAttemptCount> {
  const [row] = await raw<{ attempts: number; codes: string[] }>(ATTEMPT_UPSERT_SQL, [holdId, key.sourceId, key.kind, key.ownerKey, code]);
  return { attempts: Number(row!.attempts), codes: row!.codes };
}

/** Deletes the attempt counter of the hold `holdId`. Runs in the caller's transaction. */
export async function clearGenerationAttempts(raw: EngineRawRead, holdId: string): Promise<void> {
  await raw(ATTEMPT_DELETE_SQL, [holdId]);
}

/** The valve window `windowKey` of the key's source and kind. */
export async function readGenerationValve(raw: EngineRawRead, key: GenerationRowKey, windowKey: string): Promise<GenerationValveRow> {
  const [row] = await raw<GenerationValveRow>(VALVE_READ_SQL, [key.sourceId, key.kind, windowKey]);
  return { retired: row?.retired ?? null, owned: Number(row?.owned ?? 0) };
}

/** Adds `retired` retirements to the valve window `windowKey` of the key's source and kind. Runs in the caller's transaction. */
export async function bumpGenerationValve(raw: EngineRawRead, key: GenerationRowKey, windowKey: string, retired: number): Promise<void> {
  await raw(VALVE_BUMP_SQL, [key.sourceId, key.kind, windowKey, retired]);
}

/** Whether the live row of `key` is a restore (`restore_of` set); false when the key has no live row. */
export async function readGenerationRestored(raw: EngineRawRead, key: GenerationRowKey): Promise<boolean> {
  const [row] = await raw<{ restored: boolean }>(RESTORED_SQL, [key.sourceId, key.kind, key.ownerKey]);
  return row?.restored === true;
}

/**
 * Deletes the held rows of `kind` in `sourceId` held `tie` whose owner key starts with `ownerPrefix`, with their items,
 * in the caller's transaction. The prefix length is its JavaScript length, as the caller sent it.
 */
export async function clearTieHeldGenerationRows(raw: EngineRawRead, sourceId: string, kind: string, ownerPrefix: string): Promise<void> {
  await raw(CLEAR_TIES_SQL, [sourceId, kind, ownerPrefix.length, ownerPrefix]);
}
