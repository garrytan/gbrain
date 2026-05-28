import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';

/**
 * Shared checkpoint primitive for long-running ops (embed, extract, lint,
 * backlinks, reindex, integrity, import).
 *
 * Pre-v0.36 each op had its own file-backed checkpoint or no checkpoint at
 * all. Three bug classes died with this module:
 *
 *   1. **Param-shape collisions.** `extract links` and `extract timeline`
 *      walked the same files but shared a single checkpoint, so a killed
 *      `links` run made `timeline` skip files (codex #11). `reindex
 *      --markdown` and `reindex --code` had the same issue. Fix: every
 *      checkpoint is keyed by `(op, fingerprint)` where fingerprint is
 *      sha8 of canonical-JSON of the relevant params per op.
 *
 *   2. **Multi-worker host blindness.** File-backed `~/.gbrain/...`
 *      checkpoints don't work when the Minion worker resumes on a
 *      different container or host (codex #16). DB-backed via
 *      `op_checkpoints` table (migration v67) is the source of truth;
 *      cross-host workers read the same row.
 *
 *   3. **Stale-row corruption window.** Per-op JSONL append-only files
 *      (integrity's pre-v0.36 path) corrupted on partial writes. JSONB
 *      column with single UPSERT is atomic.
 *
 * GC: cycle's `purge` phase drops rows older than 7 days where the op
 * completed cleanly. Bounded growth, no operator action required.
 *
 * @example Embed: per-chunk checkpoint keyed by model+dim variation
 *   const key = {
 *     op: 'embed',
 *     fingerprint: embedFingerprint({
 *       stale: true,
 *       source: 'default',
 *       embedding_model: 'openai:text-embedding-3-large',
 *       embedding_dimensions: 3072,
 *     }),
 *   };
 *   const done = new Set(await loadOpCheckpoint(engine, key));
 *   for (const chunk of allChunks) {
 *     if (done.has(chunk.id)) continue;
 *     await embed(chunk);
 *     done.add(chunk.id);
 *     if (done.size % 100 === 0) {
 *       await recordCompleted(engine, key, [...done]);
 *     }
 *   }
 *   await clearOpCheckpoint(engine, key);  // success exit
 */
export interface OpCheckpointKey {
  /** Op name; one of: 'embed', 'extract', 'lint', 'backlinks', 'reindex', 'integrity', 'import'. */
  op: string;
  /** sha8 of canonical-JSON of relevant params. See *Fingerprint functions below. */
  fingerprint: string;
}

/**
 * Load completed keys for an op invocation. Empty array when no checkpoint
 * exists yet (first run, or after `clearOpCheckpoint`).
 *
 * Non-fatal on DB errors — returns `[]` and logs to stderr. The op then
 * re-walks from zero, which is cheap for content-hash-short-circuited ops
 * (embed checks `embedded_at`, import checks `content_hash`).
 */
export async function loadOpCheckpoint(
  engine: BrainEngine,
  key: OpCheckpointKey,
): Promise<string[]> {
  try {
    const rows = await engine.executeRaw<{ completed_keys: unknown }>(
      `SELECT completed_keys FROM op_checkpoints
       WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    );
    if (rows.length === 0) return [];
    const raw = rows[0]?.completed_keys;
    // postgres.js returns JSONB as JS arrays; PGLite returns strings. Handle both.
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch (e) {
    console.error(`[op-checkpoint] load failed (${key.op}, ${key.fingerprint}):`, (e as Error).message);
    return [];
  }
}

/**
 * Persist the completed-keys set. Caller chooses cadence (typical: every
 * 100 successful items). Atomic UPSERT; PRIMARY KEY (op, fingerprint)
 * makes ON CONFLICT a single-row DO UPDATE.
 *
 * Non-fatal on DB errors — logs and continues. Lost checkpoint just means
 * re-walk on next run, which is cheap for hash-short-circuited ops.
 */
export async function recordCompleted(
  engine: BrainEngine,
  key: OpCheckpointKey,
  keys: string[],
): Promise<void> {
  try {
    // Sorted serialization keeps diff-based debug output stable and tests
    // deterministic across insertion order shuffles.
    const sorted = [...keys].sort();
    await engine.executeRaw(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (op, fingerprint) DO UPDATE
         SET completed_keys = EXCLUDED.completed_keys,
             updated_at     = now()`,
      [key.op, key.fingerprint, JSON.stringify(sorted)],
    );
  } catch (e) {
    console.error(`[op-checkpoint] write failed (${key.op}, ${key.fingerprint}):`, (e as Error).message);
    /* non-fatal: lost checkpoint just means re-walk on next run */
  }
}

/**
 * Drop the checkpoint after a clean exit. Idempotent; missing row is a
 * no-op.
 *
 * Cycle's `purge` phase ALSO sweeps stale rows on a 7-day TTL, so callers
 * that crash without reaching this won't leak forever.
 */
