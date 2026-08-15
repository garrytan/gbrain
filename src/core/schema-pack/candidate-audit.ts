// v0.38 candidate-type audit — privacy-redacted by default.
//
// When a `put_page` lands with a type not in the active pack (lenient
// mode), this audit log records the encounter so users can later run
// `gbrain schema review-candidates` and decide promote/rename/ignore.
//
// Privacy contract (T12 codex finding + pass-3 hardening):
//   - `type` field: SHA-8 redacted by default. Therapy-session,
//     adversary-profile, and hater-dossier leak diagnostic categories.
//     Opt in to full type names with `GBRAIN_SCHEMA_AUDIT_VERBOSE=1`.
//   - `slug_prefix`: first path segment only (e.g. `personal/`, NOT
//     `personal/therapy/2025-03-15-session-12.md`).
//   - `frontmatter_keys`: list of key NAMES only; never values.
//   - `count`: rollup counter.
//
// Rotation: ISO-week aware JSONL, same pattern as
// `src/core/audit-slug-fallback.ts` (v0.32.7). Path:
// `~/.gbrain/audit/schema-candidates-YYYY-Www.jsonl`. Honors
// `GBRAIN_AUDIT_DIR` env override.
//
// Best-effort writes: stderr warn on disk failure, NEVER throws. The
// brain stays usable even when audit is unwritable.

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuditDir } from '../minions/handlers/shell-audit.ts';

/**
 * Candidate audit record. The fields below are the entire surface
 * written to disk — never extend with PII without an explicit opt-in
 * env var.
 */
export interface CandidateAuditRecord {
  /** ISO 8601 timestamp. */
  ts: string;
  /** SHA-8 of type name by default; full string when verbose env set. */
  type_or_hash: string;
  /** Whether `type_or_hash` is the raw type (verbose) or a sha8 hash. */
  type_redacted: boolean;
  /** First path segment only, e.g. 'personal' not 'personal/therapy/...'. */
  slug_prefix: string;
  /** Names of frontmatter keys present on the page. Values NEVER logged. */
  frontmatter_keys: string[];
  /** Rolling counter — useful for `gbrain schema review-candidates` ordering. */
  count: number;
  /** Pack the page was written against (for cross-pack drift detection). */
  pack_identity: string;
}

export interface LogCandidateOpts {
  type: string;
  slug: string;
  frontmatterKeys: string[];
  packIdentity: string;
  /** Existing count for this type, if known (else 1). */
  count?: number;
}

export function isAuditVerbose(): boolean {
  return process.env.GBRAIN_SCHEMA_AUDIT_VERBOSE === '1';
}

export function computeIsoWeekName(date: Date = new Date()): string {
  // ISO week date, mirrors audit-slug-fallback.ts pattern.
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function computeCandidateAuditPath(date: Date = new Date()): string {
  const auditDir = resolveAuditDir();
  return join(auditDir, `schema-candidates-${computeIsoWeekName(date)}.jsonl`);
}

async function sha8(value: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Log a candidate-type event. Best-effort: stderr warn on failure but
 * never throws. Used by put_page handler when a type isn't in the active
 * pack and lenient-mode is active.
 */
export async function logCandidate(opts: LogCandidateOpts): Promise<void> {
  const verbose = isAuditVerbose();
  const typeField = verbose ? opts.type : await sha8(opts.type);
  const slugPrefix = opts.slug.split('/')[0] ?? '';
  const record: CandidateAuditRecord = {
    ts: new Date().toISOString(),
    type_or_hash: typeField,
    type_redacted: !verbose,
    slug_prefix: slugPrefix,
    frontmatter_keys: opts.frontmatterKeys.slice().sort(),
    count: opts.count ?? 1,
    pack_identity: opts.packIdentity,
  };
  const path = computeCandidateAuditPath();
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    process.stderr.write(`[schema-candidates-audit] write failed: ${(e as Error).message}\n`);
  }
}

/**
 * Read recent candidate audit entries across the last N weeks. Consumed by
 * `gbrain schema review-candidates`. Returns rows in disk order (chronological
 * per file). Future implementation will aggregate by type_or_hash.
 */
export function readRecentCandidates(daysBack = 30): CandidateAuditRecord[] {
  const auditDir = resolveAuditDir();
  if (!existsSync(auditDir)) return [];
  const cutoffMs = Date.now() - daysBack * 86400 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const records: CandidateAuditRecord[] = [];
  for (const name of readdirSync(auditDir)) {
    if (!name.startsWith('schema-candidates-') || !name.endsWith('.jsonl')) continue;
    try {
      const content = readFileSync(join(auditDir, name), 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as CandidateAuditRecord;
          if (r.ts >= cutoffIso) records.push(r);
        } catch {
          // Skip malformed lines silently — audit is best-effort.
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  return records;
}
