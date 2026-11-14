/**
 * What unattended upkeep looks like right now (GBRA-438): one view behind
 * `gbrain maintain --status` and the `unattended_maintenance` doctor check,
 * so the two can never disagree.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { isAvailable } from '../ai/gateway.ts';
import {
  PAID_PHASES, UPKEEP_BACKOFF_FAILURES, autopilotOwnsUpkeep, readEmbedDailyCapUsd, readEmbedSpentToday, readUpkeepRecord, upkeepEnabled,
  type UpkeepFailure, type UpkeepRecord,
} from './run.ts';

/** Past this age, an upkeep run (or a brain with none) reads as overdue. */
export const UPKEEP_OVERDUE_MS = 48 * 60 * 60 * 1000;

export type UpkeepState = 'ok' | 'never' | 'off' | 'autopilot' | 'overdue' | 'failing' | 'parked';

export interface UpkeepStatus {
  state: UpkeepState;
  message: string;
  runner: string | null;
  last_run: string | null;
  steps: UpkeepRecord['steps'];
  held: string[];
  next_due_at: string | null;
  failing: UpkeepFailure | null;
  /** Items the serve's budgeted runs gave up on; an unbudgeted run finishes them. */
  parked: NonNullable<UpkeepRecord['parked']>;
  pending_purge_count: number | null;
  paid_phases_opt_in: string[];
  embed_spend_today_usd: number | null;
  embed_daily_cap_usd: number | null;
  fix?: Action;
  /** The second option beside `fix` when upkeep is overdue: the opt-in operating-system schedule. */
  alternative_fix?: Action;
}

