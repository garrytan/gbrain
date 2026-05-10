/**
 * takes-quality-eval/receipt-write — DB-authoritative receipt persistence.
 *
 * Codex review #6 correction: the original two-phase plan ("disk authoritative,
 * DB indexes") had a split-brain failure mode (disk-success/DB-fail vanishes
 * from trend; DB-success/disk-fail unreplayable). The fix: DB is the source
 * of truth, the disk file is a best-effort artifact for grep / replay-without-DB
 * (codex review #10).
 *
 *   - writeReceiptToDb: INSERT into eval_takes_quality_runs with the full
 *     receipt JSON in receipt_json JSONB column. ON CONFLICT DO NOTHING on
 *     the 4-sha unique key (idempotent re-runs).
 *   - writeReceiptArtifact: best-effort disk write at
 *     ~/.gbrain/eval-receipts/<filename>. Failure logs to stderr but does
 *     NOT fail the run (DB row is the durable artifact).
 *
 * The DB write is the gating step for whether `trend` and `regress` see the
 * run; the disk artifact is for portability + grep workflows.
 */
import type { BrainEngine } from '../engine.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TakesQualityReceipt } from './receipt.ts';
import { buildReceiptFilename, buildReceiptPath } from './receipt-name.ts';

/** Insert the full receipt into the DB. Throws on failure (DB is authoritative). */
export async function writeReceiptToDb(engine: BrainEngine, receipt: TakesQualityReceipt): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO eval_takes_quality_runs (
       receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric,
       rubric_version, verdict, overall_score, dim_scores, cost_usd,
       receipt_json, receipt_disk_path, created_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8::jsonb, $9,
       $10::jsonb, $11, $12::timestamptz
     )
     ON CONFLICT (receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric)
     DO NOTHING`,
    [
      receipt.corpus.corpus_sha8,
      receipt.prompt_sha8,
      receipt.models_sha8,
      receipt.rubric_sha8,
      receipt.rubric_version,
      receipt.verdict,
      receipt.overall_score ?? 0,
      JSON.stringify(receipt.scores),
      receipt.cost_usd,
      JSON.stringify(receipt),
      buildReceiptPath({
        corpus_sha8: receipt.corpus.corpus_sha8,
        prompt_sha8: receipt.prompt_sha8,
        models_sha8: receipt.models_sha8,
        rubric_sha8: receipt.rubric_sha8,
      }),
      receipt.ts,
    ],
  );
}

/**
 * Best-effort disk artifact write. Returns the file path on success,
 * undefined on failure (caller logs but doesn't propagate).
 */
export function writeReceiptArtifact(receipt: TakesQualityReceipt): string | undefined {
  const path = buildReceiptPath({
    corpus_sha8: receipt.corpus.corpus_sha8,
    prompt_sha8: receipt.prompt_sha8,
    models_sha8: receipt.models_sha8,
    rubric_sha8: receipt.rubric_sha8,
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', 'utf-8');
    return path;
  } catch (e) {
    process.stderr.write(
      `[eval takes-quality] disk receipt write failed (${e instanceof Error ? e.message : String(e)}); ` +
      `DB row is the source of truth, replay can read receipt_json from there\n`,
    );
    return undefined;
  }
}

/** Convenience: write to DB first (authoritative), then best-effort disk. */
export async function writeReceipt(engine: BrainEngine, receipt: TakesQualityReceipt): Promise<{ db: true; disk_path: string | undefined }> {
  await writeReceiptToDb(engine, receipt);
  const disk_path = writeReceiptArtifact(receipt);
  return { db: true, disk_path };
}

/** Re-export the filename builder so receipt consumers get one import path. */
export { buildReceiptFilename };
