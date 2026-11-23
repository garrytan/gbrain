/**
 * Owner-only sources (`owner_only`). A source whose `sources.config` carries `owner_only: true`, and every source of a
 * kind that is always owner-only (`imessage`: other people's messages on the owner's Mac), is read only by the trusted
 * local CLI and by a credential bound to the brain owner speaking for itself (CallerAccess.owner). Every other remote
 * caller (another member, a guest, a shared-room audience, an attested call, an unbound or public credential) gets
 * exactly what a page that does not exist gets, whatever the operator relaxed: `--private-pages granted-sources`, the
 * `search.remote_private_pages` hatch, `access.members_read_lineage` and the owner opt-in widen nothing here.
 *
 * The rule follows lineage at read time, so it needs no backfill and works the same on a repo-less brain: a page or
 * fact in an owner-only source, a synthesized concept or question with an input page there, and any page or fact whose
 * recorded derivation inputs (`derivation_inputs`, followed transitively) reach a page, fact, take or timeline row
 * there. Atoms, Life Chronicle events and `derived_from` pages resolve their origin in their own source, so the source
 * test covers them. The test is the v320 function gbrain_owner_only_lineage(table, id), behind its zero-argument form
 * (may the brain hold an owner-only row at all?), so a brain without one never calls it. GST-3032 (v322): when an origin
 * goes (its source removed, or the row hard-deleted), a delete trigger marks every row derived from it in
 * owner_only_marks first, and both forms read the marks, so a derived row stays owner-only after its origin is gone and
 * the guard stays on after the last owner-only source is removed. Nothing derived is deleted.
 */
import type { BrainEngine } from '../engine.ts';
import { schemaVersionSeen } from '../migrate-pending.ts';

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

/** Does the engine's schema carry the lineage function (v320)? Unknown counts as yes; below it only the source test answers. */
export function ownerOnlyLineageReadable(engine: object): boolean {
  const version = schemaVersionSeen(engine);
  return !(version !== undefined && version < OWNER_ONLY_LINEAGE_SINCE);
}

/** The SQL test behind ownerOnlySourcesPresent, for a statement that folds it into other work. */
export function ownerOnlyPresentSql(engine: object): string {
  const version = schemaVersionSeen(engine);
  return version !== undefined && version < OWNER_ONLY_LINEAGE_SINCE ? ANY_OWNER_ONLY_SQL : `${OWNER_ONLY_LINEAGE_FN}()`;
}

/**
 * May the brain hold an owner-only row: an owner-only source, or a row derived from a removed one (v322's marks)? Read
 * through gbrain_owner_only_lineage() unless the engine recorded a schema below v320, where the source test alone
 * answers (no marks exist there). An unreadable answer counts as yes (fail closed).
 */
export async function ownerOnlySourcesPresent(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
  try {
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT ${ownerOnlyPresentSql(engine)} AS present`);
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

/** The lineage test of an owner-only row: the v320 function, called with no arguments (no input). */
export const OWNER_ONLY_LINEAGE_PRESENT_SQL = `${OWNER_ONLY_LINEAGE_FN}()`;
/** The schema version (migration v320) that creates it; a literal so a read never loads a migration module. */
export const OWNER_ONLY_LINEAGE_SINCE = 320;
/** The read-time function (schema migration v328) that answers once per statement how this login reads owner-only lineage. */
export const OWNER_ONLY_READ_MODE_FN = 'gbrain_owner_only_read_mode';
/** The schema version (migration v328) that creates it and the three-argument lineage function. */
export const OWNER_ONLY_READ_MODE_SINCE = 328;
/** The comment on owner_only_marks (v322) that records, once and for good, that the brain has held owner-only data. */
export const OWNER_ONLY_HELD = 'gbrain:owner_only_held (GST-3032): this brain has held owner-only data, so owner-only lineage stays guarded';

/**
 * The closed test: the brain holds an owner-only source, or has held owner-only data (the v322 flag, a catalog read that
 * no grant hides and that is false on a brain without owner_only_marks). Every row then counts as owner-only.
 */
const CLOSED_SQL = `(${ANY_OWNER_ONLY_SQL} OR EXISTS (SELECT 1 FROM pg_catalog.pg_description held
  WHERE held.objoid = pg_catalog.to_regclass('public.owner_only_marks') AND held.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND held.objsubid = 0 AND held.description = '${OWNER_ONLY_HELD}'))`;

/**
 * Which form of the owner-only test a read emits, by its schema version. `mode` at or above OWNER_ONLY_READ_MODE_SINCE: the
 * v328 function, given the login's read mode once per statement as an InitPlan. `fn` from OWNER_ONLY_LINEAGE_SINCE: the
 * two-argument function. Both sit behind the guard, one Result node that keeps the test from running on a brain that never
 * held owner-only data. `closed` below v320 or when the version is unknown: the functions may not exist, so on a brain
 * that holds an owner-only source or has held owner-only data every row counts as owner-only (fail closed); a brain
 * without either pays one InitPlan.
 */
export type OwnerOnlyForm = 'mode' | 'fn' | 'closed';

export function ownerOnlyForm(schemaVersion: number | undefined): OwnerOnlyForm {
  if (schemaVersion === undefined || schemaVersion < OWNER_ONLY_LINEAGE_SINCE) return 'closed';
  return schemaVersion >= OWNER_ONLY_READ_MODE_SINCE ? 'mode' : 'fn';
}

/** The `table` row `alias` is owner-only by its own lineage. `alias` is a code-provided literal. */
function ownerOnlyRowSql(table: 'pages' | 'facts' | 'takes' | 'timeline_entries', alias: string, form: OwnerOnlyForm): string {
  if (form === 'closed') return CLOSED_SQL;
  const mode = form === 'mode' ? `, (SELECT ${OWNER_ONLY_READ_MODE_FN}())` : '';
  return `((SELECT ${OWNER_ONLY_LINEAGE_FN}()) AND ${OWNER_ONLY_LINEAGE_FN}('${table}', ${alias}.id${mode}))`;
}

/**
 * The page row `alias` is owner-only: held in an owner-only source, a synthesized concept or question with an input page
 * there, or derived (by its recorded inputs, transitively) from a row there.
 */
export function ownerOnlyPageSql(alias: string, form: OwnerOnlyForm): string {
  return ownerOnlyRowSql('pages', alias, form);
}

/** The fact row `alias` is owner-only: held in an owner-only source, or derived (by its recorded inputs) from a row there. */
export function ownerOnlyFactSql(alias: string, form: OwnerOnlyForm): string {
  return ownerOnlyRowSql('facts', alias, form);
}

/** The take row `alias` is owner-only by its own recorded inputs; its page is tested apart, by ownerOnlyPageSql. */
export function ownerOnlyTakeSql(alias: string, form: OwnerOnlyForm): string {
  return ownerOnlyRowSql('takes', alias, form);
}

/** The timeline row `alias` is owner-only by its own recorded inputs (a meeting's row on an attendee page); its page apart. */
export function ownerOnlyTimelineSql(alias: string, form: OwnerOnlyForm): string {
  return ownerOnlyRowSql('timeline_entries', alias, form);
}
