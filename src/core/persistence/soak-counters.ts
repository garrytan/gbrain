/**
 * #6712 PR 2 (L4): the soak counters. The seven-day soak passes on zero mechanical interventions, so every step a person
 * (or an agent standing in for one) took to keep managed sync converging is counted where it happens:
 *
 * - interventions: a sync run with a recovery flag (`sync_non_plain`: `--retry-failed`, `--full`, `--skip-failed`,
 *   `--break-lock`, ...; a scheduler's plain `--all --no-pull --hard-deadline` run is not one), a repair apply
 *   (`repair_apply`, any kind but file-drift), `sync unblock --apply` (`unblock_apply`), `sources retry-held`
 *   (`retry_held`), and a hold that turned `needs_human` (`needs_human`: by its code, a judged content verdict, or
 *   escalation after failed attempts over a day);
 * - content decisions (Garry's d1b): drift on a page outside the `storage.keep_db` prefixes is the user's choice, not a
 *   mechanical failure, so a `file_drift` hold (`file_drift_hold`) and a `repair file-drift` apply (`file_drift_apply`)
 *   are reported on their own line. A keep_db page reconciles from the database with no decision and counts nowhere.
 *
 * Storage: one `op_checkpoints` row per UTC day (op `sync-soak-counters`, fingerprint `YYYY-MM-DD`), each counter
 * incremented in one upsert; the 7-day checkpoint purge drops a day once it leaves the window. A hold's transition is
 * counted once: `needs_human_at` is stamped on the hold (and kept across re-holds with the same code), and the sweep
 * after each managed sync counts holds that turned since. Recording is best effort and never fails the command.
 * Reader: doctor `sync_soak_counters` (`readSoakCounters`).
 */
import type { BrainEngine } from '../engine.ts';
import { GIT_HOLD_OP, gitHoldFingerprint } from './sync-holds.ts';

export const SOAK_COUNTERS_OP = 'sync-soak-counters';
export const SOAK_WINDOW_DAYS = 7;
export const INTERVENTION_KINDS = ['sync_non_plain', 'repair_apply', 'unblock_apply', 'retry_held', 'needs_human'] as const;
export const CONTENT_DECISION_KINDS = ['file_drift_apply', 'file_drift_hold'] as const;
export type SoakKind = typeof INTERVENTION_KINDS[number] | typeof CONTENT_DECISION_KINDS[number];
/** Sync flags an operator reaches for to recover a run; a scheduler's run carries none of them. */
export const NON_PLAIN_SYNC_FLAGS = ['--retry-failed', '--full', '--skip-failed', '--break-lock', '--force-break-lock', '--reset-checkpoint', '--no-delegate', '--acknowledge-managed'] as const;
/** Holds the sweep stamps per sync; the rest are counted by the next sync. */
const SWEEP_LIMIT = 500;

