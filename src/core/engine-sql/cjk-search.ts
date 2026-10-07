/**
 * CJK keyword fallback: one executor path for both engines (refactor wave 1,
 * W1-core C14). `websearch_to_tsquery` with an ASCII-stemming FTS config can't
 * tokenize CJK, so both engines route CJK queries here (#3986, PGLite since
 * v0.32.7). The SQL builds once in `src/core/search/cjk-keyword-sql.ts`
 * (identical text + params on both engines) and runs through master's direct
 * `unsafe` path.
 *
 * The read was RLS-scoped on master (EO4 inventory): it takes a `ScopedRead`,
 * supplied by the engine's `scoped` hook only AFTER the SQL built, so an
 * unbuildable query opens no transaction. Postgres's hook runs inside
 * `withScopedReadTransaction` with `SET LOCAL statement_timeout`; PGLite (no
 * RLS layer) brands its own executor.
 *
 * OR fallback (#6043): with `opts.orFallback` (hybrid's keyword arm) and more
 * than one term, a strict AND that returns fewer than the requested rows is
 * re-run matching any term, ranked by matched-term count then term frequency,
 * the same semantics as the ASCII path. Direct callers keep strict AND.
 *
 * Bounded arm (#5989), only when the caller passes `opts.cjkKeyword` (hybrid
 * does, with `search.cjk_keyword_deadline_ms`): on Postgres one absolute
 * deadline, started before the pool wait, covers both attempts. Today's full
 * scoring runs first under 2/3 of it; when its statement times out, that
 * transaction rolls back and one capped retry runs in the remaining third, in
 * a fresh scoped read transaction with the same source scope: up to
 * `CJK_CANDIDATE_CAP` chunk ids by an unordered LIKE scan, all-term matches
 * first and partial matches only when the all-term rows fall short, scored
 * over those ids alone. A capped stage that hit the cap reports
 * `keyword_candidates_incomplete`; a retry that also times out returns no
 * keyword rows with the same reason, and the vector arm still serves. PGLite
 * is in-process WASM and cannot be preempted, so it is bounded by work: past
 * `PGLITE_CJK_CAPPED_CHUNKS` chunks (planner estimate) it always uses the
 * capped stage.
 *
 * Note: the fallback is an ILIKE scan over content_chunks — correct but not
 * index-accelerated. Deployments with heavy CJK corpora should install a
 * CJK-aware FTS extension (pgroonga / zhparser); see
 * docs/guides/multi-language-fts.md.
 */
