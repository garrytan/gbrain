/**
 * #6188 (D16, D17, E35, Codex CEO #7): what an `invalid_fence` sync hold tells
 * an agent, by state. A hold's state comes from the reason table (planned
 * tier, auto-retry), the last repair attempt the fences repair kind recorded
 * on it (`meta.fence_repair`) and whether the maintenance cycle repairs fences
 * on its own right now (`readFenceAutoRepair`: `fences.repair.enabled` and a
 * brain-wide maintenance pass within `FENCE_MAINTENANCE_ACTIVE_MS`). Without
 * that evidence no surface says "no action is needed".
 *
 * States: `auto` (the next maintenance run repairs it; the fix is the
 * read-only preview), `apply` (repairable, but nothing runs it now: the
 * preview, then the apply), `manual` (a manual-only reason, a gate rejection
 * or a model failure the run does not retry: the preview names the exact
 * edit), `paid` (waits on spend the user controls: the exact config or
 * pricing command with consent `paid`, so it renders `ask_user`), `owner`
 * (repairs run on the canonical owner host). Remote callers get the
 * owner-host command as a relay (`tell_user_to_run`) and a `user_message`
 * saying whether the hold clears by itself; never a path.
 *
 * Location only: fence, section, rows, columns, classes and lines.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action, ActionInput } from '../agent-output.ts';
import type { GitHoldRecord } from '../persistence/sync-holds.ts';
import { FENCE_REPAIR_ENABLED_KEY, FENCE_REPAIR_LLM_KEY } from './config.ts';
import { FENCE_REPAIR_MEASURED_MODELS } from './measured.ts';
import { FENCE_REASONS, renderFenceFix, type FenceMessageLocation } from './reasons.ts';
import { fenceWhere } from './refusal.ts';
import type { FenceReason, FenceTier } from './types.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

/** A brain-wide maintenance pass at most this old counts as an active maintenance job (autopilot runs one about hourly). */
export const FENCE_MAINTENANCE_ACTIVE_MS = 24 * 3_600_000;
/** The config key a completed brain-wide maintenance pass stamps (`LAST_GLOBAL_AT_KEY` in cycle.ts). */
export const LAST_GLOBAL_MAINTENANCE_KEY = 'autopilot.last_global_at';

/** Whether the maintenance cycle repairs fences without anyone acting. */
export interface FenceAutoRepair {
  /** `fences.repair.enabled`: the cycle's `fence_repair` phase runs. */
  enabled: boolean;
  /** `fences.repair.llm`: the repair may call the model tier. */
  llm: boolean;
  /** The last completed brain-wide maintenance pass or job (ISO), or null when none ran. */
  last_maintenance_at: string | null;
  /** Enabled, and a maintenance pass completed within `FENCE_MAINTENANCE_ACTIVE_MS`. */
  active: boolean;
}

const FALSE = /^(false|0|off|no)$/i;

/** Two reads: the fence switches with the maintenance stamp, and the last completed maintenance job. A read error counts as no evidence. */
export async function readFenceAutoRepair(engine: Exec, now: Date = new Date()): Promise<FenceAutoRepair> {
  const config = await engine.executeRaw<{ key: string; value: string | null }>('SELECT key, value FROM config WHERE key = ANY($1::text[])',
    [[FENCE_REPAIR_ENABLED_KEY, FENCE_REPAIR_LLM_KEY, LAST_GLOBAL_MAINTENANCE_KEY]]).catch(() => []);
  const value = (key: string) => config.find(row => row.key === key)?.value?.trim() ?? '';
  const job = await engine.executeRaw<{ at: string | null }>(`SELECT to_char(max(finished_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
    FROM minion_jobs WHERE name='autopilot-global-maintenance' AND status='completed'`).then(rows => rows[0]?.at ?? '', () => '');
  const times = [value(LAST_GLOBAL_MAINTENANCE_KEY), job].map(at => Date.parse(at)).filter(Number.isFinite);
  const last = times.length ? Math.max(...times) : null;
  const enabled = !FALSE.test(value(FENCE_REPAIR_ENABLED_KEY));
  return { enabled, llm: !FALSE.test(value(FENCE_REPAIR_LLM_KEY)), last_maintenance_at: last === null ? null : new Date(last).toISOString(),
    active: enabled && last !== null && now.getTime() - last <= FENCE_MAINTENANCE_ACTIVE_MS };
}

