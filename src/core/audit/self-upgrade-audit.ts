/**
 * Self-upgrade audit trail (v0.42). One JSONL line per self-upgrade decision /
 * outcome at `~/.gbrain/audit/self-upgrade-YYYY-Www.jsonl` (honors
 * GBRAIN_AUDIT_DIR). Built on the shared `audit-writer` primitive. Read back by
 * `gbrain doctor`'s `self_upgrade_health` check. Best-effort: never throws.
 *
 * Privacy: records only versions + outcome + reason. No paths, no content.
 */

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
