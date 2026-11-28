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
  /** Every distinct type per prefix instead of the first five (schema suggest's coverage check, #10433). */
  allSampleTypes?: boolean;
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

  // Total + untyped counts (the schema-mismatch signal Persona A needs).
  const { total: total_pages, untyped: untyped_pages, typed: typed_pages } = await engine.pageTypeTotals(sourceId);

  // Per-prefix distribution (the slug up to its first '/'), largest first, with the page types under each prefix in
  // byte order (engine-sql/schema-detect.ts).
  const prefixes: PrefixRow[] = await engine.pagePrefixSamples(sourceId, minPagesPerPrefix, maxTypes);

  // Per-type distribution (informational; mostly used by suggest in T3).
  const types: TypeRow[] = await engine.countPagesByTypeForSource(sourceId, 100);

  const candidate = buildCandidate({ prefixes, types, minPagesPerPrefix, maxTypes });

  // Build the human-readable per-prefix breakdown — pairs each prefix with
  // the candidate page_type entry that owns it, so review-candidates can
  // show "your `Projects/` directory has 47 pages → suggest type `projects`".
  const prefixBreakdown = prefixes.map((p, i) => ({
    prefix: p.prefix,
    page_count: p.cnt,
    sample_types: opts.allSampleTypes ? p.sample_types : p.sample_types.slice(0, 5),
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
