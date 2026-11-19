/**
 * The statements a fact purge's plan, dry run and `--match` read (facts/purge.ts planFactPurge and matchCandidates,
 * facts/purge-verify.ts, persistence/intent-redaction.ts, facts/derivation-inputs.ts). Each is the text its caller ran
 * through `executeRaw`, byte for byte, built once at module load so the engine-sql functions
 * (src/core/engine-sql/facts-purge-plan.ts) pass whole static texts. The inventory probes are built per call from the
 * deletion inventory's own table and column names (`purgeProbeStatement`): no caller text reaches them.
 */
import { DELETION_INVENTORY_BY_TABLE } from '../deletion-inventory.ts';
import { liveStagingSql } from '../page-body/schema.ts';

/**
 * A page or page-version row (alias `a`) still states the claim: in its body,
 * timeline, title or frontmatter. `$n` is the lowercased claim, `$n+1` its
 * JSON-escaped form (frontmatter is matched as JSON text).
 */
export const carriesClaimSql = (a: string, n: number) => `(strpos(lower(${a}.compiled_truth),$${n})>0 OR strpos(lower(COALESCE(${a}.timeline,'')),$${n})>0
  OR strpos(lower(COALESCE(${a}.title,'')),$${n})>0 OR strpos(lower(COALESCE(${a}.frontmatter::text,'')),$${n + 1})>0)`;

/** A segmented version (`v`) whose generation's segment texts hold the lowered claim `$2`. */
export const SEGMENTED_VERSION_CARRIES = `EXISTS (SELECT 1 FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
  WHERE m.page_id=v.page_id AND m.staging_id IS NULL AND m.gen_from<=v.body_generation AND (m.gen_to IS NULL OR m.gen_to>v.body_generation)
    AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)`;

/** Stagings walked per part-edge batch (stagingsWithClaimAcrossParts). */
export const STAGING_PART_BATCH = 1000;

/** GBRA-574 A1: whether the entity has a live page (an unbacked name key purges source-wide). */
export const LIVE_PAGE_SLUG_SQL = 'SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1';

/** The pages of the purged takes discovery did not find. */
export const PURGE_TAKE_PAGES_SQL = 'SELECT slug,id AS page_id,knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])';

/** The page versions of the source carrying the claim ($2 lowered, $3 JSON-escaped, $4 the folded reason). */
export const PURGE_CARRYING_VERSIONS_SQL = `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id
    WHERE p.source_id=$1 AND (${carriesClaimSql('v', 2)} OR strpos(lower(v.change_reason),$2)>0 OR strpos(lower(v.change_reason),$4)>0
      OR (v.body_storage='segmented' AND ${SEGMENTED_VERSION_CARRIES}))`;

/** The live stagings of the source holding the claim ($2 lowered, $3 exact, $4 the lowered fence cell), in one part. */
export const STAGINGS_HOLDING_CLAIM_SQL = `SELECT s.id::text AS id FROM page_body_stagings s
    WHERE s.source_id=$1 AND ((s.state IN ('open','sealed','prepared') AND (EXISTS (SELECT 1 FROM page_body_manifest m
        JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE m.staging_id=s.id AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)
      OR EXISTS (SELECT 1 FROM page_body_staging_parts pt WHERE pt.staging_id=s.id AND position(convert_to($3::text,'UTF8') in pt.body)>0)))
      OR (${liveStagingSql('s')} AND EXISTS (SELECT 1 FROM page_body_staging_texts r JOIN page_segment_texts t ON t.source_id=r.source_id AND t.sha256=r.sha256
        WHERE r.staging_id=s.id AND (strpos(lower(convert_from(t.body,'UTF8')),$2)>0 OR strpos(lower(convert_from(t.body,'UTF8')),$4)>0))))
    ORDER BY s.id`;

/** The next batch of live staging parts after ($3, $4): each part's first and last $2 bytes. */
export const STAGING_PART_EDGES_SQL = `SELECT pt.staging_id::text AS id,pt.part_no,
        substring(pt.body from 1 for $2) AS head,substring(pt.body from greatest(1,octet_length(pt.body)-$2+1)) AS tail
      FROM page_body_staging_parts pt JOIN page_body_stagings s ON s.id=pt.staging_id
      WHERE s.source_id=$1 AND s.state IN ('open','sealed','prepared') AND (pt.staging_id,pt.part_no)>($3::uuid,$4::int)
      ORDER BY pt.staging_id,pt.part_no LIMIT ${STAGING_PART_BATCH}`;

/** The review queue, review proposal and decide proposal rows naming the purged facts. */
export const PURGE_REVIEW_COUNTS_SQL = `SELECT
    (SELECT count(*)::int FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS q,
    (SELECT count(*)::int FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS rp,
    (SELECT count(*)::int FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($3::bigint[]) OR old_fact_id=ANY($3::bigint[]))) AS dp`;

