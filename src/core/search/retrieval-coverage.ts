/**
 * #7165: query-scoped coverage for search and query. A pending text projection
 * or a held file is brain state; whether it can change THIS answer depends on
 * the query. An item could affect a query when it is one of the returned pages,
 * its page type is one of the result types or the query's types, or its title,
 * slug or file path holds a query word. An empty result counts every item:
 * nothing rules it out, and an empty answer must never read as complete.
 *
 * #7492: a query word counts only as a whole token of the title, slug or path
 * (bounded by characters other than letters and digits), so "412" no longer
 * matches an image frame named `t004120` and short words no longer match
 * inside longer ones. An image page counts only when an image arm ran or the
 * page was returned: text search never reads image chunks, so a pending image
 * cannot change a text-only answer, empty or not. The pending pages that could
 * affect the query are also counted by class (`could_affect.pending_images`:
 * images in the `sealable` or `reimport` class, which wait for an operator,
 * not for indexing), so the notice can say which wait applies.
 *
 * Counted here: pending text projections (the readiness probe's unsealed pages
 * that need work) and pages held from embedding (a held or capped
 * page_embedding_budget row that still applies: no vectors, so the vector arm
 * cannot find them). Held files are counted by persistence/held-reads.ts. The
 * counts are engine members (engine-sql/retrieval-coverage.ts on PGLite and
 * Postgres); the relevance rules are built here.
 */
import type { BrainEngine } from '../engine.ts';
import { embeddingsDisabled } from '../embedding-disabled.ts';
import type { ProjectionReadinessScope } from './projection-readiness.ts';

/**
 * Each count stops here: min(every match in scope, cap), so the answer does not depend on the order an engine reads
 * pages in. A capped count reports `capped`.
 */
export const COVERAGE_COUNT_CAP = 1000;

/** A coverage count that runs longer is unknown (null), never zero: Postgres ends it on the server and the Rust store stops its walk. */
export const COVERAGE_COUNT_TIMEOUT_MS = 2_000;

export interface CoverageRelevance {
  all: boolean;
  types: string[];
  /** POSIX regular expressions matching one query word as a whole token, one per word. */
  patterns: string[];
  pageIds: number[];
  /** The top result's page when it is an exact slug, title or alias match for the query, else null. */
  exactTopPageId: number | null;
  /** Whether an image arm ran: otherwise an image page counts only when it was returned. */
  imageArm: boolean;
}

/** `_meta.retrieval.coverage`: counts in the read scope and how many of them could affect this query. */
export interface RetrievalCoverage {
  pending_projection?: number;
  held_files?: number;
  embedding_held?: number;
  could_affect: {
    pending_projection?: number; held_files?: number; embedding_held?: number;
    /** Of `pending_projection`, image pages in the `sealable` or `reimport` class (absent when none): they wait for an operator. */
    pending_images?: number;
  };
  capped?: true;
  /** The top result is the page the query named (exact slug, title or alias) and its projection is current: pending pages are not counted as able to affect this answer. */
  top_hit_exact?: true;
  /** #9192: while the upgrade's index rebuild (v153 activation) drains, pages in scope done of total and the rate measured since it started. */
  rebuild?: ProjectionRebuildProgress;
}

export interface ProjectionRebuildProgress { done: number; total: number; pages_per_second: number | null }

export interface ScopedCount {
  total: number; could_affect: number; capped: boolean;
  /** With an exact top hit: whether that page is itself counted. */
  top_counted?: boolean;
  /** Pending counts: the could-affect images in the `sealable` or `reimport` class. */
  could_affect_images?: number;
}

/** What could make a pending or held item relevant to this query (see the module comment). */
export function coverageRelevance(
  results: ReadonlyArray<{ type?: unknown; page_id?: unknown; exact_lookup?: unknown; alias_hit?: unknown }>,
  queryText: string,
  queryTypes: readonly string[] | undefined,
  stopwords: ReadonlySet<string>,
  imageArm = false,
): CoverageRelevance {
  const terms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])]
    .filter(t => t.length >= 3 && !stopwords.has(t)).slice(0, 12);
  return {
    all: results.length === 0,
    types: [...new Set([...(queryTypes ?? []), ...results.flatMap(r => (typeof r.type === 'string' ? [r.type] : []))])],
    patterns: terms.map(t => `(^|[^[:alnum:]])${t.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`)}([^[:alnum:]]|$)`),
    pageIds: [...new Set(results.flatMap(r => (typeof r.page_id === 'number' ? [r.page_id] : [])))],
    exactTopPageId: results[0] && (results[0].exact_lookup || results[0].alias_hit === true) && typeof results[0].page_id === 'number' ? results[0].page_id : null,
    imageArm,
  };
}

/**
 * The pending pages the readiness probe found (unsealed, needing work) in the same scope. Null when the count fails.
 * The classed count runs JIT off, as the readiness probe does (#8033): the class's per-page subplans and a remote caller's
 * visibility subplans lift its estimate past `jit_above_cost`, and on a large brain compiling them cost more than a second
 * on every search while the read itself took a fraction of that. The embedding-held count stays a plain statement.
 */
export function countPendingProjections(engine: Pick<BrainEngine, 'countPendingProjectionPages'>, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  return engine.countPendingProjectionPages(scope, relevance);
}

/**
 * Pages in scope held from embedding: a held or capped budget row that still applies, on a page no `embed_skip` marker keeps out of embedding for good.
 * Null on a brain with embeddings off on purpose, where a held page is no degradation.
 */
export async function countEmbeddingHeld(engine: Pick<BrainEngine, 'countEmbeddingHeldPages' | 'getConfig'>, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  if (await embeddingsDisabled(engine)) return null;
  return engine.countEmbeddingHeldPages(scope, relevance);
}

/**
 * #9192: progress of the index rebuild an upgrade's activation queued (rows still queued with reason
 * `protocol_activation`), over the pages in scope: how many are done of the total, and the rate measured from the
 * start of the rebuild. Null when no such rebuild is running or the count fails.
 *
 * The rebuild runs while an activation row waits on a `text` page in scope: the resident drain rebuilds only those.
 * Rows left on images (`sealable`, `reimport`) wait for an operator, whom the pending-images notice already names,
 * so they never make a rebuild look like it runs for good. That check reads only the queue, and the count of every
 * page in scope, a read of the whole pages table, sits behind it (a filter on the outer row alone, so Postgres never
 * starts the scan when no rebuild runs): it runs only while the rebuild runs, never on every search. JIT off for the
 * same reason as the classed pending count: the never-run count still prices into the estimate.
 */
export function countProjectionRebuild(engine: Pick<BrainEngine, 'projectionRebuildProgress'>, scope: ProjectionReadinessScope): Promise<ProjectionRebuildProgress | null> {
  return engine.projectionRebuildProgress(scope);
}
