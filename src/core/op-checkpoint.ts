import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { withRetry, BULK_RETRY_OPTS, RetryAbortError } from './retry.ts';

/** Max paths per append-INSERT round-trip; bounds the param-array size. */
const APPEND_CHUNK = 1000;

/**
 * Single writable-CTE statement (one round-trip): ensure the parent
 * op_checkpoints row exists (FK target) and bump its updated_at so the 7-day
 * purge tracks activity, then INSERT the delta child rows. `ON CONFLICT DO
 * NOTHING` makes re-appending an already-banked path a no-op. $3 binds a JS
 * string[] to a Postgres text[] (NOT a jsonb param), which postgres.js + PGLite
 * both handle natively — so it sidesteps executeRawJsonb's array rejection.
 */
const APPEND_PATHS_SQL = `WITH parent AS (
  INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
  VALUES ($1, $2, '[]'::jsonb, now())
  ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at = now()
)
INSERT INTO op_checkpoint_paths (op, fingerprint, path)
SELECT $1, $2, unnest($3::text[])
ON CONFLICT (op, fingerprint, path) DO NOTHING`;

/**
 * v0.42.x (#1794): every checkpoint write routes through the DIRECT session
 * pool (`executeRawDirect`) wrapped in `withRetry(BULK_RETRY_OPTS)`. Rationale:
 * under Supavisor transaction-pooler exhaustion (`EMAXCONNSESSION` / SQLSTATE
 * 53300) the write competes with import workers for the same dead pool. The
 * direct pool bypasses that, and retry rides out the 5-10s recovery window.
 * Returns `true` if the write landed, `false` if it failed after retries (the
 * caller — sync's fail-loud counter — decides whether to abort). A
 * `RetryAbortError` (signal mid-sleep) is re-thrown, NOT counted as a failure.
 */
