/**
 * Owner-only sources (`owner_only`). A source whose `sources.config` carries `owner_only: true`, and every source of a
 * kind that is always owner-only (`imessage`: other people's messages on the owner's Mac), is read only by the trusted
 * local CLI and by a credential bound to the brain owner speaking for itself (CallerAccess.owner). Every other remote
 * caller (another member, a guest, a shared-room audience, an attested call, an unbound or public credential) gets
 * exactly what a page that does not exist gets, whatever the operator relaxed: `--private-pages granted-sources`, the
 * `search.remote_private_pages` hatch, `access.members_read_lineage` and the owner opt-in widen nothing here.
 *
 * The rule follows lineage at read time and stores nothing per page, so it needs no backfill and works the same on a
 * repo-less brain: a page or fact in an owner-only source, a synthesized concept or question with an input page there,
 * and any page or fact whose recorded derivation inputs (`derivation_inputs`, followed transitively) reach a page,
 * fact, take or timeline row there. Atoms, Life Chronicle events and `derived_from` pages resolve their origin in their
 * own source, so the source test covers them. The test is the v320 function gbrain_owner_only_lineage(table, id), behind
 * its zero-argument form (does the brain hold an owner-only source at all?), so a brain without one never calls it.
 */
import type { BrainEngine } from '../engine.ts';

/** The `sources.config` flag that makes a source owner-only. */
export const OWNER_ONLY_FLAG = 'owner_only';
/** Source kinds that are owner-only whatever their flag says. */
export const OWNER_ONLY_KINDS: readonly string[] = ['imessage'];

/** A `sources` row alias is owner-only (the SQL twin of isOwnerOnlySourceConfig). */
function ownerOnlySourceRowSql(alias: string): string {
  return `(${alias}.config->>'kind' IN (${OWNER_ONLY_KINDS.map(kind => `'${kind}'`).join(',')}) OR ${alias}.config->>'${OWNER_ONLY_FLAG}' = 'true')`;
}

/**
 * Does the brain hold an owner-only source? Uncorrelated, so a statement evaluates it once. Like search's other live read
 * checks (search/read-policy-sql.ts, guests/marker.ts) it reads sources as `read_source`: a read check, not a listing.
 * `id >= ''` holds for every row; it gives the planner the primary key as a path (a NOT NULL test would be folded away),
 * so a plan that prices out sequential scans still reads sources by index.
 */
export const ANY_OWNER_ONLY_SQL = `EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id >= '' AND ${ownerOnlySourceRowSql('read_source')})`;

/** The source whose id is the SQL expression `sourceId` is owner-only (the SQL twin of sourceIsOwnerOnly). */
export function ownerOnlySourceSql(sourceId: string): string {
  return `EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = ${sourceId} AND ${ownerOnlySourceRowSql('read_source')})`;
}

/** A parsed `sources.config` is owner-only. */
export function isOwnerOnlySourceConfig(config: unknown): boolean {
  const value = typeof config === 'string' ? safeParse(config) : config;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return OWNER_ONLY_KINDS.includes(String(record.kind)) || record[OWNER_ONLY_FLAG] === true || record[OWNER_ONLY_FLAG] === 'true';
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** Does the brain hold an owner-only source? An unreadable answer counts as yes (fail closed). */
export async function ownerOnlySourcesPresent(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
  try {
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT ${ANY_OWNER_ONLY_SQL} AS present`);
    return row?.present !== false;
  } catch {
    return true;
  }
}

/** Is this source owner-only? An unreadable answer counts as yes (fail closed). */
export async function sourceIsOwnerOnly(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  try {
    const rows = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [sourceId]);
    return rows.length > 0 && isOwnerOnlySourceConfig(rows[0]!.config);
  } catch {
    return true;
  }
}

/** The read-time function (schema migration v320) that answers whether a page or fact row is owner-only. */
export const OWNER_ONLY_LINEAGE_FN = 'gbrain_owner_only_lineage';
/** The schema version (migration v320) that creates it; a literal so a read never loads a migration module. */
export const OWNER_ONLY_LINEAGE_SINCE = 320;

/**
 * Which form of the owner-only test a read emits, by its schema version. `fn` at or above OWNER_ONLY_LINEAGE_SINCE: the
 * v320 functions, so the planner sees the guard as one Result node and the test as one call that the guard keeps from
 * running on a brain with no owner-only source. `closed` below it or when the version is unknown: the functions may not
 * exist, so on a brain that holds an owner-only source every row counts as owner-only (fail closed); a brain without one
 * pays one InitPlan. Remote reads carry the version in their request record, so they take the `fn` form.
 */
export type OwnerOnlyForm = 'fn' | 'closed';

export function ownerOnlyForm(schemaVersion: number | undefined): OwnerOnlyForm {
  return schemaVersion !== undefined && schemaVersion >= OWNER_ONLY_LINEAGE_SINCE ? 'fn' : 'closed';
}

/**
 * The page row `alias` is owner-only: held in an owner-only source, a synthesized concept or question with an input page
 * there, or derived (by its recorded inputs, up to 8 hops) from a row there. `alias` is a code-provided literal.
 */
export function ownerOnlyPageSql(alias: string, form: OwnerOnlyForm): string {
  return form === 'fn' ? `((SELECT ${OWNER_ONLY_LINEAGE_FN}()) AND ${OWNER_ONLY_LINEAGE_FN}('pages', ${alias}.id))` : ANY_OWNER_ONLY_SQL;
}

/** The fact row `alias` is owner-only: held in an owner-only source, or derived (by its recorded inputs) from a row there. */
export function ownerOnlyFactSql(alias: string, form: OwnerOnlyForm): string {
  return form === 'fn' ? `((SELECT ${OWNER_ONLY_LINEAGE_FN}()) AND ${OWNER_ONLY_LINEAGE_FN}('facts', ${alias}.id))` : ANY_OWNER_ONLY_SQL;
}