export type FenceHoldState = 'auto' | 'apply' | 'manual' | 'paid' | 'owner';

export interface FenceHoldStatus {
  state: FenceHoldState;
  /** The reason that decides the state: the last repair attempt's, else the screened one; `llm_disabled` while a model-tier hold waits on `fences.repair.llm`. */
  reason: FenceReason;
  /** The tier that clears it; null when it depends on the bytes the repair reads. */
  tier: FenceTier | null;
  /** The maintenance run retries it with no one acting. */
  auto_retry: boolean;
  /** When the last repair attempt said the maintenance run tries again (null: unknown or never). */
  next_attempt_after: string | null;
}

const PAID: readonly FenceReason[] = ['budget_exhausted', 'llm_disabled', 'no_pricing', 'no_measured_model'];
const OWNER: readonly FenceReason[] = ['owner_unavailable', 'owner_cli_required', 'host_mismatch', 'transfer_in_progress', 'clone_in_progress', 'incarnation_changed',
  'local_path_missing', 'coordination_path_missing'];

type HoldMeta = Pick<GitHoldRecord['meta'], 'reason' | 'line' | 'fence' | 'fence_repair'>;

const known = (reason: string | undefined): reason is FenceReason => !!reason && reason in FENCE_REASONS;

/** The screened problem: the receipt's reason for a prepare-time hold, else the hold's own. */
function screenedReason(meta: HoldMeta): FenceReason {
  return meta.fence?.reason ?? (known(meta.reason) ? meta.reason : 'unparseable');
}

/** The state of one fence hold; `auto` is what the caller read (undefined: unknown, so never `auto`). */
export function fenceHoldStatus(meta: HoldMeta, auto?: FenceAutoRepair): FenceHoldStatus {
  const screened = screenedReason(meta);
  const last = meta.fence_repair && known(meta.fence_repair.reason) ? meta.fence_repair : undefined;
  const planned = FENCE_REASONS[screened];
  const tier = last?.tier ?? (planned.manualOnly ? 'manual' : planned.tier);
  const llmOff = tier === 'llm' && auto?.llm === false && (!last || FENCE_REASONS[last.reason].autoRetry);
  const reason: FenceReason = llmOff ? 'llm_disabled' : last?.reason ?? screened;
  const spec = FENCE_REASONS[reason];
  const retries = !llmOff && (last ? last.next_attempt_after !== null : spec.autoRetry && !spec.manualOnly);
  const needsEdit = spec.manualOnly || spec.tier === 'manual' || !!spec.gate || reason.startsWith('llm_');
  const state: FenceHoldState = PAID.includes(reason) ? 'paid' : OWNER.includes(reason) ? 'owner' : !retries && needsEdit ? 'manual' : retries && auto?.active ? 'auto' : 'apply';
  return { state, reason, tier, auto_retry: retries && auto?.active === true, next_attempt_after: last?.next_attempt_after ?? null };
}

/** D16: a hold's structured location (remote callers get no row numbers). */
export interface FenceHoldLocation extends FenceMessageLocation {
  /** Problem classes (location-only reason codes). */
  classes: string[];
  tier: FenceTier | null;
  auto_retry: boolean;
  next_attempt_after: string | null;
}

export function fenceHoldLocation(meta: HoldMeta, auto?: FenceAutoRepair, remote = false): FenceHoldLocation | undefined {
  if (!meta.fence) return undefined;
  const status = fenceHoldStatus(meta, auto);
  return { ...meta.fence, rows: remote ? [] : [...meta.fence.rows], columns: [...meta.fence.columns], classes: [meta.fence.reason], tier: status.tier,
    auto_retry: status.auto_retry, next_attempt_after: status.next_attempt_after };
}

/**
 * The file line of the location's first bad row: the section's first line in
 * the file plus its line within the section. Null when the section text is not
 * found verbatim (for example after line-ending normalization) or has no line.
 */
export function fenceFileLine(content: string, page: { compiled_truth: string; timeline?: string | null }, at: Pick<FenceMessageLocation, 'section' | 'line'>): number | null {
  if (at.line === null) return null;
  const body = page.compiled_truth ?? '', timeline = page.timeline ?? '';
  const bodyAt = body ? content.indexOf(body) : -1;
  const start = at.section === 'body' ? bodyAt : timeline ? content.indexOf(timeline, bodyAt < 0 ? 0 : bodyAt + body.length) : -1;
  return start < 0 ? null : content.slice(0, start).split('\n').length + at.line - 1;
}

