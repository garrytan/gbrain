/**
 * #6696 (A7): before a managed sync's first admission, its remaining manifest
 * entries (one request id each, and the admission reservation estimator over
 * each file's size and the writer authority) must fit the capacity left under
 * the caller's line: the background pause for a background run, the cap for an
 * operator's. A shortfall refuses `write_quota_insufficient` (writes still work)
 * with the raise that covers the run; the refusal is marked `capacityPreflight`
 * so the drain stops the command instead of pausing it (`capacity_paused`).
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { readBackgroundPauseShare, resolveAdmissionOrigin } from './admission-origin.ts';
import { jsonBytes } from './digest.ts';
import { assertWriteHeadroom } from './journal.ts';
import type { Principal } from './model.ts';
import { reservationForRetained } from './receipt-bytes.ts';

/** An intent's fields beside the file content (kind, paths, hashes, revision), estimated. */
const PREFLIGHT_INTENT_FIELDS_BYTES = 512;

export async function preflightSyncCapacity(engine: BrainEngine, run: { root: string; writer: { principal: Principal };
  entries: ReadonlyArray<{ path: string; action: 'import' | 'delete' }> }): Promise<void> {
  if (!run.entries.length) return;
  const authority = jsonBytes(run.writer);
  const size = (path: string) => { try { return statSync(resolve(run.root, path)).size; } catch { return 0; } };
  const bytes = run.entries.reduce((n, entry) => n + reservationForRetained(authority + PREFLIGHT_INTENT_FIELDS_BYTES + (entry.action === 'import' ? size(entry.path) : 0)), 0);
  const share = resolveAdmissionOrigin() === 'background' ? await readBackgroundPauseShare(engine) : 1;
  try { await assertWriteHeadroom(engine, run.writer.principal, { ids: run.entries.length, bytes }, share); }
  catch (error) { throw Object.assign(error as object, { capacityPreflight: true as const }); }
}