type Exec = Pick<BrainEngine, 'executeRaw'>;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Adds `n` to one counter of today's row. Never throws. */
export async function recordSoakEvent(engine: Exec, kind: SoakKind, n = 1): Promise<void> {
  if (n <= 0) return;
  const today = day(Date.now());
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array(jsonb_build_object('day',$2::text,$3::text,$4::int)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(op_checkpoints.completed_keys->0
      || jsonb_build_object($3::text, COALESCE((op_checkpoints.completed_keys->0->>$3)::int,0)+$4::int)), updated_at=now()`, [SOAK_COUNTERS_OP, today, kind, n]).catch(() => undefined);
}

/** The intervention a sync invocation's flags make, if any. */
export function nonPlainSyncFlags(args: readonly string[]): string[] {
  return NON_PLAIN_SYNC_FLAGS.filter(flag => args.some(arg => arg === flag || arg.startsWith(`${flag}=`)));
}

/**
 * Counts and stamps the holds of `sourceId` that need a person now and were not counted yet, by the verdict `sync status`
 * shows (`holdVerdict`: escalation after a live-editor check, the fault table, a fence or slug-conflict lane's manual or
 * paid state): a `file_drift` hold is a content decision, every other one a `needs_human` intervention. Every unstamped
 * hold is judged each run, so holds that stay agent-actionable never starve later ones; at most `SWEEP_LIMIT` are
 * stamped per run and the rest are counted by the next. Returns what it counted.
 */
export async function sweepNeedsHumanHolds(engine: BrainEngine, sourceId: string, now = Date.now()): Promise<{ needs_human: number; file_drift_hold: number }> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const counted = { needs_human: 0, file_drift_hold: 0 };
  if (!source) return counted;
  const { fenceAutoRepairFor, readGitSourceHolds } = await import('./sync-holds.ts');
  const { holdVerdict, observeDirtyEditors } = await import('./sync-status.ts');
  const unstamped = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [])
    .filter(hold => hold.incarnation === source.incarnation && !hold.meta.needs_human_at);
  const records = await observeDirtyEditors(engine, sourceId, source.incarnation, unstamped, now);
  const auto = await fenceAutoRepairFor(engine, records);
  const stamp = new Date(now).toISOString();
  for (const record of records.filter(hold => holdVerdict(hold, auto, now).needs_human).slice(0, SWEEP_LIMIT)) {
    const updated = await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,needs_human_at}',to_jsonb($3::text))
      WHERE op=$1 AND fingerprint=$2 AND completed_keys->0->>'code'=$4 AND NOT (completed_keys->0->'meta' ? 'needs_human_at') RETURNING 1`,
    [GIT_HOLD_OP, gitHoldFingerprint(sourceId, source.incarnation, record.path), stamp, record.code]);
    if (updated.length) counted[record.code === 'file_drift' ? 'file_drift_hold' : 'needs_human']++;
  }
  await recordSoakEvent(engine, 'needs_human', counted.needs_human);
  await recordSoakEvent(engine, 'file_drift_hold', counted.file_drift_hold);
  return counted;
}

export interface SoakCounters {
  window_days: number;
  since: string;
  interventions: { total: number } & Record<typeof INTERVENTION_KINDS[number], number>;
  content_decisions: { total: number } & Record<typeof CONTENT_DECISION_KINDS[number], number>;
  by_day: Array<{ day: string; interventions: number; content_decisions: number }>;
}

/** The last `days` UTC days (today included), summed per counter and per day. */
export async function readSoakCounters(engine: Exec, days = SOAK_WINDOW_DAYS, now = Date.now()): Promise<SoakCounters> {
  const window = Array.from({ length: days }, (_, i) => day(now - i * 86_400_000));
  const rows = await engine.executeRaw<{ counts: Record<string, unknown> }>('SELECT completed_keys->0 AS counts FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])',
    [SOAK_COUNTERS_OP, window]);
  const sum = (counts: Record<string, unknown>, kinds: readonly string[]) => kinds.reduce((total, kind) => total + (Number(counts[kind]) || 0), 0);
  const total = (kind: string) => rows.reduce((n, row) => n + (Number(row.counts[kind]) || 0), 0);
  const interventions = Object.fromEntries(INTERVENTION_KINDS.map(kind => [kind, total(kind)])) as SoakCounters['interventions'];
  const decisions = Object.fromEntries(CONTENT_DECISION_KINDS.map(kind => [kind, total(kind)])) as SoakCounters['content_decisions'];
  interventions.total = INTERVENTION_KINDS.reduce((n, kind) => n + interventions[kind], 0);
  decisions.total = CONTENT_DECISION_KINDS.reduce((n, kind) => n + decisions[kind], 0);
  return { window_days: days, since: `${window[window.length - 1]}T00:00:00.000Z`, interventions, content_decisions: decisions,
    by_day: rows.map(row => ({ day: String(row.counts.day), interventions: sum(row.counts, INTERVENTION_KINDS), content_decisions: sum(row.counts, CONTENT_DECISION_KINDS) }))
      .sort((a, b) => a.day.localeCompare(b.day)) };
}
