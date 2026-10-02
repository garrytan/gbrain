/**
 * Preview-bound bulk selection of legacy job rows (#5157 T3, DX-T2): the
 * `--select` grammar, the active-job precondition and the preview summary
 * shared by `gbrain jobs authorize-legacy --select` and `gbrain jobs cancel
 * --select`. Both are CLI-only: neither is an operation, so MCP and
 * remediation can never run them.
 *
 * Grammar: `--select "status=<s>[|<s>…],name=<job-name>[|<name>…]"`, keys
 * `status` and `name`, at least one key. A missing `status` key means every
 * status the command handles.
 */
import type { BrainEngine } from '../engine.ts';
import { catalogueError } from '../error-catalogue.ts';

export type LegacySelectCommand = 'authorize-legacy' | 'cancel';

export interface LegacyJobSelection {
  /** Statuses as given (deduplicated); empty means every status the command handles. */
  statuses: string[];
  names: string[];
}

/** Statuses each command handles. Active rows are never selected: they refuse with `legacy_jobs_active`. */
export const SELECT_STATUSES: Record<LegacySelectCommand, readonly string[]> = {
  'authorize-legacy': ['waiting', 'delayed', 'waiting-children', 'paused', 'completed', 'failed'],
  cancel: ['waiting', 'delayed', 'waiting-children', 'paused'],
};

export const SELECT_EXAMPLE: Record<LegacySelectCommand, string> = {
  'authorize-legacy': 'status=waiting|paused,name=synthesize|ingest_capture',
  cancel: 'status=waiting|paused,name=synthesize',
};

export function formatSelection(selection: LegacyJobSelection): string {
  return [
    selection.statuses.length ? `status=${selection.statuses.join('|')}` : '',
    selection.names.length ? `name=${selection.names.join('|')}` : '',
  ].filter(Boolean).join(',');
}

/** The filled preview command, or the apply command when `hash` is given. */
export function selectCommand(command: LegacySelectCommand, selection: LegacyJobSelection, hash?: string): string {
  const preview = `gbrain jobs ${command} --select "${formatSelection(selection)}"`;
  return hash ? `${preview} --expect ${hash} --yes` : preview;
}

/** The statuses a selection covers. */
export function selectedStatuses(command: LegacySelectCommand, selection: LegacyJobSelection): string[] {
  return selection.statuses.length ? selection.statuses : [...SELECT_STATUSES[command]];
}

export function parseLegacyJobSelection(raw: string | undefined, command: LegacySelectCommand): LegacyJobSelection {
  const invalid = (what: string) => catalogueError('legacy_job_selection_invalid',
    `${what}; --select takes the keys status and name, with statuses ${SELECT_STATUSES[command].join('|')}.`,
    `gbrain jobs ${command} --select "${SELECT_EXAMPLE[command]}"`);
  if (!raw?.trim()) throw invalid('--select needs a filter');
  const selection: LegacyJobSelection = { statuses: [], names: [] };
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (key !== 'status' && key !== 'name') throw invalid(`Unknown --select key "${key}"`);
    if (seen.has(key)) throw invalid(`--select names the key "${key}" twice`);
    seen.add(key);
    const values = eq < 0 ? [''] : part.slice(eq + 1).split('|').map(value => value.trim());
    if (values.some(value => !value)) throw invalid(`--select key "${key}" needs a value for every | alternative`);
    if (key === 'status') {
      const unknown = values.find(value => !SELECT_STATUSES[command].includes(value));
      if (unknown) throw invalid(`Unknown --select status "${unknown}"`);
      selection.statuses = [...new Set(values)];
    } else {
      selection.names = [...new Set(values)];
    }
  }
  return selection;
}

/** Shared stop instruction for every legacy-job refusal (ENG-O4: active jobs are cancelled, never finished). */
export const STOP_PRODUCERS = 'Stop producers (gbrain serve, gbrain autopilot) and workers';

/** Every live status a legacy review can authorize: one preview then covers what a required cancellation leaves behind. */
export const REVIEWABLE_LIVE_STATUSES = ['waiting', 'delayed', 'waiting-children', 'paused'] as const;

/** The filled preview that reviews every live SQL NULL row the claim gate blocks on. */
export const LIVE_LEGACY_PREVIEW = selectCommand('authorize-legacy', { statuses: [...REVIEWABLE_LIVE_STATUSES], names: [] });

/**
 * The recovery order every legacy refusal names (DX-O3(b)): stop producers
 * and workers, cancel active jobs, preview every reviewable live status (a
 * cancellation can move a parent from waiting-children to waiting, so a
 * filter built from today's statuses could miss it), apply with the printed
 * hash, restart.
 */
export function legacyRecoveryHint(activeIds: readonly number[] = []): string {
  const cancels = activeIds.length ? activeIds.slice(0, 10).map(id => `gbrain jobs cancel ${id}`).join('; ') : 'gbrain jobs cancel <id>';
  return `${STOP_PRODUCERS}, cancel active jobs (${cancels}), preview with ${LIVE_LEGACY_PREVIEW}, apply with the printed --expect <hash> --yes, then restart them.`;
}

/** `legacy_jobs_active`: legacy rows are reviewed only with nothing active. Lists up to 10 ids to cancel. */
export async function assertNoActiveJobs(engine: BrainEngine, previewCommand: string): Promise<void> {
  const active = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE status = 'active' ORDER BY id LIMIT 11");
  if (!active.length) return;
  const [total] = active.length > 10
    ? await engine.executeRaw<{ count: string }>("SELECT count(*)::text AS count FROM minion_jobs WHERE status = 'active'")
    : [{ count: String(active.length) }];
  const cancels = active.slice(0, 10).map(row => `gbrain jobs cancel ${row.id}`).join('; ');
  const more = active.length > 10 ? `; list the rest with gbrain jobs list --status active` : '';
  throw catalogueError('legacy_jobs_active',
    `${total!.count} job(s) are active, so legacy jobs cannot be reviewed until producers and workers are stopped and active jobs are cancelled.`,
    `${STOP_PRODUCERS}, cancel the active jobs (${cancels}${more}), then re-run ${previewCommand}.`);
}

export interface SelectionSummary {
  total: number;
  /** Counts by job name, then status. */
  by_name: Record<string, Record<string, number>>;
  first_ids: number[];
}

/** DX-O3(d): counts by job name and status plus the first 20 ids; the full rows stay in `--json`. */
export function summarizeSelection(rows: ReadonlyArray<{ id: unknown; name: unknown; status: unknown }>): SelectionSummary {
  const by_name: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const counts = by_name[String(row.name)] ??= {};
    counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1;
  }
  return { total: rows.length, by_name, first_ids: rows.slice(0, 20).map(row => Number(row.id)) };
}
