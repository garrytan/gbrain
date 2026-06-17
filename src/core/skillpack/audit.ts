/**
 * skillpack/audit.ts — JSONL audit log for skillpack lifecycle events.
 *
 * Pattern mirrors src/core/audit-slug-fallback.ts + src/core/rerank-audit.ts:
 * ISO-week-rotated JSONL at `~/.gbrain/audit/skillpack-YYYY-Www.jsonl`.
 *
 * One line per scaffold / scaffold-third-party / reference-applied /
 * doctor-run / search event. Best-effort writes — never throws; failures
 * log a stderr warning.
 *
 * `gbrain doctor`'s skillpack_activity check reads the last 7 days to
 * surface "installed N packs in the last week" as info.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

import { gbrainPath } from '../config.ts';

/** Audit event kind. */
export type SkillpackAuditEventKind =
  | 'scaffold_bundled'
  | 'scaffold_third_party'
  | 'reference_applied'
  | 'doctor_run'
  | 'search'
  | 'registry_refresh';

export interface SkillpackAuditEvent {
  /** ISO 8601 timestamp. */
  ts: string;
  /** What happened. */
  event: SkillpackAuditEventKind;
  /** Pack name (when applicable). */
  pack?: string;
  /** Pack version (when applicable). */
  version?: string;
  /** Source URL / path / kebab name (when applicable). */
  source?: string;
  /** Source kind (when applicable). */
  source_kind?: 'git' | 'tarball' | 'local';
  /** Pinned commit / tarball SHA (when applicable). */
  pinned_commit?: string | null;
  tarball_sha256?: string | null;
  /** Tier at the time of the event. */
  tier?: string;
  /** Outcome: 'ok' / 'aborted' / 'error'. */
  outcome: 'ok' | 'aborted' | 'error';
  /** Error summary (when outcome is 'error' or 'aborted'). */
  error?: string;
  /** Optional caller-supplied context (e.g. search query). */
  meta?: Record<string, unknown>;
}

/** Compute ISO-week filename (matches the other audit modules). */
function computeIsoWeekFilename(now: Date = new Date()): string {
  // ISO-week algorithm (Thursday-anchored).
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const yyyy = d.getUTCFullYear();
  const ww = String(weekNo).padStart(2, '0');
  return `skillpack-${yyyy}-W${ww}.jsonl`;
}

/** Resolve the audit directory; honors GBRAIN_AUDIT_DIR. */
function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim()) return override.trim();
  return gbrainPath('audit');
}

/** Append an event. Best-effort: stderr warn on failure, never throws. */
export function logSkillpackEvent(event: Omit<SkillpackAuditEvent, 'ts'>): void {
  try {
    const line: SkillpackAuditEvent = { ts: new Date().toISOString(), ...event };
    const auditDir = resolveAuditDir();
    mkdirSync(auditDir, { recursive: true });
    const file = join(auditDir, computeIsoWeekFilename());
    appendFileSync(file, JSON.stringify(line) + '\n', { encoding: 'utf-8' });
  } catch (err) {
    process.stderr.write(
      `[skillpack-audit] failed to log event (${(err as Error).message}); continuing\n`,
    );
  }
}

/** Read recent events. Used by `gbrain doctor` for the activity surface. */
export function readRecentSkillpackEvents(days: number): SkillpackAuditEvent[] {
  const auditDir = resolveAuditDir();
  if (!existsSync(auditDir)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const events: SkillpackAuditEvent[] = [];
  let files: string[];
  try {
    files = readdirSync(auditDir).filter((f) => f.startsWith('skillpack-') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  for (const f of files) {
    const fullPath = join(auditDir, f);
    try {
      const st = statSync(fullPath);
      // Skip ancient files outright (older than 14d = certainly fully outside the window).
      if (st.mtimeMs < cutoff - 7 * 24 * 60 * 60 * 1000) continue;
    } catch {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }
    for (const rawLine of content.split('\n')) {
      if (!rawLine.trim()) continue;
      try {
        const e = JSON.parse(rawLine) as SkillpackAuditEvent;
        const t = Date.parse(e.ts);
        if (Number.isFinite(t) && t >= cutoff) events.push(e);
      } catch {
        // Skip malformed lines; never throw out of the read path.
      }
    }
  }
  return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** Compute the current audit file path (for tests + doctor's hint output). */
export function currentAuditFilePath(): string {
  return join(resolveAuditDir(), computeIsoWeekFilename());
}

// Exported for testing.
export const _internal = { computeIsoWeekFilename, resolveAuditDir };
