/**
 * Per-operation call counts (plan decision 4, review F5): which operation classes a brain really used, including the
 * calls that were sampled out, shed, run inside a transaction or could not be mirrored. The ledger only holds
 * comparisons, so without this a rare class whose every call was skipped would never appear in `reads.ops`.
 *
 * The wrapper notes each call on a meter (mirror.ts `UsageMeter`, one per process); the serving process appends the counts
 * since its last flush as one JSON line to `<shadow dir>/usage/YYYY-MM-DD.jsonl`, tagged with the evidence epoch that
 * was current then. The child is not involved: a process whose calls were all sampled out spawns none. Append-only, so
 * several serving processes never race on one file, and content-free: operation names and counts only.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonlStrict } from './ledger.ts';
import type { OpUsage } from './mirror.ts';

export interface UsageLine { ts: string; epoch_id: string | null; ops: Record<string, OpUsage> }

export const usageDir = (shadowDir: string): string => join(shadowDir, 'usage');

/** Appends one usage line. Never creates the shadow directory itself: after `stop --delete`, a resident process's late
 * flush must not bring the evidence back (the ledger writers follow the same rule). */
export function appendUsage(shadowDir: string, line: UsageLine): void {
  if (!existsSync(shadowDir)) return;
  mkdirSync(usageDir(shadowDir), { recursive: true, mode: 0o700 });
  appendFileSync(join(usageDir(shadowDir), `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
}

/** Every usage line of `epochId`; [] when no process wrote any, null when a usage file cannot be read whole. */
export function readEpochUsage(shadowDir: string, epochId: string): UsageLine[] | null {
  const dir = usageDir(shadowDir);
  if (!existsSync(dir)) return [];
  const out: UsageLine[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = readJsonlStrict<UsageLine>(join(dir, name));
    if (lines === null) return null;
    for (const l of lines) if (l?.epoch_id === epochId && l.ops && typeof l.ops === 'object') out.push(l);
  }
  return out;
}
