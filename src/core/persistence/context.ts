import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import type { WriteAttribution } from './attribution.ts';
import { readPersistenceBrain } from './managed-mode.ts';
import { settleAtCommit } from '../page-state/transactions.ts';
import { isTrustTier, nestWriteTrust, type TrustTier, type WriteTrust } from '../trust/tier.ts';
import { WRITE_CONTEXT_SETTINGS } from '../engine-sql/transaction-settings.ts';
import type { TrustTable } from '../trust/schema.ts';

/** What the transaction-setting scopes need from the engine: typed reads and writes of `current_setting` / `set_config`. */
type SettingsEngine = Pick<BrainEngine, 'readTransactionSettings' | 'applyTransactionSettings'>;
interface PublicationContext { brainId: string; sourceIds: ReadonlySet<string>; active: boolean; }
const publication = new AsyncLocalStorage<PublicationContext>();
const ATTRIBUTION_SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'] as const;
/** The writer's trust declaration (trust/schema.ts reads them in the tier trigger). */
const TRUST_SETTINGS = ['gbrain.write_trust_tier', 'gbrain.write_origin'] as const;
const TRUST_PROMOTION_SETTING = 'gbrain.write_trust_promotion';
const TRUST_BACKFILL_SETTING = 'gbrain.write_trust_backfill';
const TRUST_KEEP_SETTING = 'gbrain.write_trust_keep';
/**
 * #8194: the fact ids an operator's `gbrain repair open-facts` opens in this transaction. Set only by withOpenFacts, which
 * only that repair's maintenance intent and its unmanaged label door call; never keyed on gbrain.write_trust_keep, which
 * agent fence edits also set.
 */
const OPEN_FACTS_SETTING = 'gbrain.write_open_facts';

/**
 * Sets transaction-local settings around `fn` in one round trip each way. An
 * aborted transaction cannot accept statements; its rollback clears SET LOCAL
 * automatically. A success restores the enclosing values.
 */
async function withTransactionSettings<T>(engine: SettingsEngine, names: readonly string[],
  next: (previous: string[]) => string[], fn: () => Promise<T>): Promise<T> {
  const previous = (await engine.readTransactionSettings(names)).map(value => value ?? '');
  await applySettings(engine, names, next(previous));
  let failed = false;
  try { return await fn(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await applySettings(engine, names, previous); }
    catch (error) { if (!failed) throw error; }
  }
}
function applySettings(engine: SettingsEngine, names: readonly string[], values: string[]) {
  return engine.applyTransactionSettings(names, values);
}
/** A nested scope keeps the outer actor: a request publication that calls a derived writer stays attributed to the request. */
const attributionValues = (outer: string[], attribution: WriteAttribution) => outer[1]
  ? outer : [attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id];
/** The enclosing trust declaration read back from its two settings; null when none is set. */
function storedWriteTrust(tier: string, origin: string): WriteTrust | null {
  if (!isTrustTier(tier)) return null;
  try { return { tier, origin: origin ? JSON.parse(origin) as WriteTrust['origin'] : null }; } catch { return { tier, origin: null }; }
}
const trustValues = (trust: WriteTrust | null): string[] => trust ? [trust.tier, trust.origin ? JSON.stringify(trust.origin) : ''] : ['', ''];
/** Unlike the actor, a nested trust declaration combines as min(outer, inner): a nested derived write can lower, never raise. */
const nestedTrustValues = (outer: string[], trust: WriteTrust | undefined) =>
  trust ? trustValues(nestWriteTrust(storedWriteTrust(outer[0] ?? '', outer[1] ?? ''), trust)) : outer;

/**
 * Only the coordinator and guarded projection workers establish this execution
 * capability. `attribution` names the actor the database stamps on every
 * content row and page revision written inside (persistence/attribution-schema.ts).
 */
export async function withCoordinatedWrite<T>(engine: BrainEngine, sourceIds: string[], fn: () => Promise<T>, attribution: WriteAttribution): Promise<T> {
  // #6007: identity, enclosing settings and new settings in one round trip (engine-sql/transaction-settings.ts).
  const names = WRITE_CONTEXT_SETTINGS;
  const [tier, origin] = trustValues(attribution.trust ?? null);
  const brain = await engine.setWriteContext({ sourceIds, requestId: attribution.requestId ?? null,
    principalKind: attribution.principal.kind, principalId: attribution.principal.id, tier, origin });
  if (!brain.brainId) {
    throw opError('writer_not_initialized', 'Persistence identity is missing.',
      'This brain has no persistence identity row, so coordinated writes cannot run and nothing was written. List the pending migrations that create it and ask the user to approve applying them.',
      { fix: { argv: ['gbrain', 'apply-migrations', '--dry-run', '--json'], consent: [], actor: 'agent', why: 'Lists the pending migrations without applying them.', requires_exclusive: false } });
  }
  const context: PublicationContext = { brainId: brain.brainId, sourceIds: new Set(sourceIds), active: true };
  const previous = brain.previous;
  let failed = false;
  try {
    return await publication.run(context, async () => {
      try { return await fn(); }
      finally { context.active = false; }
    });
  } catch (error) { failed = true; throw error; }
  finally {
    // GBRA-133: after a success on Postgres the restore shares the transaction's COMMIT round trip (settleAtCommit).
    try { await (failed ? applySettings(engine, names, previous) : settleAtCommit(engine, applySettings(engine, names, previous))); }
    catch (error) { if (!failed) throw error; }
  }
}
/** True inside a coordinated write (the coordinator publishing): a writer here must not submit and wait on its own coordinator. */
export function insideCoordinatedWrite(): boolean {
  return publication.getStore()?.active === true;
}
/**
 * #5984 bulk: inside one coordinated write that publishes several requests,
 * names the next request as the actor of the rows it writes. One statement; the
 * enclosing coordinated write restores the outer values when it ends.
 */
