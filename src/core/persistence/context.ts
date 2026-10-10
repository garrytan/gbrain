import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import type { WriteAttribution } from './attribution.ts';
import { isTrustTier, nestWriteTrust, trustRankSql, type TrustTier, type WriteTrust } from '../trust/tier.ts';
import type { TrustTable } from '../trust/schema.ts';

interface PublicationContext { brainId: string; sourceIds: ReadonlySet<string>; active: boolean; }
const publication = new AsyncLocalStorage<PublicationContext>();
const ATTRIBUTION_SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'] as const;
/** The writer's trust declaration (trust/schema.ts reads them in the tier trigger). */
const TRUST_SETTINGS = ['gbrain.write_trust_tier', 'gbrain.write_origin'] as const;
const TRUST_PROMOTION_SETTING = 'gbrain.write_trust_promotion';
const TRUST_BACKFILL_SETTING = 'gbrain.write_trust_backfill';
const TRUST_KEEP_SETTING = 'gbrain.write_trust_keep';

/**
 * Sets transaction-local settings around `fn` in one round trip each way. An
 * aborted transaction cannot accept statements; its rollback clears SET LOCAL
 * automatically. A success restores the enclosing values.
 */
async function withTransactionSettings<T>(engine: Pick<BrainEngine, 'executeRaw'>, names: readonly string[],
  next: (previous: string[]) => string[], fn: () => Promise<T>): Promise<T> {
  const [row] = await engine.executeRaw<Record<string, string | null>>(
    `SELECT ${names.map((name, index) => `current_setting('${name}',true) AS s${index}`).join(',')}`);
  const previous = names.map((_, index) => row?.[`s${index}`] ?? '');
  await applySettings(engine, names, next(previous));
  let failed = false;
  try { return await fn(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await applySettings(engine, names, previous); }
    catch (error) { if (!failed) throw error; }
  }
}
function applySettings(engine: Pick<BrainEngine, 'executeRaw'>, names: readonly string[], values: string[]) {
  return engine.executeRaw(`SELECT ${names.map((name, index) => `set_config('${name}',$${index + 1},true)`).join(',')}`, values);
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
  // #6007: the persistence identity, the enclosing settings and the new settings in one round trip;
  // nothing is set when the identity row is missing. The OFFSET 0 subquery reads the enclosing values first.
  // A declared trust tier nests as min(outer, inner) (ranks compared in SQL); an undeclared one leaves the enclosing settings.
  const names = ['gbrain.write_sources', ...ATTRIBUTION_SETTINGS, ...TRUST_SETTINGS];
  const [tier, origin] = trustValues(attribution.trust ?? null);
  const [brain] = await engine.executeRaw<Record<string, string | null>>(`SELECT b.brain_id,prev.*,
      CASE WHEN b.brain_id IS NOT NULL THEN concat(set_config('gbrain.write_sources',$1,true),
        set_config('gbrain.write_request',CASE WHEN prev.s2<>'' THEN prev.s1 ELSE $2 END,true),
        set_config('gbrain.write_principal_kind',CASE WHEN prev.s2<>'' THEN prev.s2 ELSE $3 END,true),
        set_config('gbrain.write_principal_id',CASE WHEN prev.s2<>'' THEN prev.s3 ELSE $4 END,true),
        CASE WHEN $5::text<>'' THEN concat(
          set_config('gbrain.write_trust_tier',CASE WHEN ${trustRankSql('prev.s4')}>0 AND ${trustRankSql('prev.s4')}<${trustRankSql('$5::text')} THEN prev.s4 ELSE $5::text END,true),
          set_config('gbrain.write_origin',CASE WHEN $6::text<>'' THEN $6::text ELSE prev.s5 END,true)) END) END AS applied
    FROM (SELECT ${names.map((name, index) => `COALESCE(current_setting('${name}',true),'') AS s${index}`).join(',')} OFFSET 0) prev
    LEFT JOIN persistence_brain b ON b.singleton=1`,
  [JSON.stringify(sourceIds), attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id, tier, origin]);
  if (!brain?.brain_id) {
    throw opError('writer_not_initialized', 'Persistence identity is missing.',
      'This brain has no persistence identity row, so coordinated writes cannot run and nothing was written. List the pending migrations that create it and ask the user to approve applying them.',
      { fix: { argv: ['gbrain', 'apply-migrations', '--dry-run', '--json'], consent: [], actor: 'agent', why: 'Lists the pending migrations without applying them.', requires_exclusive: false } });
  }
  const context: PublicationContext = { brainId: brain.brain_id, sourceIds: new Set(sourceIds), active: true };
  const previous = names.map((_, index) => brain[`s${index}`] ?? '');
  let failed = false;
  try {
    return await publication.run(context, async () => {
      try { return await fn(); }
      finally { context.active = false; }
    });
  } catch (error) { failed = true; throw error; }
  finally {
    try { await applySettings(engine, names, previous); }
    catch (error) { if (!failed) throw error; }
  }
}
/**
 * #5984 bulk: inside one coordinated write that publishes several requests,
 * names the next request as the actor of the rows it writes. One statement; the
 * enclosing coordinated write restores the outer values when it ends.
 */
