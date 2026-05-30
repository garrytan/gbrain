/**
 * Qrels file format for `gbrain eval gate --qrels`.
 *
 * Wire shape: JSON OBJECT (NOT bare array — preserves the existing fixture
 * shape at `test/fixtures/eval-baselines/qrels-search.json` per eng-D7).
 *
 * ```json
 * {
 *   "schema_version": 1,
 *   "_description": "...",
 *   "queries": [
 *     { "query_id": "q1", "query": "...", "relevant_slugs": ["slug-a"], "first_relevant_slug": "slug-a" },
 *     { "query_id": "q2", "query": "...", "relevant": [{"source_id":"foo","slug":"slug-b"}], "expected_top1": {"source_id":"foo","slug":"slug-b"} }
 *   ]
 * }
 * ```
 *
 * Two equivalent representations PER ENTRY:
 * - Legacy slug-only (`relevant_slugs` + `first_relevant_slug`): auto-promoted
 *   to source_id 'default' for back-compat with the existing 12-row fixture.
 * - Federated (`relevant` + `expected_top1`): explicit `{source_id, slug}`
 *   pairs per eng-D5 (codex round-2 #6 — slug-only false-passes on multi-source brains).
 *
 * Compares are on `${source_id}::${slug}` strings everywhere.
 */

export const QRELS_FILE_SCHEMA_VERSION = 1 as const;

/** Defaults when neither qrels-file nor CLI flags set them. */
export const DEFAULT_QRELS_THRESHOLDS = {
  recall_at_k: 0.70,
  first_relevant_hit: 0.60,
  /** Lower default because exact top-1 is harder than any-relevant top-1. */
  expected_top1: 0.50,
  /** k for recall@k unless overridden by CLI. */
  k: 10,
} as const;

export interface SourceSlugRef {
  source_id: string;
  slug: string;
}

export interface QrelsEntry {
  query_id: string;
  query: string;
  /** Normalized to {source_id, slug} pairs. Plain strings auto-promote to source_id='default'. */
  relevant: SourceSlugRef[];
  /** If set, retrieved[0] MUST equal this exact pair (strict top-1 metric). */
  expected_top1?: SourceSlugRef;
  label?: string;
  /** Pass-through fields from the existing fixture shape (kept for forward compat). */
  embedding_dim?: number;
}

export interface QrelsFile {
  schema_version: typeof QRELS_FILE_SCHEMA_VERSION;
  queries: QrelsEntry[];
  _description?: string;
}

export class QrelsParseError extends Error {
  constructor(message: string, public readonly entryIndex?: number) {
    super(message);
    this.name = 'QrelsParseError';
  }
}

/** Build the canonical `${source_id}::${slug}` compare key. */
export function makeRef(source_id: string, slug: string): string {
  return `${source_id}::${slug}`;
}

/** Build the canonical compare key from a SourceSlugRef. */
export function refKey(ref: SourceSlugRef): string {
  return makeRef(ref.source_id, ref.slug);
}

/**
 * Parse a qrels JSON file. Accepts both the legacy slug-only shape
 * (`relevant_slugs` + `first_relevant_slug`, source_id auto-defaults) and
 * the federated shape (`relevant` + `expected_top1` with explicit source_id).
 */