export async function setMemberAttribution(engine: Pick<BrainEngine, 'applyTransactionSettings'>, attribution: WriteAttribution): Promise<void> {
  // The member's trust declaration replaces the previous member's (an undeclared member resets to none: `unknown`). The typed settings member sets them in one statement.
  await engine.applyTransactionSettings([...ATTRIBUTION_SETTINGS, ...TRUST_SETTINGS],
    [attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id, ...trustValues(attribution.trust ?? null)]);
}
/** Attribution without coordinator capability, for unmanaged legacy transactions. */
export function withWriteAttribution<T>(engine: SettingsEngine, attribution: WriteAttribution, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [...ATTRIBUTION_SETTINGS, ...TRUST_SETTINGS],
    outer => [...attributionValues(outer.slice(0, 3), attribution), ...nestedTrustValues(outer.slice(3), attribution.trust)], fn);
}
/**
 * Declares the tier and origin of the rows written inside `fn`, within an
 * enclosing transaction (a coordinated write, an attributed maintenance
 * transaction, or a plain one). Nested declarations combine as min(outer,
 * inner). Compute the declaration once with trust/tier.ts `effectiveWriteTrust`.
 */
export function withWriteTrust<T>(engine: SettingsEngine, trust: WriteTrust, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, TRUST_SETTINGS, outer => nestedTrustValues(outer, trust), fn);
}
/** The trust declaration in force on this transaction, or null (rows would be stamped `unknown`). */
export async function currentWriteTrust(engine: Pick<BrainEngine, 'readCurrentWriteTrust'>): Promise<WriteTrust | null> {
  const row = await engine.readCurrentWriteTrust();
  return storedWriteTrust(row.tier ?? '', row.origin ?? '');
}
/**
 * The owner-confirmation capability (CEO-9): inside `fn`, an UPDATE may raise
 * a row's trust_tier up to `ceiling`. Callers establish the confirmation first
 * (trust/confirm.ts); the trigger is a backstop against bugs, not a boundary.
 */
export function withTrustPromotion<T>(engine: SettingsEngine, ceiling: TrustTier, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [TRUST_PROMOTION_SETTING], () => [ceiling], fn);
}
/**
 * ENG-1: inside `fn`, a content rewrite of a row in `tables` keeps its stored
 * tier (it can still lower, never raise). For gbrain-managed fence edits that
 * rewrite a page body without authoring it (a remember or takes fence append,
 * a forget or accept strike); the fence row itself carries the writer's tier.
 */
export function withTrustKeep<T>(engine: SettingsEngine, tables: readonly TrustTable[], fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [TRUST_KEEP_SETTING], outer => [[...new Set([...(outer[0] ? outer[0].split(',') : []), ...tables])].join(',')], fn);
}
/**
 * #8194: inside `fn`, the fence projection treats each of `factIds` whose incoming fence cell differs only private to world
 * (same row number, same claim) as opened in place: fence-guard moves it with its new visibility keeping its id and tier,
 * and the fact generation and the projection's expiry do not retire it (openedFactRowSql). Only `gbrain repair open-facts`
 * calls it.
 */
export function withOpenFacts<T>(engine: SettingsEngine, factIds: readonly number[], fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [OPEN_FACTS_SETTING], () => [factIds.map(id => String(Number(id))).join(',')], fn);
}
/**
 * #8194: SQL true for a stored fact row `f` that withOpenFacts names and whose cell in `incoming` (the projection's
 * jsonb_to_recordset text of row_num, fact, visibility) is the same row number and claim at world while the row is private.
 * False wherever the setting is unset, so every other write keeps today's behaviour.
 */
export function openedFactRowSql(f: string, incoming: string): string {
  return `(${f}.visibility = 'private' AND ${f}.id::text = ANY(string_to_array(COALESCE(current_setting('${OPEN_FACTS_SETTING}', true), ''), ','))
    AND EXISTS (SELECT 1 FROM jsonb_to_recordset(${incoming}::text::jsonb) AS o(row_num integer, fact text, visibility text)
      WHERE o.row_num = ${f}.row_num AND o.fact = ${f}.fact AND o.visibility = 'world'))`;
}
/** CEO-10: the deterministic backfill may move rows from `unknown` to any tier below user_confirmed. */
export function withTrustBackfill<T>(engine: SettingsEngine, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [TRUST_BACKFILL_SETTING], () => ['on'], fn);
}
export async function assertCoordinatedWrite(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const brain = await readPersistenceBrain(engine);
  if (!brain.enabled) return;
  const held = publication.getStore();
  if (!held?.active || held.brainId !== brain.brain_id || !held.sourceIds.has(sourceId)) {
    throw new OperationError('writer_coordinator_required', 'This writer must enter the canonical persistence coordinator.',
      'Use supported page operations, or drain managed writers before running this maintenance command.');
  }
}
