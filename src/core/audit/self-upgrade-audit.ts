/**
 * Self-upgrade audit trail (v0.42). One JSONL line per self-upgrade decision /
 * outcome at `~/.gbrain/audit/self-upgrade-YYYY-Www.jsonl` (honors
 * GBRAIN_AUDIT_DIR). Built on the shared `audit-writer` primitive. Read back by
 * `gbrain doctor`'s `self_upgrade_health` check. Best-effort: never throws.
 *
 * Privacy: records only versions + outcome + reason. No paths, no content.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAuditWriter } from './audit-writer.ts';

export interface SelfUpgradeAuditEvent {
  ts: string;
  /** Which channel made the decision. */
  channel: 'invocation' | 'autopilot';
  /** The SelfUpgradeAction (`apply` / `notify` / `busy` / ...). */
  action: string;
  current: string;
  latest?: string | null;
  /** Terminal outcome when an apply was attempted. */
  outcome?: 'applied' | 'failed' | 'skipped';
  reason?: string;
  error?: string;
}

const writer = createAuditWriter<SelfUpgradeAuditEvent>({
  featureName: 'self-upgrade',
  errorLabel: 'self-upgrade-audit',
  errorTrailer: '; continuing',
});

export function logSelfUpgrade(event: Omit<SelfUpgradeAuditEvent, 'ts'> & { ts?: string }): void {
  writer.log(event);
}

export function readRecentSelfUpgrades(days = 7, now?: Date): SelfUpgradeAuditEvent[] {
  return writer.readRecent(days, now);
}

export function selfUpgradeAuditFilename(now?: Date): string {
  return writer.computeFilename(now);
}

/**
 * #6828: every retained self-upgrade audit row, in ts order (all weekly files,
 * not the 2-week `readRecent` window): the known-bad recovery needs the swap
 * that recorded an entry, however old. Corrupt rows are skipped.
 */
export function readAllSelfUpgrades(): SelfUpgradeAuditEvent[] {
  const dir = writer.resolveDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^self-upgrade-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out: SelfUpgradeAuditEvent[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as SelfUpgradeAuditEvent;
        if (typeof ev.ts === 'string') out.push(ev);
      } catch {
        /* corrupt row */
      }
    }
  }
  return out.toSorted((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
