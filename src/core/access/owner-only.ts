/**
 * Owner-only sources (`owner_only`). A source whose `sources.config` carries `owner_only: true`, and every source of a
 * kind that is always owner-only (`imessage`: other people's messages on the owner's Mac), is read only by the trusted
 * local CLI and by a credential bound to the brain owner speaking for itself (CallerAccess.owner). Every other remote
 * caller (another member, a guest, a shared-room audience, an attested call, an unbound or public credential) gets
 * exactly what a page that does not exist gets, whatever the operator relaxed: `--private-pages granted-sources`, the
 * `search.remote_private_pages` hatch, `access.members_read_lineage` and the owner opt-in widen nothing here.
 *
 * The rule follows lineage at read time and stores nothing per page, so it needs no migration and works the same on a
 * repo-less brain: a page or fact in an owner-only source, a synthesized concept or question with an input page there,
 * and any page or fact whose recorded derivation inputs (`derivation_inputs`, followed transitively) reach a page,
 * fact, take or timeline row there. Atoms, Life Chronicle events and `derived_from` pages resolve their origin in their
 * own source, so the source test covers them. Every fragment leads with one uncorrelated test of whether the brain has
 * an owner-only source at all, so a brain without one pays a single InitPlan per statement.
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

/** The ids of every owner-only source, as a subquery. */
export const OWNER_ONLY_SOURCE_IDS_SQL = `(SELECT oo_src.id FROM sources oo_src WHERE ${ownerOnlySourceRowSql('oo_src')})`;
const ANY_OWNER_ONLY_SQL = `EXISTS (SELECT 1 FROM sources oo_any WHERE ${ownerOnlySourceRowSql('oo_any')})`;

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

/** A text row id as the integer it names, or NULL (an input recorded by slug never matches a row id). */
const rowId = (text: string) => `(CASE WHEN ${text} ~ '^[0-9]{1,18}$' THEN (${text})::bigint END)`;

/** A derivation input `(table, id)` is a row held in an owner-only source. */
function inputInOwnerOnlySql(table: string, id: string): string {
  return `((${table} = 'pages' AND EXISTS (SELECT 1 FROM pages oo_ip WHERE oo_ip.id = ${rowId(id)} AND oo_ip.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL}))
    OR (${table} = 'facts' AND EXISTS (SELECT 1 FROM facts oo_if WHERE oo_if.id = ${rowId(id)} AND oo_if.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL}))
    OR (${table} = 'takes' AND EXISTS (SELECT 1 FROM takes oo_it JOIN pages oo_itp ON oo_itp.id = oo_it.page_id WHERE oo_it.id = ${rowId(id)} AND oo_itp.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL}))
    OR (${table} = 'timeline_entries' AND EXISTS (SELECT 1 FROM timeline_entries oo_ie JOIN pages oo_iep ON oo_iep.id = oo_ie.page_id WHERE oo_ie.id = ${rowId(id)} AND oo_iep.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL})))`;
}

/** Derivation hops followed from a derived row back to its inputs. */
export const OWNER_ONLY_LINEAGE_DEPTH = 8;

/** The derived row `(derivedTable, alias.id)` has a recorded input, at any depth up to the bound, held in an owner-only source. */
function derivationReachesOwnerOnlySql(derivedTable: string, alias: string): string {
  return `EXISTS (WITH RECURSIVE oo_up(t, id, depth) AS (
      SELECT d.input_table, d.input_id, 1 FROM derivation_inputs d WHERE d.derived_table = '${derivedTable}' AND d.derived_id = (${alias}.id)::text
      UNION SELECT d.input_table, d.input_id, oo_up.depth + 1 FROM derivation_inputs d JOIN oo_up ON d.derived_table = oo_up.t AND d.derived_id = oo_up.id
        WHERE oo_up.depth < ${OWNER_ONLY_LINEAGE_DEPTH})
    SELECT 1 FROM oo_up WHERE ${inputInOwnerOnlySql('oo_up.t', 'oo_up.id')})`;
}

/**
 * The page row `alias` is owner-only: held in an owner-only source, a synthesized concept or question with an input page
 * there, or derived (by its recorded inputs) from a row there. `alias` is a code-provided literal.
 */
export function ownerOnlyPageSql(alias: string): string {
  return `(${ANY_OWNER_ONLY_SQL} AND (${alias}.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL}
    OR (${alias}.type IN ('concept', 'question') AND EXISTS (SELECT 1 FROM links oo_l JOIN pages oo_lp ON oo_lp.id = oo_l.to_page_id
      WHERE oo_l.from_page_id = ${alias}.id AND oo_l.link_source = 'concept-provenance' AND oo_l.link_type = 'synthesized_from'
        AND oo_lp.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL}))
    OR ${derivationReachesOwnerOnlySql('pages', alias)}))`;
}

/** The fact row `alias` is owner-only: held in an owner-only source, or derived (by its recorded inputs) from a row there. */
export function ownerOnlyFactSql(alias: string): string {
  return `(${ANY_OWNER_ONLY_SQL} AND (${alias}.source_id IN ${OWNER_ONLY_SOURCE_IDS_SQL} OR ${derivationReachesOwnerOnlySql('facts', alias)}))`;
}