export function parseQrelsFile(content: string): QrelsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new QrelsParseError(`Malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new QrelsParseError(
      'Qrels file must be a JSON object (got array or non-object). Expected shape: {"schema_version":1,"queries":[...]}',
    );
  }

  const file = parsed as Partial<QrelsFile> & { queries?: unknown };
  if (file.schema_version !== QRELS_FILE_SCHEMA_VERSION) {
    throw new QrelsParseError(
      `Unsupported schema_version ${file.schema_version} (this gbrain build expects ${QRELS_FILE_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(file.queries)) {
    throw new QrelsParseError('Qrels file missing "queries" array');
  }
  if (file.queries.length === 0) {
    throw new QrelsParseError('Qrels file has empty "queries" array — at least one entry required');
  }

  const queries: QrelsEntry[] = [];
  for (let i = 0; i < file.queries.length; i++) {
    const raw = file.queries[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new QrelsParseError(`Entry ${i} is not a JSON object`, i);
    }
    const entry = raw as unknown as Record<string, unknown>;

    const query_id = typeof entry.query_id === 'string' ? entry.query_id : `entry-${i}`;
    if (typeof entry.query !== 'string' || entry.query.trim() === '') {
      throw new QrelsParseError(`Entry ${i} (${query_id}) missing or empty "query"`, i);
    }

    // Normalize relevant: prefer federated `relevant`, fall back to legacy `relevant_slugs`.
    let relevant: SourceSlugRef[];
    if (Array.isArray(entry.relevant)) {
      relevant = entry.relevant.map((r, j) => {
        if (typeof r !== 'object' || r === null) {
          throw new QrelsParseError(`Entry ${i} (${query_id}) relevant[${j}] is not an object`, i);
        }
        const ref = r as Record<string, unknown>;
        if (typeof ref.source_id !== 'string' || typeof ref.slug !== 'string') {
          throw new QrelsParseError(
            `Entry ${i} (${query_id}) relevant[${j}] missing source_id or slug`,
            i,
          );
        }
        return { source_id: ref.source_id, slug: ref.slug };
      });
    } else if (Array.isArray(entry.relevant_slugs)) {
      relevant = entry.relevant_slugs.map((slug, j) => {
        if (typeof slug !== 'string') {
          throw new QrelsParseError(
            `Entry ${i} (${query_id}) relevant_slugs[${j}] is not a string`,
            i,
          );
        }
        return { source_id: 'default', slug };
      });
    } else {
      throw new QrelsParseError(
        `Entry ${i} (${query_id}) missing "relevant" or "relevant_slugs"`,
        i,
      );
    }
    if (relevant.length === 0) {
      throw new QrelsParseError(`Entry ${i} (${query_id}) has empty relevant set`, i);
    }

    // Normalize expected_top1: prefer federated `expected_top1`, fall back to legacy `first_relevant_slug`.
    let expected_top1: SourceSlugRef | undefined;
    if (entry.expected_top1 !== undefined) {
      const e = entry.expected_top1;
      if (typeof e !== 'object' || e === null) {
        throw new QrelsParseError(`Entry ${i} (${query_id}) expected_top1 is not an object`, i);
      }
      const ref = e as Record<string, unknown>;
      if (typeof ref.source_id !== 'string' || typeof ref.slug !== 'string') {
        throw new QrelsParseError(
          `Entry ${i} (${query_id}) expected_top1 missing source_id or slug`,
          i,
        );
      }
      expected_top1 = { source_id: ref.source_id, slug: ref.slug };
    } else if (typeof entry.first_relevant_slug === 'string') {
      expected_top1 = { source_id: 'default', slug: entry.first_relevant_slug };
    }

    const out: QrelsEntry = { query_id, query: entry.query, relevant };
    if (expected_top1) out.expected_top1 = expected_top1;
    if (typeof entry.label === 'string') out.label = entry.label;
    if (typeof entry.embedding_dim === 'number') out.embedding_dim = entry.embedding_dim;
    // The cast is safe: we built `out` from validated fields. The pass-through
    // shape may carry additional unknown keys we want to surface to consumers
    // (back-compat with the existing fixture's `query_id`, `embedding_dim`).
    queries.push(out);
  }

  return {
    schema_version: QRELS_FILE_SCHEMA_VERSION,
    queries,
    ...(typeof file._description === 'string' ? { _description: file._description } : {}),
  };
}

/**
 * recall_at_k = |intersect(retrieved[:k], relevant)| / |relevant|.
 * Both `retrieved` and `relevant` are arrays of `${source_id}::${slug}` keys.
 * Returns a number in [0, 1].
 */
export function computeRecallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const relevantSet = new Set(relevant);
  const topK = retrieved.slice(0, k);
  let hits = 0;
  for (const r of topK) {
    if (relevantSet.has(r)) hits++;
  }
  return hits / relevant.length;
}

/**
 * first_relevant_hit = 1 if retrieved[0] in relevant else 0.
 * Empty retrieved → 0.
 */
export function computeFirstRelevantHit(retrieved: string[], relevant: string[]): 0 | 1 {
  if (retrieved.length === 0) return 0;
  const relevantSet = new Set(relevant);
  return relevantSet.has(retrieved[0]!) ? 1 : 0;
}

/**
 * expected_top1_hit = 1 if retrieved[0] === expected_top1 else 0.
 * Caller must check `expected_top1 !== undefined` before invoking.
 * Empty retrieved → 0.
 */
export function computeExpectedTop1Hit(retrieved: string[], expected_top1: string): 0 | 1 {
  if (retrieved.length === 0) return 0;
  return retrieved[0] === expected_top1 ? 1 : 0;
}
