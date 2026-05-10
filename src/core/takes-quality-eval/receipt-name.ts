/**
 * takes-quality-eval/receipt-name — 4-sha receipt-naming contract.
 *
 * Codex review #3 lock: receipt name binds (corpus, prompt, model_set, rubric)
 * shas so two runs over the same corpus + same rubric produce the same key,
 * AND a future rubric tweak produces a different key (no silent corruption
 * of trend graphs).
 *
 * Filename shape:
 *   takes-quality-<corpus_sha8>-<prompt_sha8>-<models_sha8>-<rubric_sha8>.json
 *
 * Stored in ~/.gbrain/eval-receipts/ (best-effort disk artifact). Real
 * source of truth is the eval_takes_quality_runs DB table; the file mirrors
 * the same content for grep workflows + replay-without-DB (codex review
 * #10 brain-routing).
 */
import { createHash } from 'node:crypto';
import { gbrainPath } from '../config.ts';
import { join } from 'node:path';

export interface ReceiptIdentity {
  corpus_sha8: string;
  prompt_sha8: string;
  models_sha8: string;
  rubric_sha8: string;
}

/** Stable 8-char fingerprint over the joined corpus content. */
export function corpusSha8(takesText: string): string {
  return createHash('sha256').update(takesText).digest('hex').slice(0, 8);
}

/**
 * Stable 8-char fingerprint over the model set. Sorted before hashing so
 * (`['a','b']`) and (`['b','a']`) produce the same sha — model order in
 * the slots array doesn't change identity.
 */
export function modelSetSha8(modelIds: readonly string[]): string {
  const canonical = JSON.stringify([...modelIds].sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/** Build the receipt filename (no path, no extension stripping). */
export function buildReceiptFilename(id: ReceiptIdentity): string {
  return `takes-quality-${id.corpus_sha8}-${id.prompt_sha8}-${id.models_sha8}-${id.rubric_sha8}.json`;
}

/** Full disk path under ~/.gbrain/eval-receipts/<filename>. */
export function buildReceiptPath(id: ReceiptIdentity): string {
  return join(gbrainPath('eval-receipts'), buildReceiptFilename(id));
}

/** Strip the receipt directory + extension to recover identity components. */
export function parseReceiptFilename(filename: string): ReceiptIdentity | null {
  // Example: takes-quality-abcd1234-abcd1234-abcd1234-abcd1234.json
  const m = filename.match(
    /^takes-quality-([0-9a-f]{8})-([0-9a-f]{8})-([0-9a-f]{8})-([0-9a-f]{8})\.json$/,
  );
  if (!m) return null;
  return {
    corpus_sha8: m[1]!,
    prompt_sha8: m[2]!,
    models_sha8: m[3]!,
    rubric_sha8: m[4]!,
  };
}
