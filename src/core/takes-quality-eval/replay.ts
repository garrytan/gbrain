/**
 * takes-quality-eval/replay — load a prior receipt without running models.
 *
 * Codex review #10 brain-routing: replay reads disk first (no DB connection
 * required), and explicitly does NOT silently fall through to the DB. If
 * the user passed an explicit receipt path, they expect that file to exist;
 * silent DB fallback hides a missing-file error.
 *
 * For the disk-missing-but-receipt-in-DB case, the caller wants
 * `replayFromDb()` (engine arg) — separate code path, separate user intent.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { TakesQualityReceipt } from './receipt.ts';

/**
 * Read a receipt from disk. The path can be absolute or relative; if just
 * a filename is given, the caller is expected to have already resolved it
 * to an absolute path (via the receipt-name builder).
 */
export function loadReceiptFromDisk(receiptPath: string): TakesQualityReceipt {
  if (!existsSync(receiptPath)) {
    throw new Error(
      `Receipt file not found: ${receiptPath}. ` +
      `If the disk artifact was lost but the run was recorded in DB, ` +
      `use \`gbrain eval takes-quality trend --json\` to find the row and ` +
      `re-export with \`gbrain eval takes-quality replay --from-db <id>\` (v0.33+).`,
    );
  }
  const raw = readFileSync(receiptPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Receipt file is not valid JSON: ${receiptPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Receipt file is not a JSON object: ${receiptPath}`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.schema_version !== 1) {
    throw new Error(
      `Unsupported receipt schema_version=${r.schema_version} (expected 1). ` +
      `Receipt was likely produced by a newer gbrain; upgrade to read it.`,
    );
  }
  return parsed as TakesQualityReceipt;
}

/**
 * Reconstruct a receipt from the DB row's receipt_json column. Used as the
 * explicit fallback path when the disk artifact is gone.
 */
export async function loadReceiptFromDb(
  engine: BrainEngine,
  receiptIdentity: { corpus_sha8: string; prompt_sha8: string; models_sha8: string; rubric_sha8: string },
): Promise<TakesQualityReceipt> {
  const rows = await engine.executeRaw<{ receipt_json: any }>(
    `SELECT receipt_json FROM eval_takes_quality_runs
       WHERE receipt_sha8_corpus = $1
         AND receipt_sha8_prompt = $2
         AND receipt_sha8_models = $3
         AND receipt_sha8_rubric = $4
       LIMIT 1`,
    [
      receiptIdentity.corpus_sha8,
      receiptIdentity.prompt_sha8,
      receiptIdentity.models_sha8,
      receiptIdentity.rubric_sha8,
    ],
  );
  if (rows.length === 0) {
    throw new Error(
      `No DB row matching the requested 4-sha receipt identity. ` +
      `Either the run never persisted or it was pruned.`,
    );
  }
  const json = rows[0].receipt_json;
  if (typeof json === 'string') return JSON.parse(json) as TakesQualityReceipt;
  return json as TakesQualityReceipt;
}