export async function clearOpCheckpoint(
  engine: BrainEngine,
  key: OpCheckpointKey,
): Promise<void> {
  try {
    await engine.executeRaw(
      `DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    );
  } catch (e) {
    console.error(`[op-checkpoint] clear failed (${key.op}, ${key.fingerprint}):`, (e as Error).message);
    /* non-fatal */
  }
}

/**
 * Filter `all` to elements not in the completed set. Pure function — no
 * fs/db access — so consumers can drive batched processing without
 * round-tripping the DB per item.
 *
 * ```
 * const done = await loadOpCheckpoint(engine, key);
 * const pending = resumeFilter(allFiles, done);
 * for (const file of pending) { await process(file); }
 * ```
 */
export function resumeFilter(all: string[], completed: string[]): string[] {
  if (completed.length === 0) return all;
  const done = new Set(completed);
  return all.filter((k) => !done.has(k));
}

// ---------------------------------------------------------------------------
// Fingerprint helpers — one per op. The fingerprint MUST encode every param
// that produces a different processing decision per item. Two invocations
// with different fingerprints get separate checkpoints; two with identical
// fingerprints share one. Pick the dimensions deliberately.
// ---------------------------------------------------------------------------

/**
 * Stable sha8 over the canonical-JSON of `params`. Same input → same hash
 * across runs and across hosts. Stringify with sorted keys so a reorder of
 * object literals doesn't flip the fingerprint.
 */
export function fingerprint(params: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex').slice(0, 8);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * Fingerprint for `embed`. Completed keys are chunk ids (string).
 *
 * Why these dims: re-embedding the same chunk with a different model or
 * different dim produces a fundamentally different vector — they MUST be
 * separate checkpoint rows so a switch from openai:3-large@1536 to
 * voyage-3@1024 doesn't reuse the prior run's "done" set (codex #15).
 *
 * `slug` matters when `embed --slug X` re-embeds one page; a slug-scoped
 * run shares no work with the brain-wide `--stale` run.
 */
export function embedFingerprint(p: {
  stale?: boolean;
  all?: boolean;
  slug?: string;
  source?: string;
  embedding_model: string;
  embedding_dimensions: number;
}): string {
  return fingerprint({
    stale: p.stale ?? false,
    all: p.all ?? false,
    slug: p.slug ?? null,
    source: p.source ?? 'default',
    embedding_model: p.embedding_model,
    embedding_dimensions: p.embedding_dimensions,
  });
}

/**
 * Fingerprint for `extract`. Modes (`links` vs `timeline` vs `all`) walk
 * the same files but produce different DB writes — they need separate
 * checkpoints so killing a `links` run mid-walk doesn't make `timeline`
 * skip the un-walked files (codex #11).
 */
export function extractFingerprint(p: {
  mode: 'links' | 'timeline' | 'all';
  source?: string;
  dir?: string;
}): string {
  return fingerprint({
    mode: p.mode,
    source: p.source ?? 'default',
    dir: p.dir ?? null,
  });
}

/**
 * Fingerprint for `reindex`. `--markdown`, `--code`, and `--slug X` walk
 * different page-kind subsets; each needs its own checkpoint (codex #12).
 *
 * `chunker_version` bumps invalidate the previous run's set because the
 * new shape will rewrite chunks even on previously-completed pages.
 */
export function reindexFingerprint(p: {
  markdown?: boolean;
  code?: boolean;
  slug?: string;
  chunker_version: number;
}): string {
  return fingerprint({
    markdown: p.markdown ?? false,
    code: p.code ?? false,
    slug: p.slug ?? null,
    chunker_version: p.chunker_version,
  });
}

/**
 * Fingerprint for `lint`. Auto-fix vs check-only walk the same files but
 * produce different side effects — keep them separate.
 */
export function lintFingerprint(p: { dir: string; fix?: boolean }): string {
  return fingerprint({ dir: p.dir, fix: p.fix ?? false });
}

/**
 * Fingerprint for `backlinks`. `check` vs `fix` modes; same files, different
 * side effects.
 */
export function backlinksFingerprint(p: { dir: string; action: 'check' | 'fix' }): string {
  return fingerprint({ dir: p.dir, action: p.action });
}

/**
 * Fingerprint for `integrity`. Mode + confidence threshold both shape the
 * per-page processing decision.
 */
export function integrityFingerprint(p: {
  mode: 'check' | 'auto';
  confidence?: number;
}): string {
  return fingerprint({
    mode: p.mode,
    confidence: p.confidence ?? 0.85,
  });
}

/**
 * Fingerprint for `import`. Source dir + per-import options uniquely
 * identify the run. Used by the import-checkpoint shim.
 */
export function importFingerprint(p: {
  dir: string;
  noEmbed?: boolean;
  source?: string;
}): string {
  return fingerprint({
    dir: p.dir,
    noEmbed: p.noEmbed ?? false,
    source: p.source ?? 'default',
  });
}

/**
 * v0.41.19.0 — Fingerprint for `extract --by-mention`. The mode is
 * materially different from `extract links/timeline/all` (different
 * SQL, different write semantics), so it gets its own fingerprint
 * space rather than sharing extractFingerprint.
 *
 * Filters narrow the scan universe AND the gazetteer hash narrows the
 * matching universe; both belong in the fingerprint so adding new
 * entity pages between paused runs invalidates the checkpoint cleanly
 * (codex caught the omission — without gazetteer in the key, resumed
 * pages would skip new entities silently).
 */
export function mentionsFingerprint(p: {
  source?: string;
  type?: string;
  since?: string;
  gazetteerHash: string;
}): string {
  return fingerprint({
    mode: 'by_mention',
    source: p.source ?? 'default',
    type: p.type ?? null,
    since: p.since ?? null,
    gazetteer: p.gazetteerHash,
  });
}

/**
 * Cycle's purge phase calls this to drop stale checkpoints. 7-day TTL is
 * deliberately generous — any reasonable long-running op finishes inside
 * that window, and the row is cheap (few KB).
 */
export async function purgeStaleCheckpoints(
  engine: BrainEngine,
  ttlDays = 7,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM op_checkpoints
         WHERE updated_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(ttlDays)],
    );
    return Number(rows[0]?.count ?? 0);
  } catch (e) {
    console.error('[op-checkpoint] purge failed:', (e as Error).message);
    return 0;
  }
}
