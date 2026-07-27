// v0.39 T2 — gbrain schema detect: SQL-driven heuristic clustering.
//
// Walks pages.source_path prefixes + frontmatter `type:` distribution to
// propose a candidate schema-pack manifest matching the brain's actual
// shape. Pure data layer (no LLM); T3's runSuggest layers refinement on top.
//
// Output shape mirrors SchemaPackManifest v1 so a candidate can be
// validated + applied via `gbrain schema use <candidate-name>` after
// review-candidates promotes it.
//
// Privacy: type names + slug prefixes come from the user's own brain. No
// PII flows out. Cap output to top-N prefixes per source to bound size.

import type { BrainEngine } from '../engine.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';

export interface DetectOpts {
  /** Source to detect against. Defaults to 'default'. */
  sourceId?: string;
  /** Min page count per prefix to include in candidate. Default 5. */
  minPagesPerPrefix?: number;
  /** Max candidate types in the output. Default 50. */
  maxTypes?: number;
}

export interface DetectResult {
  /** Total page count scanned. */
  total_pages: number;
  /** Page count that already has a frontmatter type matching gbrain-base. */
  typed_pages: number;
  /** Page count with type=null (the "missing schema" signal). */
  untyped_pages: number;
  /** Candidate manifest matching detected shape. */
  candidate: Pick<SchemaPackManifest, 'api_version' | 'name' | 'version' | 'description' | 'page_types' | 'takes_kinds'>;
  /** Per-prefix breakdown for human review. */
  prefixes: Array<{
    prefix: string;
    page_count: number;
    sample_types: string[];
    suggested_type: string;
  }>;
}

export interface PrefixRow {
  prefix: string;
  cnt: number;
  sample_types: string[];
}

export interface TypeRow {
  type: string;
  cnt: number;
}

/**
 * Pure scoring function: given prefix rows + type rows, build a candidate
 * manifest. Exported for unit tests; production wires through runDetect().
 */
export function buildCandidate(opts: {
  prefixes: PrefixRow[];
  types: TypeRow[];
  minPagesPerPrefix: number;
  maxTypes: number;
}): DetectResult['candidate'] {
  const { prefixes, minPagesPerPrefix, maxTypes } = opts;
  const filtered = prefixes
    .filter((p) => p.cnt >= minPagesPerPrefix)
    .slice(0, maxTypes);

  const page_types = filtered.map((p) => {
    // Suggest a type name from the prefix. Strip trailing slash, replace
    // non-alphanum with hyphen, lowercase.
    const typeName = p.prefix.replace(/\/$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'untyped';
    return {
      name: typeName,
      primitive: 'entity' as const,
      path_prefixes: [p.prefix],
      aliases: [],
      extractable: false,
      expert_routing: false,
    };
  });

  return {
    api_version: 'gbrain-schema-pack-v1' as const,
    name: 'detected-candidate',
    version: '0.0.1',
    description: 'Auto-detected from brain shape via `gbrain schema detect`. Review with `gbrain schema review-candidates` before activating.',
    page_types,
    takes_kinds: ['fact', 'take', 'bet', 'hunch'],
  };
}

/**
 * Orchestrator: query the engine for prefix + type distributions, build
 * the candidate, return as DetectResult. The CLI wraps this with --json
 * envelope + human formatter.
 */
export async function runDetect(
  engine: BrainEngine,
  opts: DetectOpts = {},
): Promise<DetectResult> {
  const sourceId = opts.sourceId ?? 'default';
  const minPagesPerPrefix = opts.minPagesPerPrefix ?? 5;
  const maxTypes = opts.maxTypes ?? 50;

  // Total + null-type counts (the schema-mismatch signal Persona A needs).
  const totals = await engine.executeRaw<{ total: string | number; untyped: string | number; typed: string | number }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped,
       COUNT(*) FILTER (WHERE type IS NOT NULL AND type != '')::text AS typed
     FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  const total_pages = Number(totals[0]?.total ?? 0);
  const untyped_pages = Number(totals[0]?.untyped ?? 0);
  const typed_pages = Number(totals[0]?.typed ?? 0);

  // Per-prefix distribution via the existing substring extraction primitive
  // (already used by whoknows/find_experts; sub-second on 50K-row brains
  // per the engine audit in /plan-eng-review section 4).
  const prefixRows = await engine.executeRaw<{ prefix: string; cnt: string | number; sample_types: string | string[] | null }>(
    `SELECT
       substring(slug from '^[^/]+/') AS prefix,
       COUNT(*)::text AS cnt,
       array_agg(DISTINCT type) FILTER (WHERE type IS NOT NULL AND type != '') AS sample_types
     FROM pages
     WHERE source_id = $1
       AND deleted_at IS NULL
       AND slug LIKE '%/%'
     GROUP BY substring(slug from '^[^/]+/')
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC
     LIMIT $3`,
    [sourceId, minPagesPerPrefix, maxTypes],
  );

  const prefixes: PrefixRow[] = prefixRows.map((r) => ({
    prefix: r.prefix,
    cnt: Number(r.cnt),
    sample_types: Array.isArray(r.sample_types) ? r.sample_types : [],
  }));

  // Per-type distribution (informational; mostly used by suggest in T3).
  const typeRows = await engine.executeRaw<{ type: string; cnt: string | number }>(
    `SELECT type, COUNT(*)::text AS cnt
     FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL AND type IS NOT NULL AND type != ''
     GROUP BY type
     ORDER BY COUNT(*) DESC
     LIMIT 100`,
    [sourceId],
  );
  const types: TypeRow[] = typeRows.map((r) => ({ type: r.type, cnt: Number(r.cnt) }));

  const candidate = buildCandidate({ prefixes, types, minPagesPerPrefix, maxTypes });

  // Build the human-readable per-prefix breakdown — pairs each prefix with
  // the candidate page_type entry that owns it, so review-candidates can
  // show "your `Projects/` directory has 47 pages → suggest type `projects`".
  const prefixBreakdown = prefixes.map((p, i) => ({
    prefix: p.prefix,
    page_count: p.cnt,
    sample_types: p.sample_types.slice(0, 5),
    suggested_type: candidate.page_types[i]?.name ?? 'untyped',
  }));

  return {
    total_pages,
    typed_pages,
    untyped_pages,
    candidate,
    prefixes: prefixBreakdown,
  };
}
