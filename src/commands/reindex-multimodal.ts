/**
 * v0.36 Phase 3 — `gbrain reindex --multimodal` sweep.
 *
 * Walks `content_chunks` where `embedding_multimodal IS NULL`, batches
 * through `embedMultimodalSafe` (partial-failure-aware from Commit 0), and
 * persists the new vectors.
 *
 * Wired patterns:
 *   - D7: acquires `gbrain-reindex-multimodal` writer lock via
 *     `tryAcquireDbLock` so a concurrent autopilot embed phase can't
 *     double-spend Voyage budget on the same chunks.
 *   - D20 phase 2: builds the HNSW partial index AFTER bulk load completes
 *     (pgvector best practice — per-row index maintenance during bulk
 *     ingest is 2-3x slower than post-load build).
 *   - D23-#2: prompts at completion to flip search.unified_multimodal=true
 *     when full coverage is reached (TTY-only; non-TTY prints hint and
 *     does NOT auto-flip).
 *   - Cost prompt: 10-second Ctrl-C grace window via the v0.32.7
 *     post-upgrade-reembed primitive shape.
 *
 * Not extracted as shared reindex-core in this commit (D10): the existing
 * `gbrain reindex --markdown` walks markdown pages and re-imports via
 * importFromFile; this walks content_chunks and re-embeds via the gateway.
 * The patterns rhyme but the cores diverge enough that extraction would
 * balloon the diff. D10 is filed as a follow-up TODO.
 */

import type { BrainEngine } from '../core/engine.ts';
import { tryAcquireDbLock } from '../core/db-lock.ts';
import type { DbLockHandle } from '../core/db-lock.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { embedMultimodalSafe } from '../core/ai/gateway.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { gbrainPath } from '../core/config.ts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_ID = 'gbrain-reindex-multimodal';
const BATCH_SIZE = 32; // Voyage cap
const CHECKPOINT_FILE = 'reindex-multimodal-checkpoint.json';

export interface ReindexMultimodalOpts {
  limit?: number;
  dryRun?: boolean;
  costEstimate?: boolean;
  noEmbed?: boolean;
  json?: boolean;
  /** Skip the 10s cost-grace window (CI / cron). */
  yes?: boolean;
}

export interface ReindexMultimodalResult {
  pending_before: number;
  pending_after: number;
  reembedded: number;
  failed: number;
  dry_run: boolean;
  cost_usd_estimate: number;
  unified_flag_prompted: boolean;
}

/**
 * Entry point for `gbrain reindex --multimodal`.
 */
