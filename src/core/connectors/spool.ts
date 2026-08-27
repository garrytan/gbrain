/**
 * spool.ts — transient spool of fetched conversations in native-export shape.
 *
 * The connector writes fetched conversations to a file shaped exactly like the
 * provider's native export (a top-level JSON array), then hands the path to
 * `runTranscriptsIngest`. The spool holds UNREDACTED text, so it is written
 * 0600 under the 0700 connectors dir and pruned immediately after ingest
 * (`finally` in the orchestrator), not left lying around. Batched writes keep a
 * multi-thousand-thread `--full` backfill memory-bounded and bank progress.
 */

import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectorsDir } from './credentials.ts';
import type { ConnectorProviderName } from './types.ts';

/** Batch size for spool-then-ingest chunking (memory bound on `--full`). */
export const CONNECTOR_SPOOL_BATCH = 200;

export function spoolDir(provider: ConnectorProviderName): string {
  return join(connectorsDir(), 'spool', provider);
}

function ensureSpoolDir(provider: ConnectorProviderName): string {
  const dir = spoolDir(provider);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(join(connectorsDir(), 'spool'), 0o700);
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
  return dir;
}

/**
 * Write a batch of native-export-shaped conversation objects to a spool file
 * (0600) and return its path. `stamp` must be caller-provided (a timestamp or
 * batch ordinal) — this module never reads the clock.
 */
export function writeSpool(
  provider: ConnectorProviderName,
  conversations: Array<Record<string, unknown>>,
  stamp: string,
): string {
  const dir = ensureSpoolDir(provider);
  const target = join(dir, `${stamp}.json`);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(conversations), { mode: 0o600 });
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // best-effort
  }
  return target;
}

/** Delete a single spool file (best-effort; called in the orchestrator finally). */
export function removeSpool(path: string): void {
  try {
    rmSync(path);
  } catch {
    // best-effort
  }
}

/**
 * Prune the provider's spool dir to the newest `keep` files (default 0 = clear
 * all). Filenames are the caller's monotonic stamps, so lexical sort == age.
 */
export function pruneSpool(provider: ConnectorProviderName, keep = 0): number {
  let removed = 0;
  try {
    const dir = spoolDir(provider);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const doomed = keep > 0 ? files.slice(0, Math.max(0, files.length - keep)) : files;
    for (const f of doomed) {
      try {
        rmSync(join(dir, f));
        removed++;
      } catch {
        // best-effort
      }
    }
  } catch {
    // dir missing → nothing to prune
  }
  return removed;
}
