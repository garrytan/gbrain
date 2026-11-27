/**
 * The swap report's `collation_order_differs` line (docs/designs/RUST_ENGINE.md D25 A1; the maintainer, Slack channel
 * C0CJDTJG5PE, 2026-11-22 at 8:50 PM PST, "Do it"). The Rust engine lists text keys in byte order, as PGLite does. A
 * Postgres brain whose collation is not byte order (libc en_US, or any ICU locale) lists some of them in its own order,
 * so after the swap those lists answer differently. This is a named loss, never a refusal: the plan names every such
 * list, in one of three classes per site, and the fixed repair-preview line. It is not bound by the plan hash.
 *
 *   reordered  the same rows in another order;
 *   capped     different rows in a capped list (a LIMIT, a top-N or a keyset page cut at another row);
 *   unchanged  no change: the SQL sorts with COLLATE "C", sorts in byte order client-side, or the key is not text
 *              (counted, not listed).
 *
 * The sites come from the order audit of the SQL engines' ORDER BY lines (Nov 22-23) re-checked against this tree: every
 * text sort an agent or user reads that is not pinned to byte order. Sites the audit could not trace to their output are
 * listed as `untraced`, never left out.
 */

export type CollationClass = 'reordered' | 'capped' | 'untraced';

export interface CollationSite {
  /** The command or MCP tool a user or agent reaches the list from. */
  command: string;
  /** The sort: file and line of the ORDER BY. */
  site: string;
  /** The sort key. */
  key: string;
  class: CollationClass;
  note: string;
}

/** The fixed line of the report: a preview's list order (and so its approval hash) can change with the engine. */
export const REPAIR_PREVIEW_LINE = 'repair previews made before the swap must be run again';

/** Text sorts an agent or user reads that are not pinned to byte order. */
export const COLLATION_SITES: readonly CollationSite[] = [
  { command: 'gbrain dedupe confirm --json (pending list)', site: 'src/core/engine-sql/identity-decisions.ts:108', key: 'decision_id, then source_id and slug', class: 'reordered',
    note: 'rows that tie on decision_id and differ only in case or punctuation of the source id or slug change order' },
  { command: 'gbrain extract mentions --explain --json (aliases)', site: 'src/core/engine-sql/mention-reads.ts:111', key: 'alias_norm', class: 'reordered',
    note: 'aliases with case, accents or punctuation change order' },
  { command: 'gbrain repair purged-page-facts (preview)', site: 'src/core/engine-sql/facts-repair.ts:435', key: 'source_id, page slug, fact id', class: 'reordered',
    note: 'the preview list order feeds its approval hash, so a preview made before the swap does not match after it' },
  { command: 'gbrain repair lost-fence-rows (preview)', site: 'src/core/engine-sql/lost-fence-reads.ts:21', key: 'source_id, owner_key, id, item_key', class: 'reordered',
    note: 'owner keys name page slugs; previews list rows in this order' },
  { command: 'gbrain doctor entity-duplicates', site: 'src/core/engine-sql/entity-keys.ts:77', key: 'source_id, slug (keyset pages of 5000)', class: 'capped',
    note: 'a page boundary can fall at another row; the whole scan still covers every row' },
  { command: 'entity resolution (fuzzy match, internal)', site: 'src/core/engine-sql/entity-reads.ts:193', key: 'score, then slug (LIMIT 5)', class: 'capped',
    note: 'on an exact score tie a different slug can be kept, which can change the entity a new fact is attributed to' },
  { command: 'gbrain repair stale-atoms', site: 'src/core/engine-sql/stale-atom-reads.ts:49', key: 'fingerprint (LIMIT 1)', class: 'untraced',
    note: 'which checkpoint is picked when fingerprints tie on case was not traced to the output' },
  { command: 'gbrain sync status --json (identity downgrades)', site: 'src/core/engine-sql/sync-status-reads.ts:206', key: 'new_slugs', class: 'untraced',
    note: 'whether new_slugs is printed in this order was not traced' },
  { command: 'decide review lane (internal queue)', site: 'src/core/engine-sql/decide-proposals.ts:272', key: 'next_attempt_at, created_at, a_ref, b_ref', class: 'untraced',
    note: 'internal review queue; ties on time break on text refs' },
];