import type { SearchResult } from '../types.ts';
import { rowToSearchResult } from '../utils.ts';
import { splitCJKQueryTerms } from '../cjk.ts';
import { buildCJKCandidateSql, buildCJKKeywordSql, type CjkKeywordCtx, type CjkKeywordVariant } from '../search/cjk-keyword-sql.ts';
import { scopedRead, type ScopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/** Runs `read` on the engine's scoped read executor. */
export type ScopedReadRunner = <T>(read: (exec: ScopedRead) => Promise<T>) => Promise<T>;

export const CJK_CANDIDATE_CAP = 2000;
export const PGLITE_CJK_CAPPED_CHUNKS = 50_000;
const MIN_ATTEMPT_MS = 50;
/** Held back from each attempt's statement timeout for the cancel round trip and rollback, so the arm ends inside its deadline. */
const ROLLBACK_MARGIN_MS = 40;

/** What the bounded arm did; hybrid turns `incomplete` into the degraded stage. */
export interface CjkKeywordMeta {
  incomplete: boolean;
  reason?: 'timeout' | 'candidate_budget';
  /** The capped candidate stage served the rows. */
  capped: boolean;
  /** Keyword-arm wall time for this call, pool wait included. */
  arm_ms: number;
}

export interface CjkKeywordRun {
  deadlineMs: number;
  onMeta?: (meta: CjkKeywordMeta) => void;
  /** Test and bench seams; production uses CJK_CANDIDATE_CAP and PGLITE_CJK_CAPPED_CHUNKS. */
  candidateCap?: number;
  pgliteCappedChunks?: number;
  /** Full-scoring share of the deadline in ms (default 2/3 of it). */
  fullBudgetMs?: number;
}

type Exec = ScopedRead;

async function rows(exec: Exec, query: string, ctx: CjkKeywordCtx, variant?: CjkKeywordVariant): Promise<Record<string, unknown>[]> {
  const built = buildCJKKeywordSql(query, ctx, variant);
  return built ? (await exec.unsafe(built.sql, built.params)).rows as Record<string, unknown>[] : [];
}

/** Strict AND, then the OR fallback when it falls short of the requested rows. */
async function fullScoring(exec: Exec, query: string, ctx: CjkKeywordCtx, orFallback: boolean): Promise<Record<string, unknown>[]> {
  const strict = await rows(exec, query, ctx);
  return orFallback && strict.length < ctx.limit ? rows(exec, query, ctx, { match: 'any' }) : strict;
}

async function candidates(exec: Exec, query: string, ctx: CjkKeywordCtx, stage: Parameters<typeof buildCJKCandidateSql>[2]): Promise<number[]> {
  const built = buildCJKCandidateSql(query, ctx, stage);
  return built ? (await exec.unsafe(built.sql, built.params)).rows.map(r => Number((r as { chunk_id: unknown }).chunk_id)) : [];
}

/** The capped stage: all-term ids first, partial ids only when the all-term rows fall short. */
async function cappedScoring(exec: Exec, query: string, ctx: CjkKeywordCtx, orFallback: boolean, cap: number): Promise<{ rows: Record<string, unknown>[]; capHit: boolean }> {
  const all = await candidates(exec, query, ctx, { match: 'all', cap });
  const strict = all.length > 0 ? await rows(exec, query, ctx, { candidateIds: all }) : [];
  if (all.length >= cap || !orFallback || strict.length >= ctx.limit) return { rows: strict, capHit: all.length >= cap };
  const room = cap - all.length;
  const partial = await candidates(exec, query, ctx, { match: 'any', cap: room, excludeIds: all });
  if (partial.length === 0) return { rows: strict, capHit: false };
  return { rows: await rows(exec, query, ctx, { match: 'any', candidateIds: [...all, ...partial] }), capHit: partial.length >= room };
}

function isStatementTimeout(e: unknown): boolean {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return err?.code === '57014' || err?.cause?.code === '57014';
}

/**
 * Run `fn` in its own scoped read transaction under a statement timeout. A
 * fired timeout aborts that transaction (the driver rolls it back), so it
 * returns null and the next attempt opens a fresh one with the same source
 * scope.
 */
async function bounded<T>(scoped: ScopedReadRunner, ms: number, fn: (exec: Exec) => Promise<T>): Promise<T | null> {
  ms -= ROLLBACK_MARGIN_MS;
  if (ms < MIN_ATTEMPT_MS) return null;
  const end = performance.now() + ms;
  try {
    return await scoped(async exec => {
      // statement_timeout is per statement and an attempt runs several, so
      // each one gets what is left of the attempt's budget.
      const timed = scopedRead({
        ...exec,
        unsafe: async (sql: string, params: readonly unknown[]) => {
          const left = Math.floor(end - performance.now());
          if (left < 1) throw Object.assign(new Error('cjk keyword attempt budget spent'), { code: '57014' });
          await exec.unsafe(`SELECT set_config('statement_timeout', $1, true)`, [String(left)]);
          return exec.unsafe(sql, params);
        },
      } as SqlExecutor);
      return fn(timed);
    });
  } catch (e) {
    if (isStatementTimeout(e)) return null;
    throw e;
  }
}

async function chunkEstimate(exec: Exec): Promise<number> {
  const [row] = (await exec.unsafe(`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'content_chunks' AND relkind = 'r'`, [])).rows as Array<{ n: unknown }>;
  return Number(row?.n ?? -1);
}

export async function searchKeywordCJK(
  scoped: ScopedReadRunner,
  query: string,
  ctx: CjkKeywordCtx,
  engine: 'postgres' | 'pglite' = 'postgres',
): Promise<SearchResult[]> {
  if (!buildCJKKeywordSql(query, ctx)) return [];
  const started = performance.now();
  const orFallback = ctx.opts?.orFallback === true && splitCJKQueryTerms(query).length > 1;
  const run = ctx.opts?.cjkKeyword;
  if (!run) return (await scoped(exec => fullScoring(exec, query, ctx, orFallback))).map(rowToSearchResult);
  const cap = run.candidateCap ?? CJK_CANDIDATE_CAP;
  const report = (meta: Omit<CjkKeywordMeta, 'arm_ms'>) => run.onMeta?.({ ...meta, arm_ms: Math.round(performance.now() - started) });
  if (engine === 'pglite') {
    const out = await scoped(async exec => {
      if (await chunkEstimate(exec) <= (run.pgliteCappedChunks ?? PGLITE_CJK_CAPPED_CHUNKS)) {
        const full = await fullScoring(exec, query, ctx, orFallback);
        report({ incomplete: false, capped: false });
        return full;
      }
      const capped = await cappedScoring(exec, query, ctx, orFallback, cap);
      report(capped.capHit ? { incomplete: true, reason: 'candidate_budget', capped: true } : { incomplete: false, capped: true });
      return capped.rows;
    });
    return out.map(rowToSearchResult);
  }
  const full = await bounded(scoped, started + (run.fullBudgetMs ?? (run.deadlineMs * 2) / 3) - performance.now(), exec => fullScoring(exec, query, ctx, orFallback));
  if (full) {
    report({ incomplete: false, capped: false });
    return full.map(rowToSearchResult);
  }
  const capped = await bounded(scoped, started + run.deadlineMs - performance.now(), exec => cappedScoring(exec, query, ctx, orFallback, cap));
  report(!capped ? { incomplete: true, reason: 'timeout', capped: true } : capped.capHit ? { incomplete: true, reason: 'candidate_budget', capped: true } : { incomplete: false, capped: true });
  return (capped?.rows ?? []).map(rowToSearchResult);
}