function ago(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(0, Math.floor(ms / 60_000))}m`;
}

async function pendingPurgeCount(engine: BrainEngine): Promise<number | null> {
  try {
    const [{ selectPurgeCandidates }, { readPurgeRetentionHours }] = await Promise.all([import('../persistence/purge-deleted.ts'), import('../sync-reconcile.ts')]);
    return (await selectPurgeCandidates(engine, await readPurgeRetentionHours(engine), { automatic: true })).count;
  } catch {
    return null;
  }
}

async function brainAgeMs(engine: BrainEngine, now: number): Promise<number | null> {
  const [row] = await engine.executeRaw<{ oldest: string | Date | null }>('SELECT MIN(created_at) AS oldest FROM pages').catch(() => [{ oldest: null }]);
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : NaN;
  return Number.isFinite(oldest) ? now - oldest : null;
}

/** The fix doctor and `--status` print when upkeep is overdue or failing. */
export function upkeepFix(paid: boolean): Action {
  return {
    argv: ['gbrain', 'maintain', '--unattended'], consent: paid ? ['paid'] : [], actor: 'agent', requires_exclusive: false,
    why: paid
      ? 'Runs free upkeep now (links, timeline, facts index, bookkeeping GC; never the page purge); with an embedding key it also embeds the backlog within maintenance.embed_daily_usd.'
      : 'Runs free upkeep now (links, timeline, facts index, bookkeeping GC); it calls no model and never purges a page.',
    verify: { argv: ['gbrain', 'doctor', '--only', 'unattended_maintenance', '--json'] },
  };
}

/** Overdue means no serve ran upkeep: name both ways back. */
const SCHEDULE_NOTE = ' It runs while an agent\'s gbrain serve is open and idle; run it now with gbrain maintain --unattended, or add the opt-in schedule with gbrain maintain --schedule.';

/** The second option: install the opt-in schedule, a persistent_install the user approves. */
export function scheduleFix(): Action {
  return {
    argv: ['gbrain', 'maintain', '--schedule'], consent: ['persistent_install'], actor: 'agent', requires_exclusive: false,
    preview_argv: ['gbrain', 'maintain', '--schedule', '--dry-run'],
    why: 'Installs an operating-system schedule (launchd, systemd user timer or crontab) that runs free upkeep every 6 hours when no gbrain serve is running; gbrain maintain --unschedule removes it.',
    verify: { argv: ['gbrain', 'doctor', '--only', 'unattended_maintenance', '--json'] },
  };
}

export async function readUpkeepStatus(engine: BrainEngine, nowMs: number = Date.now()): Promise<UpkeepStatus> {
  const now = new Date(nowMs);
  const [record, enabled, owner, pending, cap, spent] = await Promise.all([
    readUpkeepRecord(engine), upkeepEnabled(engine), autopilotOwnsUpkeep(engine, now), pendingPurgeCount(engine),
    readEmbedDailyCapUsd(engine), readEmbedSpentToday(engine, now),
  ]);
  const keyed = isAvailable('embedding');
  const base = {
    runner: record?.runner ?? null, last_run: record?.at ?? null, steps: record?.steps ?? [], held: record?.held ?? [],
    next_due_at: record?.next_due_at ?? null, failing: null as UpkeepFailure | null, parked: record?.parked ?? [], pending_purge_count: pending,
    paid_phases_opt_in: [...PAID_PHASES], embed_spend_today_usd: keyed ? spent : null, embed_daily_cap_usd: keyed ? cap : null,
  };
  const purgeNote = pending
    ? ` Nothing deletes on its own: ${pending} deleted page(s) wait for you (preview: gbrain maintain --purge).`
    : ' Nothing deletes on its own.';
  const spendNote = keyed ? ` Embedding catch-up: $${spent.toFixed(2)} of $${cap.toFixed(2)} today.` : '';
  if (!enabled) return { ...base, state: 'off', message: 'Free upkeep is off (maintenance.auto is false); turn it back on with gbrain config set maintenance.auto true.' };
  if (owner) return { ...base, state: 'autopilot', message: `An autopilot keeps this brain maintained (last brain-wide pass ${ago(nowMs - Date.parse(owner))} ago), so free upkeep stays out of its way.${purgeNote}` };
  const fix = upkeepFix(keyed && cap > 0);
  const failing = record?.consecutive_failures.find((f) => f.count >= UPKEEP_BACKOFF_FAILURES) ?? null;
  if (failing) {
    return { ...base, failing, fix, state: 'failing',
      message: `The last ${failing.count} upkeep runs failed at ${failing.step} (${failing.scope}) with ${failing.code}; that step now runs once a week until it succeeds.${spendNote}` };
  }
  if (!record) {
    const age = await brainAgeMs(engine, nowMs);
    if (age === null || age < UPKEEP_OVERDUE_MS) {
      return { ...base, state: 'never', message: `Free upkeep has not run on this brain yet; gbrain maintain --unattended runs it (no model calls, no page purge).${purgeNote}` };
    }
    return { ...base, fix, alternative_fix: scheduleFix(), state: 'overdue', message: `No free upkeep run is recorded on this brain, which is ${ago(age)} old.${SCHEDULE_NOTE}${purgeNote}` };
  }
  const age = nowMs - Date.parse(record.at);
  if (age > UPKEEP_OVERDUE_MS) {
    return { ...base, fix, alternative_fix: scheduleFix(), state: 'overdue', message: `Free upkeep last ran ${ago(age)} ago (${record.runner}), past its 48h window.${SCHEDULE_NOTE}${purgeNote}${spendNote}` };
  }
  if (base.parked.length) {
    const named = base.parked.map((p) => `${p.key} after ${p.slices} slices`).join(', ');
    return { ...base, fix, alternative_fix: scheduleFix(), state: 'parked',
      message: `Upkeep inside serve parked ${named}; serve tries it again next round, and gbrain maintain --unattended finishes it now.${purgeNote}${spendNote}` };
  }
  const ran = record.steps.filter((s) => s.status === 'ok' || s.status === 'warn').length;
  const due = Date.parse(record.next_due_at) - nowMs;
  return { ...base, state: 'ok',
    message: `Free upkeep ran ${ago(age)} ago (${record.runner}, ${ran} steps ok). ${record.cursor ? 'The round continues on the next run.' : due > 0 ? `Next due in ${ago(due)}.` : 'Due now.'}${purgeNote}${spendNote}` };
}