/** The hold's location as prose, at the file line when the hold recorded one. */
export function fenceHoldWhere(meta: HoldMeta): string {
  return fenceWhere(meta.fence ? { ...meta.fence, line: meta.line ?? meta.fence.line } : undefined);
}

/** `gbrain repair fences --source <id> [--only <path>]`: the read-only preview (no model call). */
export function fencePreviewArgv(sourceId: string, path?: string): string[] {
  return ['gbrain', 'repair', 'fences', '--source', sourceId, ...(path ? ['--only', path] : [])];
}

/** The exact command a paid state waits on; `<...>` placeholders are described by `inputs`. */
function paidStep(reason: FenceReason): { argv: string[]; inputs?: ActionInput[] } {
  if (reason === 'budget_exhausted') return { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'],
    inputs: [{ name: 'usd', how: 'The daily cap in USD the user agreed to; read the current one with gbrain config get fences.repair.max_usd_per_day.' }] };
  if (reason === 'llm_disabled') return { argv: ['gbrain', 'config', 'set', 'fences.repair.llm', 'true'] };
  if (reason === 'no_measured_model') return { argv: ['gbrain', 'config', 'set', 'models.fence_repair', '<model>'],
    inputs: [{ name: 'model', how: `The provider:model the user chooses to trust with fence repair. Measured accurate enough: ${FENCE_REPAIR_MEASURED_MODELS.join(', ')}; each needs its provider's key.` }] };
  return { argv: ['gbrain', 'pricing', 'set', '<model>', '--input', '<usd>', '--output', '<usd>'],
    inputs: [{ name: 'model', how: 'The fence repair model: models.fence_repair in gbrain models --json.' },
      { name: 'usd', how: "The provider's price in USD per 1M input tokens after --input and per 1M output tokens after --output, from its pricing page." }] };
}

/** Why a paid state waits, in words a user can decide on. */
function paidWait(reason: FenceReason): string {
  if (reason === 'budget_exhausted') return "today's fence repair budget (fences.repair.max_usd_per_day) is spent";
  if (reason === 'llm_disabled') return 'model repair is off (fences.repair.llm false)';
  if (reason === 'no_measured_model') return 'no model measured accurate enough for fence repair has a provider key here and models.fence_repair is unset';
  return 'a fence repair spend cap is set but gbrain has no price for the repair model, so it will not call it';
}

/** Why an `apply` hold is not repaired by itself. */
function applyWait(auto: FenceAutoRepair | undefined): string {
  if (!auto) return 'Unless a maintenance run repairs it first';
  return auto.enabled ? 'No maintenance run is active on this brain, so nothing repairs it by itself' : 'Automatic fence repair is paused (fences.repair.enabled false), so nothing repairs it by itself';
}