export async function setMemberAttribution(engine: Pick<BrainEngine, 'executeRaw'>, attribution: WriteAttribution): Promise<void> {
  // The member's trust declaration replaces the previous member's (an undeclared member resets to none: `unknown`).
  await engine.executeRaw(`SELECT ${[...ATTRIBUTION_SETTINGS, ...TRUST_SETTINGS].map((name, index) => `set_config('${name}',$${index + 1},true)`).join(',')}`,
    [attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id, ...trustValues(attribution.trust ?? null)]);
}
/** Attribution without coordinator capability, for unmanaged legacy transactions. */
export function withWriteAttribution<T>(engine: Pick<BrainEngine, 'executeRaw'>, attribution: WriteAttribution, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [...ATTRIBUTION_SETTINGS, ...TRUST_SETTINGS],
    outer => [...attributionValues(outer.slice(0, 3), attribution), ...nestedTrustValues(outer.slice(3), attribution.trust)], fn);
}
/**
 * Declares the tier and origin of the rows written inside `fn`, within an
 * enclosing transaction (a coordinated write, an attributed maintenance
 * transaction, or a plain one). Nested declarations combine as min(outer,
 * inner). Compute the declaration once with trust/tier.ts `effectiveWriteTrust`.
 */
export function withWriteTrust<T>(engine: Pick<BrainEngine, 'executeRaw'>, trust: WriteTrust, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, TRUST_SETTINGS, outer => nestedTrustValues(outer, trust), fn);
}
/** The trust declaration in force on this transaction, or null (rows would be stamped `unknown`). */
export async function currentWriteTrust(engine: Pick<BrainEngine, 'executeRaw'>): Promise<WriteTrust | null> {
  const [row] = await engine.executeRaw<{ tier: string | null; origin: string | null }>(
    `SELECT current_setting('gbrain.write_trust_tier',true) AS tier, current_setting('gbrain.write_origin',true) AS origin`);
  return storedWriteTrust(row?.tier ?? '', row?.origin ?? '');
}
/**
 * The owner-confirmation capability (CEO-9): inside `fn`, an UPDATE may raise
 * a row's trust_tier up to `ceiling`. Callers establish the confirmation first
 * (trust/confirm.ts); the trigger is a backstop against bugs, not a boundary.
 */
export function withTrustPromotion<T>(engine: Pick<BrainEngine, 'executeRaw'>, ceiling: TrustTier, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [TRUST_PROMOTION_SETTING], () => [ceiling], fn);
}
/**
 * ENG-1: inside `fn`, a content rewrite of a row in `tables` keeps its stored
 * tier (it can still lower, never raise). For gbrain-managed fence edits that
 * rewrite a page body without authoring it (a remember or takes fence append,
 * a forget or accept strike); the fence row itself carries the writer's tier.
 */
export function withTrustKeep<T>(engine: Pick<BrainEngine, 'executeRaw'>, tables: readonly TrustTable[], fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [TRUST_KEEP_SETTING], outer => [[...new Set([...(outer[0] ? outer[0].split(',') : []), ...tables])].join(',')], fn);
}
/** CEO-10: the deterministic backfill may move rows from `unknown` to any tier below user_confirmed. */
export function withTrustBackfill<T>(engine: Pick<BrainEngine, 'executeRaw'>, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, [TRUST_BACKFILL_SETTING], () => ['on'], fn);
}
export async function assertCoordinatedWrite(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return;
  const held = publication.getStore();
  if (!held?.active || held.brainId !== brain.brain_id || !held.sourceIds.has(sourceId)) {
    throw new OperationError('writer_coordinator_required', 'This writer must enter the canonical persistence coordinator.',
      'Use supported page operations, or drain managed writers before running this maintenance command.');
  }
}
