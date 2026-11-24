/**
 * Frontmatter equality filter (#7159): `where: { key: value | [values] }` on
 * search, query and list_pages (CLI `--where key=value`, repeatable). Keys
 * AND; a key's values OR. A value matches a page whose top-level frontmatter
 * field equals it, or whose field is a list containing it. A string that reads
 * as a number or a boolean also matches that JSON value, since the CLI only
 * sends strings (`--where cycle=2024` matches `cycle: 2024`).
 *
 * SQL: one `p.frontmatter @> $n::text::jsonb` containment per accepted JSON form,
 * so the GIN index on pages.frontmatter (idx_pages_frontmatter, jsonb_ops)
 * serves every key; values are always bound parameters, never SQL text, and
 * keys travel inside the bound JSON. Keys are still held to a plain
 * identifier charset so a typo or an injection attempt fails loudly.
 * The filter only narrows rows: every visibility, source and private-page
 * predicate a caller already gets still applies.
 */
import { joinFragments, sqlFragment, type SqlFragment } from '../engine-sql/fragment.ts';

export type FrontmatterValue = string | number | boolean;
/** Normalized: every key maps to a non-empty value list. */
export type FrontmatterWhere = Record<string, FrontmatterValue[]>;

export const FRONTMATTER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_KEYS = 8;
const MAX_VALUES = 32;
const MAX_VALUE_CHARS = 256;
export const WHERE_EXAMPLE = { status: 'active' };

export class FrontmatterWhereError extends Error {}

/** Validate a caller's `where`; undefined when absent or empty. Throws FrontmatterWhereError on a bad key or value. */
export function parseFrontmatterWhere(raw: unknown): FrontmatterWhere | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrontmatterWhereError('`where` must be an object of frontmatter keys to a value or a list of values.');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_KEYS) throw new FrontmatterWhereError(`\`where\` takes at most ${MAX_KEYS} keys (got ${entries.length}).`);
  const out: FrontmatterWhere = {};
  for (const [key, value] of entries) {
    if (!FRONTMATTER_KEY_RE.test(key)) {
      throw new FrontmatterWhereError(`\`where\` key "${key.slice(0, 64)}" is not a frontmatter field name (letters, digits, _ and -, starting with a letter or _, at most 64 characters).`);
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.length > MAX_VALUES) {
      throw new FrontmatterWhereError(`\`where.${key}\` needs 1 to ${MAX_VALUES} values (got ${values.length}).`);
    }
    for (const v of values) {
      const scalar = typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
      if (!scalar || (typeof v === 'string' && v.length > MAX_VALUE_CHARS)) {
        throw new FrontmatterWhereError(`\`where.${key}\` values must be strings (at most ${MAX_VALUE_CHARS} characters), finite numbers or booleans.`);
      }
    }
    out[key] = [...new Set(values as FrontmatterValue[])];
  }
  return entries.length > 0 ? out : undefined;
}

/** The JSON documents one value matches by containment: itself, as a list member, and a numeric/boolean reading of a string. */
function containmentDocs(key: string, value: FrontmatterValue): string[] {
  const forms = new Set<FrontmatterValue>([value]);
  if (typeof value === 'string') {
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) forms.add(Number(value));
    if (value === 'true' || value === 'false') forms.add(value === 'true');
  }
  return [...forms].flatMap(v => [JSON.stringify({ [key]: v }), JSON.stringify({ [key]: [v] })]);
}

/** One `AND (...)` clause per key, values bound through `bind` (which returns the placeholder). */
export function frontmatterWhereClauses(alias: string, where: FrontmatterWhere | undefined, bind: (json: string) => string): string[] {
  if (!where) return [];
  return Object.entries(where).map(([key, values]) =>
    `AND (${values.flatMap(v => containmentDocs(key, v)).map(doc => `${alias}.frontmatter @> ${bind(doc)}::text::jsonb`).join(' OR ')})`);
}

/** The same clauses as one string with a leading space each ('' without a filter). */
export function frontmatterWhereSql(alias: string, where: FrontmatterWhere | undefined, bind: (json: string) => string): string {
  return frontmatterWhereClauses(alias, where, bind).map(c => ` ${c}`).join('');
}

/** The same predicate as a composable engine-sql fragment, each clause with a leading space ('' without a filter). */
export function frontmatterWhereFragment(where: FrontmatterWhere | undefined): SqlFragment {
  if (!where) return sqlFragment``;
  return joinFragments(Object.entries(where).map(([key, values]) =>
    sqlFragment` AND (${joinFragments(values.flatMap(v => containmentDocs(key, v)).map(doc => sqlFragment`p.frontmatter @> ${doc}::text::jsonb`), ' OR ')})`), '');
}

/**
 * The authoritative check on finished rows: arms that do not run through the
 * filtered SQL legs (exact lookup, relational, alias fan-out, facts) can add
 * pages, so a filtered search keeps only rows whose page matches. One
 * indexed read over the result's page ids (BrainEngine.filterPageIdsByFrontmatter);
 * a row with no page id is dropped.
 */
export async function keepFrontmatterMatches<T extends { page_id?: number | null }>(
  engine: { filterPageIdsByFrontmatter(ids: number[], where: FrontmatterWhere): Promise<number[]> },
  rows: T[],
  where: FrontmatterWhere | undefined,
): Promise<T[]> {
  if (!where || rows.length === 0) return rows;
  const ids = [...new Set(rows.flatMap(r => typeof r.page_id === 'number' && r.page_id > 0 ? [r.page_id] : []))];
  if (ids.length === 0) return [];
  const keep = new Set(await engine.filterPageIdsByFrontmatter(ids, where));
  return rows.filter(r => typeof r.page_id === 'number' && keep.has(r.page_id));
}
