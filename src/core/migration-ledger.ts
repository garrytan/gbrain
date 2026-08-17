/**
 * Migration-ledger summary — the read-only "what host migrations are
 * outstanding" view, shared by the get_health op (TODOS:4063: remote agents
 * detect wedged migrations without SSH-ing to run the doctor) and the
 * apply-migrations orchestrator (which imports statusForVersion +
 * compareVersions from here).
 *
 * OV4/EV4 (CLI→MCP gap-closure wave): an op must never import
 * src/commands/apply-migrations.ts — that module statically pulls the whole
 * migration registry (17 migration modules plus orchestrator machinery). This
 * module works on VERSION STRINGS ONLY: MIGRATION_VERSIONS below is a plain
 * string list, pinned against the real registry by
 * test/migration-ledger.test.ts so it cannot drift silently.
 */

import { loadCompletedMigrations, type CompletedMigrationEntry } from './preferences.ts';

/**
 * Version strings of every registered host migration, in registry order.
 * APPEND HERE when adding a migration module to src/commands/migrations/
 * (the sync test fails the suite otherwise).
 */
export const MIGRATION_VERSIONS: readonly string[] = [
  '0.11.0', '0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0',
  '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0',
  '0.32.2', '0.43.0', '0.46.3',
];

/** Bug 3 attempt cap — consecutive partials before a version counts wedged. */
export const MAX_CONSECUTIVE_PARTIALS = 3;

/**
 * Compare two semver strings (MAJOR.MINOR.PATCH). Returns -1 / 0 / 1.
 * Canonical home (moved from src/commands/migrations/index.ts, which
 * re-exports it); originally extracted from upgrade.ts#isNewerThan.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = a.split('.').map(n => parseInt(n, 10) || 0);
  const vb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export type MigrationLedgerStatus = 'complete' | 'partial' | 'pending' | 'wedged';

/**
 * Resolved status for a migration version given its ledger entries.
 *
 * Semantics (Bug 3 — keep "complete wins" safety):
 *   - If the latest entry is `retry`, the version is pending. This is the
 *     explicit escape hatch written by a forced retry, and it overrides an
 *     earlier `complete` entry without hand-editing the ledger.
 *   - Otherwise, if any entry is `complete`, the version is complete.
 *   - Otherwise, MAX_CONSECUTIVE_PARTIALS trailing partials → wedged.
 *   - Otherwise, any `partial` entry → partial; else pending.
 *
 * `complete` never regresses accidentally. A later `partial` append cannot
 * undo a completed migration; only a trailing, explicit `retry` marker can.
 */
export function statusForVersion(
  version: string,
  byVersion: Map<string, CompletedMigrationEntry[]>,
): MigrationLedgerStatus {
  const entries = byVersion.get(version) ?? [];
  if (entries.length === 0) return 'pending';
  const latest = entries[entries.length - 1];
  if (latest.status === 'retry') return 'pending';
  if (entries.some(e => e.status === 'complete')) return 'complete';
  let consecutive = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.status === 'partial') consecutive++;
    else break;
  }
  if (consecutive >= MAX_CONSECUTIVE_PARTIALS) return 'wedged';
  if (entries.some(e => e.status === 'partial')) return 'partial';
  return 'pending';
}

export function indexCompletedEntries(
  entries: CompletedMigrationEntry[],
): Map<string, CompletedMigrationEntry[]> {
  const byVersion = new Map<string, CompletedMigrationEntry[]>();
  for (const e of entries) {
    const list = byVersion.get(e.version) ?? [];
    list.push(e);
    byVersion.set(e.version, list);
  }
  return byVersion;
}

export interface MigrationLedgerSummary {
  /** Registered migrations ≤ installed version with no ledger completion. */
  pending: string[];
  /** Started but unfinished (some phases recorded partial). */
  partial: string[];
  /** Hit the consecutive-partial cap — needs an explicit forced retry. */
  wedged: string[];
  /**
   * Migrations newer than the installed binary (count only). Future-versioned
   * migrations are excluded from ALL status buckets regardless of ledger
   * state (matches the apply-migrations list view); after a binary downgrade
   * a wedged future migration appears only in this count.
   */
  skipped_future: number;
}

/**
 * Summarize the host migration ledger for the given installed version.
 * Filesystem read (the completed-migrations JSONL) — engine-agnostic, which
 * is why get_health composes this at the op layer rather than growing
 * BrainEngine.getHealth() in both engines. Version strings only; never
 * migration internals.
 */
export function migrationLedgerSummary(installedVersion: string): MigrationLedgerSummary {
  const byVersion = indexCompletedEntries(loadCompletedMigrations());
  const summary: MigrationLedgerSummary = { pending: [], partial: [], wedged: [], skipped_future: 0 };
  for (const version of MIGRATION_VERSIONS) {
    if (compareVersions(version, installedVersion) > 0) {
      summary.skipped_future += 1;
      continue;
    }
    const status = statusForVersion(version, byVersion);
    if (status === 'pending') summary.pending.push(version);
    else if (status === 'partial') summary.partial.push(version);
    else if (status === 'wedged') summary.wedged.push(version);
  }
  return summary;
}