/** `--match`: up to 25 facts of the source whose text contains $2, by id. */
export const PURGE_MATCH_SQL = `SELECT id,entity_slug,visibility,
    expired_at IS NOT NULL AS expired,left(fact,160) AS fact FROM facts WHERE source_id=$1 AND strpos(lower(fact),lower($2))>0 ORDER BY id LIMIT 25`;

const carries = (column: string) => `(${column} IS NOT NULL AND (strpos(lower(${column}::text),$2)>0 OR strpos(lower(${column}::text),$3)>0 OR strpos(lower(${column}::text),$4)>0))`;

/** Requests whose intent, outcome or error text carries the claim ($2 lowered, $3 JSON-escaped, $4 the escaped reason), up to $5. */
export const REQUESTS_CARRYING_SQL = `SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests
    WHERE source_id=$1 AND (${carries('intent')} OR ${carries('outcome')} OR ${carries('error_detail')} OR ${carries('error_message')})
    ORDER BY sequence LIMIT $5`;

/** Unfinished requests whose intent publishes one of the stagings $2. */
export const REQUESTS_HOLDING_STAGINGS_SQL = `SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests
    WHERE source_id=$1 AND state IN ('queued','deferred','running','recovering') AND intent->'body_ref'->>'staging_id'=ANY($2::text[]) ORDER BY sequence`;

/** One hop of the derivation walk: the rows derived from the frontier $1 (JSON), up to $2. */
export const DERIVED_ROWS_STEP_SQL = `SELECT DISTINCT d.derived_table,d.derived_id
      FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text)
        ON d.input_table=f.input_table AND d.input_id=f.input_id
      ORDER BY d.derived_table,d.derived_id LIMIT $2`;

/** The live segmented pages of the source, by id, up to $2. */
export const SEGMENTED_PAGE_BODIES_SQL = `SELECT id AS page_id,slug,NULL AS generation,NULL AS version_id FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND body_storage='segmented' ORDER BY id LIMIT $2`;

/** The segmented page versions of the source, by version id, up to $2. */
export const SEGMENTED_VERSION_BODIES_SQL = `SELECT v.page_id,p.slug,v.body_generation AS generation,v.id AS version_id
      FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.body_storage='segmented' ORDER BY v.id LIMIT $2`;

/** Live model-derived pages of the source with no derivation edge. */
export const LEGACY_DERIVED_PAGES_SQL = `SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
    AND (p.type='atom' OR p.frontmatter->>'dream_generated'='true')
    AND NOT EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table='pages' AND d.derived_id=p.id::text)`;

/** The relative file paths the pages $1 and their versions recorded, up to 64. */
export const PAGE_SOURCE_PATHS_SQL = `SELECT DISTINCT source_path FROM (
      SELECT source_path FROM pages WHERE id=ANY($1::int[]) UNION ALL SELECT source_path FROM page_versions WHERE page_id=ANY($1::int[])) s
    WHERE source_path IS NOT NULL AND source_path<>'' AND source_path NOT LIKE '/%' AND source_path NOT LIKE '%..%' LIMIT 64`;

/** The five same-model facts of the source nearest the embedding $1, and whether each contains the claim $4. */
export const FACT_NEIGHBOURS_SQL = `SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity,
        strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim
      FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::halfvec LIMIT 5`;

/** The transaction-local statement deadline of one bounded probe ($1, e.g. `2000ms`). */
export const PROBE_TIMEOUT_SQL = "SELECT set_config('statement_timeout',$1,true)";

const textMatch = (column: string, at: number) => `(strpos(lower(${column}::text),$${at})>0 OR strpos(lower(${column}::text),$${at + 1})>0)`;
/** Vector and lexeme columns carry no probe-able text. */
const PROBE_SKIP = /embedding|search_vector/;
/** Stores whose probe columns are bytea; their bytes are matched exactly (case-sensitive) against the UTF-8 needle. */
const BINARY_PROBE_TABLES: ReadonlySet<string> = new Set(['minion_attachments', 'page_segment_texts', 'page_body_staging_parts']);

/**
 * W1 prerequisite (BELIEF_LEDGER.md 6.5): link context, timeline detail and raw data are reported, not swept, so their
 * receipt names the rows that still carry the claim (scoped to the source through their page), not only a count.
 */