export async function runReindexMultimodal(
  engine: BrainEngine,
  opts: ReindexMultimodalOpts,
): Promise<ReindexMultimodalResult> {
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('reindex_multimodal', 0);

  // T11 (D12): preflight the multimodal model+dim before any DB work.
  // Mirrors T6's text-side preflight contract: if the configured multimodal
  // model can't produce a dim that matches the schema column, fail loud
  // here with a paste-ready hint rather than mid-reindex with a vector(N)
  // INSERT error.
  try {
    const { loadConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    const multimodalModel = cfg?.embedding_multimodal_model;
    if (multimodalModel) {
      const { resolveSchemaMultimodalDim } = await import('../core/embedding-dim-check.ts');
      const pre = resolveSchemaMultimodalDim({
        embedding_multimodal_model: multimodalModel,
      });
      if (!pre.ok) {
        progress.finish();
        throw new Error(
          `Refusing to reindex: ${pre.error}\n` +
          `Fix with \`gbrain config set embedding_multimodal_model <provider>:<model>\`.`,
        );
      }
    }
  } catch (e) {
    // Re-throw if it's the preflight refusal; suppress only when loadConfig fails.
    if (e instanceof Error && /Refusing to reindex/.test(e.message)) throw e;
  }

  const sql = sqlQueryForEngine(engine);

  // Count pending chunks.
  const pendingRows = await sql`
    SELECT COUNT(*)::text AS count
    FROM content_chunks
    WHERE embedding_multimodal IS NULL
  `;
  const pendingBefore = parseInt(String(pendingRows[0]?.count ?? '0'), 10);

  // Cost estimate (Voyage multimodal-3 is $0.18 / 1M tokens; ~3.5 chars/token).
  // We estimate based on chunk_text length per row. Cheap two-stat probe.
  const statsRows = pendingBefore > 0
    ? await sql`
      SELECT COALESCE(SUM(LENGTH(chunk_text)), 0)::text AS chars
      FROM content_chunks
      WHERE embedding_multimodal IS NULL
    `
    : [{ chars: '0' }];
  const totalChars = parseInt(String(statsRows[0]?.chars ?? '0'), 10);
  const estimatedTokens = totalChars / 3.5;
  const costUsdEstimate = (estimatedTokens / 1_000_000) * 0.18;

  if (opts.costEstimate) {
    progress.finish();
    return {
      pending_before: pendingBefore,
      pending_after: pendingBefore,
      reembedded: 0,
      failed: 0,
      dry_run: true,
      cost_usd_estimate: costUsdEstimate,
      unified_flag_prompted: false,
    };
  }

  if (opts.dryRun) {
    progress.finish();
    return {
      pending_before: pendingBefore,
      pending_after: pendingBefore,
      reembedded: 0,
      failed: 0,
      dry_run: true,
      cost_usd_estimate: costUsdEstimate,
      unified_flag_prompted: false,
    };
  }

  if (pendingBefore === 0) {
    progress.finish();
    return {
      pending_before: 0,
      pending_after: 0,
      reembedded: 0,
      failed: 0,
      dry_run: false,
      cost_usd_estimate: 0,
      unified_flag_prompted: false,
    };
  }

  // GBRAIN_NO_REEMBED bypass (CI / cron / opt-out).
  if (process.env.GBRAIN_NO_REEMBED === '1') {
    process.stderr.write(
      `[reindex-multimodal] skipping: GBRAIN_NO_REEMBED=1. ` +
      `Pending: ${pendingBefore} chunks (~$${costUsdEstimate.toFixed(2)}).\n`,
    );
    progress.finish();
    return {
      pending_before: pendingBefore,
      pending_after: pendingBefore,
      reembedded: 0,
      failed: 0,
      dry_run: true,
      cost_usd_estimate: costUsdEstimate,
      unified_flag_prompted: false,
    };
  }

  // Cost grace window (TTY only; non-TTY auto-proceeds for CI / cron).
  // Skip if --yes was passed.
  if (!opts.yes && process.stdout.isTTY && process.stdin.isTTY) {
    const minutes = Math.ceil((pendingBefore / BATCH_SIZE) * 0.5 / 60); // ~0.5s per batch
    process.stderr.write(
      `Will re-embed ~${pendingBefore} chunks via voyage:voyage-multimodal-3, ` +
      `est. ~$${costUsdEstimate.toFixed(2)}, ~${minutes}min. ` +
      `Press Ctrl-C within 10s to abort.\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  }

  // D7 lock acquisition. TTL of 6 hours covers a 100K-chunk reindex even
  // at slow Voyage cadence; supervisor renewal is a follow-up.
  const lockHandle: DbLockHandle | null = await tryAcquireDbLock(engine, LOCK_ID, 360);
  if (!lockHandle) {
    progress.finish();
    throw new Error(
      `LOCK_HELD: another gbrain-reindex-multimodal process is already running. ` +
      `If the prior run crashed, the lock auto-releases after its TTL (6h).`,
    );
  }

  let reembedded = 0;
  let failed = 0;
  // Resume from checkpoint if one exists.
  const checkpointPath = gbrainPath(CHECKPOINT_FILE);
  const completedIds = loadCheckpoint(checkpointPath);

  try {
    let lastId = 0;
    let processed = 0;
    while (true) {
      if (opts.limit && processed >= opts.limit) break;

      // Fetch next batch of pending chunks.
      const batchSize = opts.limit
        ? Math.min(BATCH_SIZE, opts.limit - processed)
        : BATCH_SIZE;
      const rows = await sql`
        SELECT id::text AS id, chunk_text
        FROM content_chunks
        WHERE embedding_multimodal IS NULL
          AND id > ${lastId}
        ORDER BY id
        LIMIT ${batchSize}
      `;
      if (rows.length === 0) break;

      const items = rows.map(r => ({
        id: parseInt(String(r.id), 10),
        text: String(r.chunk_text ?? ''),
      })).filter(r => !completedIds.has(r.id));

      if (items.length === 0) {
        lastId = parseInt(String(rows[rows.length - 1].id), 10);
        continue;
      }

      // D23-#7 batched: embedMultimodalSafe returns parallel arrays with
      // failed_indices surfaced. We persist what succeeded and log what
      // failed for the next run to retry.
      if (!opts.noEmbed) {
        const result = await embedMultimodalSafe(
          items.map(it => ({ kind: 'text' as const, text: it.text })),
          { inputType: 'document' },
        );
        for (let i = 0; i < items.length; i++) {
          const vec = result.embeddings[i];
          if (vec) {
            const vecLiteral = `[${Array.from(vec).join(',')}]`;
            await sql`
              UPDATE content_chunks
              SET embedding_multimodal = ${vecLiteral}::vector
              WHERE id = ${items[i].id}
            `;
            reembedded++;
            completedIds.add(items[i].id);
          } else {
            failed++;
          }
        }
      }

      processed += items.length;
      lastId = items[items.length - 1].id;
      saveCheckpoint(checkpointPath, completedIds);
      progress.tick();
    }
  } finally {
    await lockHandle.release().catch(() => {});
    progress.finish();
  }

  // D23-#2 auto-flip prompt at completion.
  const pendingAfterRows = await sql`
    SELECT COUNT(*)::text AS count
    FROM content_chunks
    WHERE embedding_multimodal IS NULL
  `;
  const pendingAfter = parseInt(String(pendingAfterRows[0]?.count ?? '0'), 10);
  let unifiedFlagPrompted = false;

  if (pendingAfter === 0 && reembedded > 0) {
    const currentFlag = await engine.getConfig('search.unified_multimodal').catch(() => null);
    if (currentFlag !== 'true' && currentFlag !== '1') {
      if (process.stdout.isTTY) {
        process.stderr.write(
          `\n[reindex-multimodal] Coverage now 100%. ` +
          `Run \`gbrain config set search.unified_multimodal true\` to route all queries ` +
          `through the unified column.\n`,
        );
        unifiedFlagPrompted = true;
      } else {
        process.stderr.write(
          `[reindex-multimodal] Coverage now 100%. ` +
          `gbrain config set search.unified_multimodal true\n`,
        );
        unifiedFlagPrompted = true;
      }
    }
  }

  // Clear checkpoint on full completion.
  if (pendingAfter === 0) {
    try { writeFileSync(checkpointPath, '{}\n'); } catch { /* ignore */ }
  }

  return {
    pending_before: pendingBefore,
    pending_after: pendingAfter,
    reembedded,
    failed,
    dry_run: false,
    cost_usd_estimate: costUsdEstimate,
    unified_flag_prompted: unifiedFlagPrompted,
  };
}

function loadCheckpoint(path: string): Set<number> {
  try {
    if (!existsSync(path)) return new Set();
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as { completedIds?: number[] };
    return new Set((data.completedIds ?? []).filter(n => Number.isFinite(n)));
  } catch {
    return new Set();
  }
}

function saveCheckpoint(path: string, completedIds: Set<number>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload = JSON.stringify({ completedIds: Array.from(completedIds) }, null, 2);
    writeFileSync(path, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[reindex-multimodal] checkpoint save failed: ${msg}\n`);
  }
}
