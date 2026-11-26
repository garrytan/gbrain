/**
 * Transaction-local settings (`current_setting` / `set_config(..., true)`) that carry write
 * attribution and trust declarations to the database triggers: one SQL implementation for
 * both engines. Both statements run on the executor they are given, so a transaction engine
 * reads and sets them inside its own transaction. The names are code constants, never user
 * input; they are still bound as parameters and checked against the setting-name alphabet.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment } from './fragment.ts';
/**
 * Transaction-local settings (`current_setting` / `set_config(..., true)`) that carry write
 * attribution and trust declarations to the database triggers: one SQL implementation for
 * both engines. Both statements run on the executor they are given, so a transaction engine
 * reads and sets them inside its own transaction. The names are code constants, never user
 * input; they are still bound as parameters and checked against the setting-name alphabet.
 * `beginSnapshotRead` sets the isolation of a read transaction.
 */
import type { BrainEngine } from '../engine.ts';

const SETTING_NAME = /^[a-z_][a-z0-9_.]*$/;
function assertSettingNames(names: readonly string[]): void {
  for (const name of names) if (!SETTING_NAME.test(name)) throw new Error(`Invalid transaction setting name: ${name}`);
}

/** The current value of each setting, in `names` order; null where it was never set. */
export async function readTransactionSettings(exec: LegacyUnscopedRead, names: readonly string[]): Promise<Array<string | null>> {
  assertSettingNames(names);
  if (names.length === 0) return [];
  const { rows } = await exec.run<{ value: string | null }>(sqlFragment`SELECT current_setting(t.name, true) AS value
    FROM unnest(${[...names]}::text[]) WITH ORDINALITY AS t(name, position) ORDER BY t.position`);
  return names.map((_, index) => rows[index]?.value ?? null);
}

/**
 * The settings a coordinated write establishes (persistence/context.ts `withCoordinatedWrite`), in the order
 * `setWriteContext` reads them back as `previous`: the source scope, the actor, the trust declaration, and
 * `gbrain.git_protocol` (this build applies the git-canonical rules, git-declared.ts).
 */
export const WRITE_CONTEXT_SETTINGS = ['gbrain.write_sources', 'gbrain.write_request', 'gbrain.write_principal_kind',
  'gbrain.write_principal_id', 'gbrain.write_trust_tier', 'gbrain.write_origin', 'gbrain.git_protocol'] as const;

/** What `setWriteContext` declares: the sources written, the actor, and the trust tier and origin ('' when undeclared). */
export interface WriteContextInput {
  sourceIds: readonly string[];
  requestId: string | null;
  principalKind: string;
  principalId: string;
  /** The declared tier, or '' to leave the enclosing trust settings as they are. */
  tier: string;
  /** The declared origin as JSON, or '' to keep the enclosing origin. */
  origin: string;
}

/** The persistence identity (null when its row is missing: nothing was set) and the enclosing values, in WRITE_CONTEXT_SETTINGS order. */
export interface WriteContextResult { brainId: string | null; previous: string[] }

/**
 * `setWriteContext`: the text `withCoordinatedWrite` has always sent, byte for byte (#6007): the persistence identity,
 * the enclosing settings and the new settings in one round trip; nothing is set when the identity row is missing. The
 * OFFSET 0 subquery reads the enclosing values first. A nested scope keeps the outer actor; a declared trust tier nests
 * as min(outer, inner) (ranks compared in SQL); an undeclared one leaves the enclosing trust settings.
 *
 * Static text, so the engine-sql dynamic-SQL guard accepts its placeholders: the trust ranks are trustRankSql
 * (trust/tier.ts) and the enclosing reads follow WRITE_CONTEXT_SETTINGS; test/write-context-sql-text.test.ts pins both.
 */
export const SET_WRITE_CONTEXT_SQL = `SELECT b.brain_id,prev.*,
      CASE WHEN b.brain_id IS NOT NULL THEN concat(set_config('gbrain.write_sources',$1,true),set_config('gbrain.git_protocol','1',true),
        set_config('gbrain.write_request',CASE WHEN prev.s2<>'' THEN prev.s1 ELSE $2 END,true),
        set_config('gbrain.write_principal_kind',CASE WHEN prev.s2<>'' THEN prev.s2 ELSE $3 END,true),
        set_config('gbrain.write_principal_id',CASE WHEN prev.s2<>'' THEN prev.s3 ELSE $4 END,true),
        CASE WHEN $5::text<>'' THEN concat(
          set_config('gbrain.write_trust_tier',CASE WHEN (CASE prev.s4 WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END)>0 AND (CASE prev.s4 WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END)<(CASE $5::text WHEN 'user_confirmed' THEN 6 WHEN 'operator_curated' THEN 5 WHEN 'tool_observed' THEN 4 WHEN 'agent_written' THEN 3 WHEN 'unknown' THEN 2 WHEN 'external_untrusted' THEN 1 ELSE 0 END) THEN prev.s4 ELSE $5::text END,true),
          set_config('gbrain.write_origin',CASE WHEN $6::text<>'' THEN $6::text ELSE prev.s5 END,true)) END) END AS applied
    FROM (SELECT COALESCE(current_setting('gbrain.write_sources',true),'') AS s0,COALESCE(current_setting('gbrain.write_request',true),'') AS s1,COALESCE(current_setting('gbrain.write_principal_kind',true),'') AS s2,COALESCE(current_setting('gbrain.write_principal_id',true),'') AS s3,COALESCE(current_setting('gbrain.write_trust_tier',true),'') AS s4,COALESCE(current_setting('gbrain.write_origin',true),'') AS s5,COALESCE(current_setting('gbrain.git_protocol',true),'') AS s6 OFFSET 0) prev
    LEFT JOIN persistence_brain b ON b.singleton=1`;

/** Establishes the coordinated write context on the current transaction and returns what it replaced. */
export async function setWriteContext(exec: SqlExecutor, input: WriteContextInput): Promise<WriteContextResult> {
  const [row] = await exec.executeRaw<Record<string, string | null>>(SET_WRITE_CONTEXT_SQL,
    [JSON.stringify(input.sourceIds), input.requestId ?? '', input.principalKind, input.principalId, input.tier, input.origin]);
  return { brainId: row?.brain_id ?? null, previous: WRITE_CONTEXT_SETTINGS.map((_, index) => row?.[`s${index}`] ?? '') };
}

/** Sets each setting to the value at the same index, for the rest of the current transaction (`set_config(name, value, true)`), in one statement. */
export async function applyTransactionSettings(exec: SqlExecutor, names: readonly string[], values: readonly string[]): Promise<void> {
  assertSettingNames(names);
  if (names.length === 0) return;
  await exec.run(sqlFragment`SELECT set_config(t.name, t.value, true) FROM unnest(${[...names]}::text[], ${[...values]}::text[]) AS t(name, value)`);
}

/**
 * Starts the current transaction as one snapshot: `REPEATABLE READ`, and `READ ONLY` with `readOnly`. Runs on the
 * transaction engine as its first statement, so every later read sees the state as of that statement.
 */
export async function beginSnapshotRead(tx: Pick<BrainEngine, 'executeRaw'>, opts: { readOnly?: boolean } = {}): Promise<void> {
  await tx.executeRaw(opts.readOnly ? 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
}