export const NAMED_ROW_PROBES = {
  links: { columns: ['l.context'], select: `SELECT 'link:' || l.id || ' ' || f.slug || ' -> ' || t.slug AS item FROM links l JOIN pages f ON f.id = l.from_page_id
    JOIN pages t ON t.id = l.to_page_id WHERE (f.source_id = $1 OR t.source_id = $1)` },
  timeline_entries: { columns: ['x.summary', 'x.detail'], select: `SELECT 'timeline:' || x.id || ' ' || p.slug || ' ' || x.date::text AS item FROM timeline_entries x
    JOIN pages p ON p.id = x.page_id WHERE p.source_id = $1` },
  raw_data: { columns: ['r.data'], select: `SELECT 'raw_data:' || r.id || ' ' || p.slug || ' ' || r.source AS item FROM raw_data r JOIN pages p ON p.id = r.page_id WHERE p.source_id = $1` },
} as const satisfies Record<string, { select: string; columns: readonly string[] }>;

export type NamedProbeTable = keyof typeof NAMED_ROW_PROBES;

/**
 * One bounded inventory probe of a purge verification: an inventory `table` searched for `needles` (exact,
 * case-insensitive; JSON also in its escaped form; bytea stores byte-exact), scoped to the source when the table has
 * one. `probe` narrows the probed columns to some of the entry's own columns. `named` probes list the carrying rows.
 */
export type PurgeProbe =
  | { kind: 'table'; table: string; sourceId: string; needles: readonly string[]; probe?: readonly string[] }
  | { kind: 'named'; table: NamedProbeTable; sourceId: string; needles: readonly string[] };

/**
 * What one probe searches: the table, the probed columns (as the select names them, and bare), whether the table is
 * scoped by its own source_id, whether its columns are bytea, and the needles (at most 32, empty ones dropped). Null when
 * it has nothing to search. The Rust engine reads this shape; purgeProbeSelect builds the SQL from it.
 */
export interface PurgeProbeShape {
  kind: PurgeProbe['kind'];
  table: string;
  sourceId: string;
  /** The probed columns as the select names them (`l.context` for a named probe). */
  columns: readonly string[];
  /** The same columns without a table alias. */
  bare: readonly string[];
  scoped: boolean;
  binary: boolean;
  needles: readonly string[];
}

export function purgeProbeShape(probe: PurgeProbe): PurgeProbeShape | null {
  const list = probe.needles.filter(Boolean).slice(0, 32);
  const bare = (columns: readonly string[]) => columns.map(col => col.slice(col.indexOf('.') + 1));
  if (probe.kind === 'named') {
    const named = NAMED_ROW_PROBES[probe.table];
    if (!named) throw new Error(`purge probe: ${String(probe.table)} has no named-row probe`);
    if (!list.length) return null;
    return { kind: 'named', table: probe.table, sourceId: probe.sourceId, columns: named.columns, bare: bare(named.columns),
      scoped: true, binary: false, needles: list };
  }
  const entry = DELETION_INVENTORY_BY_TABLE.get(probe.table);
  if (!entry) throw new Error(`purge probe: ${probe.table} is not an inventory table`);
  const own = probe.probe ?? entry.probe ?? entry.columns;
  for (const col of own) if (!entry.columns.includes(col)) throw new Error(`purge probe: ${probe.table} has no column ${col}`);
  const columns = own.filter(col => !PROBE_SKIP.test(col));
  if (!columns.length || !list.length) return null;
  return { kind: 'table', table: entry.table, sourceId: probe.sourceId, columns, bare: bare(columns),
    scoped: entry.columns.includes('source_id'), binary: BINARY_PROBE_TABLES.has(entry.table), needles: list };
}

/** The probe's row select (no LIMIT) and its parameters; null when it has nothing to search. */
export function purgeProbeSelect(probe: PurgeProbe): { sql: string; params: unknown[] } | null {
  const shape = purgeProbeShape(probe);
  if (!shape) return null;
  const params: unknown[] = [shape.sourceId];
  const ors: string[] = [];
  for (const needle of shape.needles) {
    if (shape.binary) { params.push(needle); ors.push(...shape.columns.map(col => `position(convert_to($${params.length}::text,'UTF8') in ${col})>0`)); continue; }
    params.push(needle.toLowerCase(), JSON.stringify(needle).slice(1, -1).toLowerCase());
    ors.push(...shape.columns.map(col => textMatch(col, params.length - 1)));
  }
  if (shape.kind === 'named') return { sql: `${NAMED_ROW_PROBES[shape.table as NamedProbeTable].select} AND (${ors.join(' OR ')})`, params };
  return { sql: `SELECT 1 FROM ${shape.table} WHERE ${shape.scoped ? 'source_id=$1 AND' : '$1::text IS NOT NULL AND'} (${ors.join(' OR ')})`, params };
}

/** The bounded count of a row select: at most `rows + 1` rows are counted. */
export function boundedCountSql(select: string, rows: number): string {
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('purge probe: the row bound must be a non-negative integer');
  return `SELECT count(*)::int AS n FROM (${select} LIMIT ${rows + 1}) bounded`;
}

/** The first 20 items a named probe lists. */
export function probeItemsSql(select: string): string {
  return `${select} ORDER BY 1 LIMIT 20`;
}