/** The local next step for one `invalid_fence` hold (actor `agent`; the owner state is the host operator's). */
export function fenceHoldFix(record: Pick<GitHoldRecord, 'source_id' | 'path' | 'meta'>, auto?: FenceAutoRepair): Action {
  const status = fenceHoldStatus(record.meta, auto);
  const source = record.source_id, path = record.path;
  const preview = fencePreviewArgv(source, path);
  const command = preview.join(' ');
  const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
  const held = `${path} is held because ${fenceHoldWhere(record.meta)} ${record.meta.reason === 'prepare_time' ? 'was refused against the stored page' : 'cannot be imported'} (${screenedReason(record.meta)}).`;
  const rest = 'The rest of the source keeps syncing.';
  const step = { consent: [], actor: 'agent' as const, requires_exclusive: false, verify };
  const base = { ...step, docs: 'docs/guides/repair.md#fences' };
  switch (status.state) {
    case 'auto':
      return { ...base, argv: preview, why: `${held} No action is needed: the next maintenance run repairs it automatically${status.next_attempt_after ? ` (next attempt after ${status.next_attempt_after})` : ''}. `
        + `The preview shows the planned repair, read-only. ${rest}` };
    case 'apply':
      return { ...base, argv: preview, why: `${held} ${applyWait(auto)}: the preview (read-only, no model call) shows the planned repair and prints the apply command with --expect <hash>; `
        + `run that printed command to apply exactly what it showed. ${rest}`,
      then: { ...step, argv: [...preview, '--apply'], why: `Applies the current repair plan for ${path} and clears the hold. The command the preview prints adds --expect <hash>, which applies exactly the previewed repair; prefer it.` } };
    case 'manual': {
      const at = record.meta.fence ? { ...record.meta.fence, reason: status.reason, rows: record.meta.fence_repair?.rows ?? record.meta.fence.rows } : null;
      const gate = record.meta.fence_repair?.gate;
      return { ...base, argv: preview, why: `${held} ${gate ? `The proposed repair failed gate ${gate}, so it was not written.` : 'gbrain will not guess this repair.'} ${at ? `${renderFenceFix(at)} ` : ''}`
        + `The preview names the exact edit, read-only: make it in ${path} (never the frontmatter), commit, then sync. ${rest}`,
      then: { ...step, argv: ['gbrain', 'sync', '--source', source, '--no-pull'],
        why: `Imports the corrected ${path} and clears the hold; a fence that still does not parse stays held without blocking the sync.` } };
    }
    case 'paid': {
      const paid = paidStep(status.reason);
      return { ...base, ...paid, consent: ['paid'], preview_argv: preview,
        why: `${held} Its model repair waits because ${paidWait(status.reason)}${status.reason === 'budget_exhausted' && status.auto_retry ? '; the maintenance run retries it after 00:00 UTC with no action' : ''}. `
          + `Spending more on fence repair is the user's call, so ask before running this; without it, fix the rows by hand (${command} names them, read-only, with the estimated cost). ${rest}`,
        user_message: `gbrain can repair a malformed facts or takes table in ${path} with the paid repair model, but ${paidWait(status.reason)}. May I run '${paid.argv.join(' ')}'? Otherwise I can fix the rows by hand.` };
    }
    case 'owner':
      return { ...base, actor: 'host_admin', argv: preview, why: `${held} Fence repairs write files only on the source's canonical owner host, and this host is not it (${status.reason}). `
        + `On the owner host run ${command} to preview the repair, then the apply command it prints. ${rest}`,
      user_message: `Please run '${command}' on the brain's owner host to preview the repair of a malformed facts or takes table, then run the apply command it prints.` };
  }
}

/** Why a remote caller's held fence does or does not clear by itself, for its `user_message`. */
function relayText(status: FenceHoldStatus, auto: FenceAutoRepair | undefined, run: string, paid: string): string {
  switch (status.state) {
    case 'auto': return `It clears by itself: the brain host's maintenance run repairs it automatically${status.next_attempt_after ? ` (next attempt after ${status.next_attempt_after})` : ''}, so nothing is needed now. To see the planned repair, the brain host operator can run ${run}.`;
    case 'apply': return `It does not clear by itself because ${auto?.enabled === false ? 'automatic fence repair is paused on the brain host' : 'no maintenance run is active on the brain host'}. Please run ${run} on the brain host to preview the repair, then run the apply command it prints.`;
    case 'manual': return `It does not clear by itself: it needs an edit gbrain will not guess. Please run ${run} on the brain host; it names the exact edit to make in the file, then commit and sync.`;
    case 'paid': return `It does not clear by itself: its repair needs the paid repair model, and ${paidWait(status.reason)}. Raising spend or enabling the model is your call: if you agree, run '${paid}' on the brain host; otherwise ${run} there names the rows to fix by hand.`;
    case 'owner': return `Fence repairs run on the brain's owner host: please run ${run} there, then the apply command it prints.`;
  }
}

/** The relay a remote caller gets for one held fence (`tell_user_to_run`): the owner-host command and whether it clears by itself. No path. */
export function fenceHoldRelay(record: Pick<GitHoldRecord, 'source_id' | 'meta'>, auto: FenceAutoRepair | undefined, why: string): Action {
  const status = fenceHoldStatus(record.meta, auto);
  const preview = fencePreviewArgv(record.source_id);
  const paid = status.state === 'paid' ? paidStep(status.reason) : null;
  return { argv: paid?.argv ?? preview, ...(paid?.inputs ? { inputs: paid.inputs } : {}), consent: paid ? ['paid'] : [], actor: 'host_admin', requires_exclusive: false, why,
    ...(paid ? { preview_argv: preview } : {}),
    user_message: `A facts or takes table in one of your brain's files could not be imported, so answers can show an older version of that page. `
      + relayText(status, auto, `'${preview.join(' ')}'`, paid?.argv.join(' ') ?? '') };
}