async function durableWrite(
  engine: BrainEngine,
  key: OpCheckpointKey,
  label: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await withRetry(fn, BULK_RETRY_OPTS);
    return true;
  } catch (e) {
    if (e instanceof RetryAbortError) throw e;
    console.error(`[op-checkpoint] ${label} failed (${key.op}, ${key.fingerprint}):`, (e as Error).message);
    return false;
  }
}

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
    // v0.42.x (#1794): union the new append-only child rows (op_checkpoint_paths)
    // with the legacy `completed_keys` JSONB array (recordCompleted consumers +
    // pre-upgrade rows). UNION ALL — not UNION — because the JS Set below already
    // dedupes, so we skip a server-side dedup sort over up to 204K rows on every
    // resume. `jsonb_array_elements_text` expands the legacy array server-side,
    // which also removes the old postgres.js-vs-PGLite string/array handling.
    //
    // v0.42.x (BUG 3 guard): the legacy arm is gated on
    // `jsonb_typeof(completed_keys) = 'array'`. Without it a non-array (scalar)
    // parent row makes jsonb_array_elements_text throw "cannot extract elements
    // from a scalar", which kills the WHOLE union — including the valid child
    // rows — and loses all checkpoint progress for the key. Skipping the scalar
    // keeps the child rows; the third arm flags the corruption so we log it once
    // (migration v119's CHECK makes this impossible going forward; a hit implies
    // schema drift / disabled constraint / an out-of-band writer).
    const rows = await engine.executeRaw<{ ckey: unknown; corrupt: number }>(
      `SELECT path AS ckey, 0 AS corrupt FROM op_checkpoint_paths
         WHERE op = $1 AND fingerprint = $2
       UNION ALL
       SELECT jsonb_array_elements_text(completed_keys) AS ckey, 0 AS corrupt FROM op_checkpoints
         WHERE op = $1 AND fingerprint = $2 AND jsonb_typeof(completed_keys) = 'array'
       UNION ALL
       SELECT NULL AS ckey, 1 AS corrupt FROM op_checkpoints
         WHERE op = $1 AND fingerprint = $2 AND jsonb_typeof(completed_keys) <> 'array'`,
      [key.op, key.fingerprint],
    );
    const set = new Set<string>();
    let corruptParent = false;
    for (const r of rows) {
      if (Number(r.corrupt) === 1) {
        corruptParent = true;
        continue;
      }
      if (typeof r.ckey === 'string') set.add(r.ckey);
    }
    if (corruptParent) {
      console.error(
        `[op-checkpoint] WARNING: op_checkpoints.completed_keys for (${key.op}, ${key.fingerprint}) is a non-array (scalar) and was skipped to protect the load — child op_checkpoint_paths rows still applied. This implies schema drift, a disabled CHECK constraint, or an out-of-band writer.`,
      );
    }
    return [...set];
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
): Promise<boolean> {
  // REPLACE semantics (kept deliberately — #1794 V3). Callers like
  // extract-conversation-facts serialize a MUTABLE map through here and rely on
  // stale keys being REMOVED; an append would make them unremovable. The full
  // set lands in the parent `completed_keys` JSONB column via a single UPSERT —
  // exactly as before. JSON.stringify into `$3::jsonb` is correct (the text→jsonb
  // cast yields a proper array; NOT the double-encode trap, which is the template
  // form). Sync uses `appendCompleted` (below) instead, never this.
  const sorted = [...keys].sort();
  return durableWrite(engine, key, 'write', () =>
    engine.executeRawDirect(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (op, fingerprint) DO UPDATE
         SET completed_keys = EXCLUDED.completed_keys,
             updated_at     = now()`,
      [key.op, key.fingerprint, JSON.stringify(sorted)],
    ));
}

/**
 * v0.42.x (#1794): ADDITIVE delta append — used ONLY by resumable sync. INSERTs
 * just the new paths into `op_checkpoint_paths` (one row each) instead of
 * rewriting the whole set, killing the O(N²) write amplification of a 204K-file
 * sync. A single writable-CTE statement (one round-trip) ensures the parent
 * `op_checkpoints` row exists (FK target) and bumps its `updated_at` so the
 * 7-day purge tracks activity, then inserts the children. `ON CONFLICT DO
 * NOTHING` makes re-appending an already-banked path a no-op, so a cold resume
 * that re-sends a banked batch costs nothing. Returns false if any chunk's write
 * fails after retries (caller's fail-loud counter decides whether to abort).
 */
export async function appendCompleted(
  engine: BrainEngine,
  key: OpCheckpointKey,
  deltaKeys: string[],
): Promise<boolean> {
  if (deltaKeys.length === 0) return true;
  for (let i = 0; i < deltaKeys.length; i += APPEND_CHUNK) {
    const chunk = deltaKeys.slice(i, i + APPEND_CHUNK);
    const ok = await durableWrite(engine, key, 'append', () =>
      engine.executeRawDirect(APPEND_PATHS_SQL, [key.op, key.fingerprint, chunk]));
    if (!ok) return false;
  }
  return true;
}

/**
 * v0.42.x (#1794): NO-RETRY single-shot variant of appendCompleted for the
 * SIGTERM cleanup path. The process-cleanup registry kills callbacks at a 3s
 * deadline, which is shorter than withRetry's ~12s budget — a retrying flush
 * would be cut off mid-retry and bank nothing. This does ONE direct write of
 * the whole delta (no chunking, no retry) so it banks what it can inside the
 * shutdown window. Best-effort: returns false (logged) on failure.
 */
export async function appendCompletedOnce(
  engine: BrainEngine,
  key: OpCheckpointKey,
  deltaKeys: string[],
): Promise<boolean> {
  if (deltaKeys.length === 0) return true;
  try {
    await engine.executeRawDirect(APPEND_PATHS_SQL, [key.op, key.fingerprint, deltaKeys]);
    return true;
  } catch (e) {
    console.error(`[op-checkpoint] sigterm-append failed (${key.op}, ${key.fingerprint}):`, (e as Error).message);
    return false;
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
  // Delete the parent (FK ON DELETE CASCADE drops the child rows), then a
  // belt-and-suspenders child delete for any rows whose parent was somehow
  // absent. Both routed through the direct pool + retry so a clean-exit clear
  // survives pool exhaustion (a swallowed clear would make the next run skip
  // already-cleared files).
  await durableWrite(engine, key, 'clear', () =>
    engine.executeRawDirect(
      `DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    ));
  await durableWrite(engine, key, 'clear-children', () =>
    engine.executeRawDirect(
      `DELETE FROM op_checkpoint_paths WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    ));
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
 * v0.42.x (#1794) — Fingerprint for resumable incremental `sync`. Completed
 * keys are repo-relative file PATHS (add/modify/delete/rename-to) drained so
 * far; a reserved sentinel entry also carries the pinned target commit (see
 * sync.ts).
 *
 * The key deliberately encodes ONLY `(sourceId, lastCommit)` — NOT the target
 * or live HEAD. `lastCommit` is the anchor, which the resumable sync advances
 * only at full completion, so the fingerprint is stable across every killed-
 * and-resumed run while the backlog (lastCommit..HEAD) grows underneath it.
 * Keying on HEAD would mint a fresh checkpoint each hour as the enrich process
 * commits, defeating resume — the exact bug this fix exists to kill.
 */
export function syncFingerprint(p: { sourceId?: string; lastCommit: string }): string {
  return fingerprint({
    mode: 'sync',
    source: p.sourceId ?? 'default',
    lastCommit: p.lastCommit,
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
    // Delete stale parents; the op_checkpoint_paths FK (ON DELETE CASCADE)
    // drops their child rows automatically. The FK also guarantees no child
    // can exist without a parent, so there are no orphans to sweep separately.
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