/** Text sorts the audit checked that answer the same on every engine (COLLATE "C", byte order client-side, a non-text
 * key, or an order that is never printed, such as advisory lock order). */
export const UNCHANGED_SITE_COUNT = 41;

/** The source's collation as the shadow's fingerprint probe recorded it (src/shadow/fingerprints.ts). */
export interface SourceCollation { collation?: string | null; locale_provider?: string | null; locale?: string | null }

export interface CollationReport {
  reason: 'collation_order_differs';
  /** True: lists change; false: the source already sorts in byte order; null: the source collation is not known. */
  applies: boolean | null;
  source: { engine: string; collation: string | null; provider: string | null; locale: string | null };
  why: string;
  sites: { reordered: CollationSite[]; capped: CollationSite[]; untraced: CollationSite[]; unchanged: number };
  /** The lines the plan prints (empty when `applies` is false). */
  lines: string[];
}

const BYTE_ORDER = new Set(['c', 'posix', 'c.utf8', 'c.utf-8']);

/**
 * True when the collation sorts text by bytes. ICU never does (its LC_COLLATE can read C.UTF-8 while the ICU locale
 * governs); libc does for C and POSIX only; the builtin provider (PostgreSQL 17) for C and C.UTF-8.
 */
function byteOrder(c: SourceCollation): boolean | null {
  const provider = (c.locale_provider ?? '').toLowerCase();
  const collation = (c.collation ?? '').toLowerCase();
  if (provider === 'i' || provider === 'icu') return false;
  if (provider === 'b' || provider === 'builtin') return BYTE_ORDER.has((c.locale ?? collation).toLowerCase());
  if (!collation) return null;
  return collation === 'c' || collation === 'posix';
}

export function collationReport(engine: string, collation: SourceCollation | null | undefined): CollationReport {
  const source = { engine, collation: collation?.collation ?? null, provider: collation?.locale_provider ?? null, locale: collation?.locale ?? null };
  const by = (k: CollationClass) => COLLATION_SITES.filter(s => s.class === k);
  const sites = { reordered: by('reordered'), capped: by('capped'), untraced: by('untraced'), unchanged: UNCHANGED_SITE_COUNT };
  const none = { reordered: [], capped: [], untraced: [], unchanged: UNCHANGED_SITE_COUNT };
  if (engine !== 'postgres') {
    return { reason: 'collation_order_differs', applies: false, source, why: `a ${engine} brain sorts text in byte order, as the Rust engine does`, sites: none, lines: [] };
  }
  const bytes = collation ? byteOrder(collation) : null;
  if (bytes === true) {
    return { reason: 'collation_order_differs', applies: false, source, why: `the source collation (${source.collation ?? source.locale}) sorts text in byte order, as the Rust engine does`, sites: none, lines: [] };
  }
  const named = source.provider ? `${source.collation ?? '?'}${source.locale ? `, ICU or builtin locale ${source.locale}` : ''} (provider ${source.provider})` : null;
  const why = bytes === null
    ? 'the source collation is not known (the fingerprint probe has not recorded it), so every list below may change'
    : `the source collation ${named} does not sort text in byte order; the Rust engine does`;
  const row = (s: CollationSite) => `  - ${s.command}: ${s.key} (${s.site}); ${s.note}`;
  const lines = [
    `Named loss collation_order_differs: ${why}. These lists answer differently after the swap (report only, never a refusal):`,
    `  same rows, another order (${sites.reordered.length}):`, ...sites.reordered.map(row),
    `  different rows in a capped list (${sites.capped.length}):`, ...sites.capped.map(row),
    `  not traced to their output, may change (${sites.untraced.length}):`, ...sites.untraced.map(row),
    `  no change: ${sites.unchanged} other text sorts are pinned to byte order or sort on a non-text key.`,
    REPAIR_PREVIEW_LINE,
  ];
  return { reason: 'collation_order_differs', applies: bytes === null ? null : true, source, why, sites, lines };
}
