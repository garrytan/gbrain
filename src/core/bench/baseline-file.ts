/**
 * Baseline file format for `gbrain bench publish` + `gbrain eval gate --baseline`.
 *
 * Wire shape: NDJSON. First line is metadata (`_kind: 'baseline_metadata'`).
 * Subsequent lines are raw captured rows mirroring `EvalCandidateInput`.
 *
 * The `_kind` discriminator lets `gbrain eval replay` skip the metadata line
 * cleanly (codex round-1 #3 — without the discriminator the header counts as
 * a fake data row and pollutes counts).
 *
 * Source-id-aware: row-level `source_ids: string[]` + `query_hash` form the
 * dedup key in `bench publish` (codex round-2 #6 — slug-only would collapse
 * the same query across federated sources).
 *
 * `baseline_mean_latency_ms` is the absolute baseline latency. The gate's
 * latency check is `(baseline + delta) / baseline <= multiplier`, which
 * requires the absolute baseline — `eval replay` only emits the delta
 * (codex round-2 #2).
 */

import { createHash } from 'node:crypto';
import type { EvalCandidateInput } from '../types.ts';

/** Stable on-disk format version. Bump when adding new required fields. */
export const BASELINE_FILE_SCHEMA_VERSION = 1 as const;

/** Default thresholds when neither baseline metadata nor CLI flags set them. */
export const DEFAULT_THRESHOLDS: BaselineThresholds = {
  jaccard: 0.85,
  top1: 0.80,
  latency_multiplier: 2.0,
};

export interface BaselineThresholds {
  jaccard: number;
  top1: number;
  latency_multiplier: number;
}

export interface BaselineMetadata {
  schema_version: typeof BASELINE_FILE_SCHEMA_VERSION;
  _kind: 'baseline_metadata';
  label: string;
  published_at: string; // ISO 8601
  source_hash: string; // sha256 of sorted row hashes
  thresholds: BaselineThresholds;
  row_count: number;
  baseline_mean_latency_ms: number;
}

/** A baseline row mirrors EvalCandidateInput + adds a stable query_hash. */
export interface BaselineRow extends EvalCandidateInput {
  /** sha256(normalizeQueryForHash(query)).slice(0,16). Stamped at publish time. */
  query_hash: string;
}

export interface BaselineFile {
  metadata: BaselineMetadata;
  rows: BaselineRow[];
}

/**
 * Lowercase + collapse whitespace. Used as the input to `computeQueryHash`
 * so that "  Hello   World  " and "hello world" hash to the same value.
 */
export function normalizeQueryForHash(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 16-hex-char sha256 prefix of the normalized query. Stable across runs. */
export function computeQueryHash(query: string): string {
  return createHash('sha256').update(normalizeQueryForHash(query)).digest('hex').slice(0, 16);
}

/** sha256 of the sorted concatenation of every row's query_hash. */
export function computeSourceHash(rows: BaselineRow[]): string {
  const hashes = rows.map(r => r.query_hash).sort();
  return createHash('sha256').update(hashes.join('\n')).digest('hex');
}

export class BaselineParseError extends Error {
  constructor(message: string, public readonly lineNumber?: number) {
    super(message);
    this.name = 'BaselineParseError';
  }
}

/**
 * Parse a baseline NDJSON file. First non-empty line MUST be metadata.
 * Subsequent lines are rows.
 *
 * Throws `BaselineParseError` with paste-ready line + message on any failure.
 */
export function parseBaselineFile(content: string): BaselineFile {
  const lines = content.split('\n');
  let metadata: BaselineMetadata | null = null;
  const rows: BaselineRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new BaselineParseError(
        `Malformed JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        i + 1,
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new BaselineParseError(`Line ${i + 1} is not a JSON object`, i + 1);
    }

    if (metadata === null) {
      // First non-empty line MUST be metadata.
      const meta = parsed as Partial<BaselineMetadata>;
      if (meta._kind !== 'baseline_metadata') {
        throw new BaselineParseError(
          `First line must have "_kind": "baseline_metadata" (got ${JSON.stringify(meta._kind)})`,
          i + 1,
        );
      }
      if (meta.schema_version !== BASELINE_FILE_SCHEMA_VERSION) {
        throw new BaselineParseError(
          `Unsupported schema_version ${meta.schema_version} (this gbrain build expects ${BASELINE_FILE_SCHEMA_VERSION})`,
          i + 1,
        );
      }
      if (
        typeof meta.label !== 'string' ||
        typeof meta.published_at !== 'string' ||
        typeof meta.source_hash !== 'string' ||
        typeof meta.row_count !== 'number' ||
        typeof meta.baseline_mean_latency_ms !== 'number' ||
        !meta.thresholds ||
        typeof meta.thresholds.jaccard !== 'number' ||
        typeof meta.thresholds.top1 !== 'number' ||
        typeof meta.thresholds.latency_multiplier !== 'number'
      ) {
        throw new BaselineParseError(
          `Metadata header missing required fields (label/published_at/source_hash/row_count/baseline_mean_latency_ms/thresholds)`,
          i + 1,
        );
      }
      metadata = meta as BaselineMetadata;
    } else {
      const row = parsed as Partial<BaselineRow>;
      if (typeof row.tool_name !== 'string' || (row.tool_name !== 'query' && row.tool_name !== 'search')) {
        throw new BaselineParseError(`Row on line ${i + 1} missing or invalid tool_name`, i + 1);
      }
      if (typeof row.query !== 'string') {
        throw new BaselineParseError(`Row on line ${i + 1} missing query`, i + 1);
      }
      if (typeof row.query_hash !== 'string') {
        throw new BaselineParseError(`Row on line ${i + 1} missing query_hash (was it written by gbrain bench publish?)`, i + 1);
      }
      if (!Array.isArray(row.retrieved_slugs) || !Array.isArray(row.source_ids)) {
        throw new BaselineParseError(`Row on line ${i + 1} missing retrieved_slugs or source_ids`, i + 1);
      }
      rows.push(row as BaselineRow);
    }
  }

  if (metadata === null) {
    throw new BaselineParseError('Empty file or no metadata header found');
  }
  return { metadata, rows };
}

/**
 * Serialize a BaselineFile to NDJSON. Output is byte-deterministic given
 * the same input: rows sort by (tool_name, query_hash) before write.
 *
 * Each body row is stamped with `schema_version: 1` (same envelope as
 * `gbrain eval export`) so the existing `eval replay` parser accepts the
 * row unchanged. Without this stamp, replay's "Line N missing schema_version"
 * validator would reject every baseline body row.
 */
export function serializeBaselineFile(file: BaselineFile): string {
  const sortedRows = [...file.rows].sort((a, b) => {
    if (a.tool_name !== b.tool_name) return a.tool_name < b.tool_name ? -1 : 1;
    if (a.query_hash !== b.query_hash) return a.query_hash < b.query_hash ? -1 : 1;
    return 0;
  });
  const lines = [
    JSON.stringify(file.metadata),
    ...sortedRows.map(r => JSON.stringify({ schema_version: 1, ...r })),
  ];
  return lines.join('\n') + '\n';
}
