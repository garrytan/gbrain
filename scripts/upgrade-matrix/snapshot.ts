/**
 * Upgrade matrix (GBRA-224 W2): what must survive an upgrade, and what an
 * older binary must not change.
 *
 * A content snapshot holds the canonical fields of every page, fact and
 * source: slugs and source ids, the content hash, title, type, frontmatter,
 * provenance columns and deletion state. Timestamps, ids, vectors and derived
 * bookkeeping are left out, so a migration that adds columns or re-chunks
 * pages still compares equal. A catalog snapshot holds the schema objects
 * (columns, indexes, constraints, triggers, functions, views) and the schema
 * version, for the mixed-version probe.
 *
 * Only columns present on both sides are compared; a canonical column the
 * upgrade dropped is itself a difference.
 */

export interface TableSpec { table: string; key: string[]; columns: string[]; flags?: Record<string, string> }

/** Canonical fields per table. flags are NULL-ness tests reported as booleans (deletion and supersession state). */
export const CANONICAL: TableSpec[] = [
  {
    table: 'pages', key: ['source_id', 'slug'],
    columns: ['source_id', 'slug', 'type', 'page_kind', 'title', 'content_hash', 'frontmatter', 'source_kind', 'source_uri', 'ingested_via', 'source_path'],
    flags: { deleted: 'deleted_at' },
  },
  {
    table: 'facts', key: ['source_id', 'entity_slug', 'fact', 'row_num'],
    columns: ['source_id', 'entity_slug', 'fact', 'row_num', 'kind', 'visibility', 'notability', 'context', 'source', 'source_session', 'confidence', 'valid_from', 'valid_until',
      'source_markdown_slug', 'attributed_to', 'claim_metric', 'claim_value', 'claim_unit', 'claim_period'],
    flags: { expired: 'expired_at', superseded: 'superseded_by' },
  },
  { table: 'sources', key: ['id'], columns: ['id', 'name', 'archived'] },
];

export const CATALOG_QUERIES: Record<string, string> = {
  columns: "SELECT table_name || '.' || column_name AS k, data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS v FROM information_schema.columns WHERE table_schema = current_schema()",
  indexes: "SELECT indexname AS k, indexdef AS v FROM pg_indexes WHERE schemaname = current_schema()",
  constraints: "SELECT conrelid::regclass::text || '.' || conname AS k, pg_get_constraintdef(oid) AS v FROM pg_constraint WHERE connamespace = current_schema()::regnamespace",
  triggers: "SELECT tgrelid::regclass::text || '.' || tgname AS k, pg_get_triggerdef(oid) AS v FROM pg_trigger WHERE NOT tgisinternal",
  functions: "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k, md5(coalesce(p.prosrc, '')) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()",
  views: "SELECT table_name AS k, md5(coalesce(view_definition, '')) AS v FROM information_schema.views WHERE table_schema = current_schema()",
  schema_version: "SELECT key AS k, value AS v FROM config WHERE key = 'version'",
};

export interface Snapshot {
  content: Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;
  catalog?: Record<string, Record<string, string>>;
}

export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function canon(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /^[[{]/.test(v)) { try { return canon(JSON.parse(v)); } catch { return v; } }
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]));
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6;
  return v;
}

export async function takeSnapshot(query: Query, opts: { catalog: boolean }): Promise<Snapshot> {
  const content: Snapshot['content'] = {};
  for (const spec of CANONICAL) {
    const present = new Set((await query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [spec.table])).map(r => String(r.column_name)));
    if (present.size === 0) continue;
    const cols = spec.columns.filter(c => present.has(c));
    const flags = Object.entries(spec.flags ?? {}).filter(([, col]) => present.has(col));
    const select = [...cols.map(c => '"' + c + '"'), ...flags.map(([name, col]) => '("' + col + '" IS NOT NULL) AS "' + name + '"')].join(', ');
    const rows = (await query('SELECT ' + select + ' FROM "' + spec.table + '"')).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, canon(v)])));
    rows.sort((a, b) => rowKey(spec, a).localeCompare(rowKey(spec, b)));
    content[spec.table] = { columns: [...cols, ...flags.map(([name]) => name)], rows };
  }
  if (!opts.catalog) return { content };
  const catalog: Record<string, Record<string, string>> = {};
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
    catalog[name] = Object.fromEntries((await query(sql)).map(r => [String(r.k), String(r.v)]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { content, catalog };
}

function rowKey(spec: TableSpec, row: Record<string, unknown>): string {
  return JSON.stringify(spec.key.map(k => row[k] ?? null));
}

export interface Difference { kind: 'row_missing' | 'row_added' | 'field_changed' | 'column_dropped' | 'table_dropped' | 'catalog_changed'; where: string; detail: string }

/** Differences in canonical content between two snapshots (before and after). */
export function diffContent(before: Snapshot, after: Snapshot, opts: { allowAdded?: (table: string, row: Record<string, unknown>) => boolean } = {}): Difference[] {
  const out: Difference[] = [];
  for (const spec of CANONICAL) {
    const a = before.content[spec.table], b = after.content[spec.table];
    if (!a) continue;
    if (!b) { out.push({ kind: 'table_dropped', where: spec.table, detail: 'table missing after' }); continue; }
    for (const c of a.columns) if (!b.columns.includes(c)) out.push({ kind: 'column_dropped', where: spec.table + '.' + c, detail: 'canonical column missing after' });
    const shared = a.columns.filter(c => b.columns.includes(c));
    const index = (rows: Record<string, unknown>[]) => new Map(rows.map(r => [rowKey(spec, r), r]));
    const ai = index(a.rows), bi = index(b.rows);
    for (const [k, row] of ai) {
      const other = bi.get(k);
      if (!other) { out.push({ kind: 'row_missing', where: spec.table + ' ' + k, detail: 'row present before, missing after' }); continue; }
      for (const c of shared) {
        const x = JSON.stringify(row[c] ?? null), y = JSON.stringify(other[c] ?? null);
        if (x !== y) out.push({ kind: 'field_changed', where: spec.table + ' ' + k + ' ' + c, detail: x.slice(0, 160) + ' -> ' + y.slice(0, 160) });
      }
    }
    for (const [k, row] of bi) if (!ai.has(k) && !(opts.allowAdded?.(spec.table, row))) out.push({ kind: 'row_added', where: spec.table + ' ' + k, detail: 'row absent before, present after' });
  }
  return out;
}

export function diffCatalog(before: Snapshot, after: Snapshot): Difference[] {
  const out: Difference[] = [];
  const a = before.catalog ?? {}, b = after.catalog ?? {};
  for (const name of Object.keys(CATALOG_QUERIES)) {
    const x = a[name] ?? {}, y = b[name] ?? {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[k] !== y[k]) out.push({ kind: 'catalog_changed', where: name + ' ' + k, detail: (x[k] ?? '(absent)').slice(0, 160) + ' -> ' + (y[k] ?? '(absent)').slice(0, 160) });
    }
  }
  return out;
}
