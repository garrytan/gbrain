/**
 * `gbrain sources writer movement [<source>] [--wait <dur>] [--warn-only] [--json]`
 * (#6317, I2): a deploy ends with data movement, not process liveness.
 *
 * It snapshots every active managed source (`readSourceMovement`: committed
 * managed receipt watermark, head step, cursor, holds, who is live), waits
 * the window (default `max(300 s, persistence.sync_preparation_ms + 60 s)`,
 * never below one sync preparation budget, so a healthy multi-wave group under
 * a raised budget reads `within_allowance`, never `not_moving`; the output
 * prints the budget it judged against), snapshots again and judges each
 * source: `moved` (a new committed publication), `within_allowance` (no commit
 * yet, but the head's step or the cursor advanced), `held` (advanced only by
 * holds: #6298's containment, routed by hold kind), `parked` (pending work and
 * nothing live to move it), `not_moving`, `nothing_pending`. The window ends
 * early once every pending source has moved.
 *
 * Exit: `not_moving` → 1 with code `managed_sync_not_moving` (`reason:
 * movement_check`) and the writer summary; `parked` → 1 with the same code
 * and `state: parked` (after a restart nothing picked the catch-up up);
 * `held`/`within_allowance`/`moved`/`nothing_pending` → 0; `--warn-only`
 * prints the same envelopes and exits 0. A read failure keeps its own code
 * (`fix.next: report`), never `managed_sync_not_moving`. `gbrain upgrade`
 * never runs this (it owns no relaunch); it prints the bare command for the
 * supervisor's step.
 */
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { cliRenderContext, renderAction, toAgentError, type Action, type AgentEnvelope, type RenderedAction } from '../core/agent-output.ts';
import { parseDurationSeconds } from '../core/sync-concurrency.ts';
import { persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { readPreparationPolicy } from '../core/persistence/switches.ts';
import { judgeMovement, readSourceMovement, writerStatusCommand, type MovementVerdict, type SourceMovement } from '../core/persistence/sync-movement.ts';
import { stalledHoldSteps } from '../core/persistence/sync-holds.ts';
import { adminHostConfig } from './persistence-admin.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

export const MOVEMENT_HELP = `Usage:
  gbrain sources writer movement [<source>] [--source <id>] [--wait <dur>] [--warn-only] [--json] [--brain <id>]

Proves that managed sync data moves: snapshots every active managed source,
waits the window, and judges each one from committed pages and the head's step
(a renewed lease, a live lock or a healthy /health are not movement).
  --wait <dur>   The window (30s, 5m, 1h; seconds when bare). Default: the larger of 5m and
                 persistence.sync_preparation_ms + 60s, printed as the budget judged against.
  --warn-only    Print the same verdicts and envelopes but exit 0 (pipelines that cannot fail).
States: moved, within_allowance (a step or cursor advanced; a multi-wave group preparing
normally), held (advanced only by holds; the hold kind's repair route is printed), parked
(pending work and nothing live to move it), not_moving, nothing_pending.
Exit 1 with code managed_sync_not_moving for not_moving and parked; 0 otherwise.
Run it after restarting serve and the workers: gbrain sources writer movement`;

/** The bare command `gbrain upgrade` and `gbrain post-upgrade` print for the supervisor's step (no flags, so it inherits the default window). */
export const MOVEMENT_SUPERVISOR_STEP = 'after restarting serve and the workers, run: gbrain sources writer movement';

export const MOVEMENT_DEFAULT_MIN_MS = 300_000;
export const MOVEMENT_BUDGET_GRACE_MS = 60_000;
const POLL_MS = 10_000;

export interface MovementArgs { sourceId?: string; waitMs?: number; warnOnly: boolean; json: boolean; brain?: string }
export function parseMovementArgs(args: string[]): MovementArgs {
  const out: MovementArgs = { warnOnly: false, json: false };
  const usage = (message: string, suggestion: string) => opError('invalid_params', message, suggestion,
    { fix: readFix('Prints the movement command\'s flags and states.', { argv: ['gbrain', 'sources', 'writer', 'movement', '--help'] }) });
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const equal = token.indexOf('=');
    const flag = token.startsWith('-') && equal > 0 ? token.slice(0, equal) : token;
    const value = () => { const v = equal > 0 && token.startsWith('-') ? token.slice(equal + 1) : args[++i]; if (v === undefined || v.startsWith('--')) throw usage(`${flag} requires a value.`, `Give ${flag} its value right after it, as ${flag} <value>.`); return v; };
    if (!token.startsWith('-')) { if (out.sourceId !== undefined) throw usage('Specify the source once.', `Name the source either as the argument or with --source, not both (here ${out.sourceId} and ${token}).`); out.sourceId = token; }
    else if (flag === '--json') out.json = true;
    else if (flag === '--warn-only') out.warnOnly = true;
    else if (flag === '--source') { if (out.sourceId !== undefined) throw usage('Specify the source once.', 'Name the source either as the argument or with --source, not both.'); out.sourceId = value(); }
    else if (flag === '--brain') out.brain = value();
    else if (flag === '--wait') {
      const seconds = parseDurationSeconds(value(), '--wait');
      if (seconds === undefined || seconds === null) throw usage('--wait requires a duration.', 'Give --wait a duration such as 30s, 5m or 1h (bare numbers are seconds).');
      out.waitMs = seconds * 1000;
    }
    else throw usage(`Unknown option: ${flag}.`, 'The accepted options are --source, --wait, --warn-only, --json and --brain.');
  }
  return out;
}

/** The window the command judges against: never below one sync preparation budget, by default the larger of 5 minutes and the budget plus a minute. */
export function movementWindowMs(policy: { syncMs: number }, requested?: number): { window_ms: number; budget_ms: number; source: 'default' | '--wait' } {
  if (requested !== undefined) return { window_ms: Math.max(requested, policy.syncMs), budget_ms: policy.syncMs, source: '--wait' };
  return { window_ms: Math.max(MOVEMENT_DEFAULT_MIN_MS, policy.syncMs + MOVEMENT_BUDGET_GRACE_MS), budget_ms: policy.syncMs, source: 'default' };
}

export interface MovementReport {
  source_id: string;
  state: MovementVerdict;
  exit: 0 | 1;
  code: 'managed_sync_not_moving' | null;
  reason?: 'movement_check';
  why: string;
  fix: RenderedAction | null;
  retry_after_ms?: number;
  before: SourceMovement | undefined;
  after: SourceMovement;
}

/** The verdict, exit and agent-operator envelope for one source over the window. */
export function movementReport(before: SourceMovement | undefined, after: SourceMovement, windowMs: number): MovementReport {
  const state = judgeMovement(before, after);
  const ctx = cliRenderContext();
  const id = after.source_id;
  const status: Action = readFix('Read-only: the request at the head, its step and wait cause, the owner process and the next action on the running claim.',
    { argv: ['gbrain', 'sources', 'writer', 'status', '--source', id, '--json'] });
  const verify = { argv: ['gbrain', 'sources', 'writer', 'movement', id, '--json'] };
  const head = after.head?.step ? ` The head is at step ${after.head.step}${after.head.waiting_on && after.head.waiting_on !== 'unknown' ? ` (waiting on ${after.head.waiting_on})` : ''}${after.head.owner ? `, held by ${after.head.owner.kind} pid ${after.head.owner.pid}` : ''}.` : '';
  switch (state) {
    case 'nothing_pending':
      return { source_id: id, state, exit: 0, code: null, why: `${id}: no managed sync is pending${after.holds.count ? ` (${after.holds.count} held file(s) await their repair)` : ''}.`, fix: null, before, after };
    case 'moved':
      return { source_id: id, state, exit: 0, code: null, why: `${id}: a page committed at ${after.last_commit_at} inside the ${Math.round(windowMs / 1000)}s window; ${after.cursor ? `${after.cursor.remaining} remaining` : 'the cursor is done'}.`, fix: null, before, after };
    case 'within_allowance':
      return { source_id: id, state, exit: 0, code: null, retry_after_ms: windowMs,
        why: `${id}: no page committed yet, but the head's step or the cursor advanced inside the window (a multi-wave group commits nothing until its last wave).${head} Check again after one more window.`,
        fix: renderAction({ argv: ['gbrain', 'sources', 'writer', 'movement', id, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'The owner is preparing normally; rerun after retry_after_ms and the next window shows the commit.', verify }, ctx), before, after };
    case 'held': {
      const kinds = after.holds;
      const route = kinds.stalled > 0 ? stalledHoldSteps(id).status : kinds.fences > 0 ? ['gbrain', 'repair', 'fences', '--source', id] : ['gbrain', 'repair', 'frontmatter', '--source', id];
      const then = kinds.stalled > 0 ? ` then ${stalledHoldSteps(id).retry.join(' ')}` : '';
      return { source_id: id, state, exit: 0, code: null,
        why: `${id}: pending work advanced only by holds inside the window (${kinds.count} held: ${kinds.stalled} preparation_stalled, ${kinds.fences} fence, ${kinds.concurrent} concurrent-write). The containment is working, not a stall; the held files need their repair route.`,
        fix: renderAction({ argv: route, consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/repair.md#held-files',
          why: kinds.stalled > 0 ? `Read-only: shows the owner the stalled preparations name;${then} once the cause is fixed.` : 'Read-only preview of the repair; it prints the apply command for the user to approve.', verify }, ctx), before, after };
    }
    case 'parked':
      return { source_id: id, state, exit: 1, code: 'managed_sync_not_moving', reason: 'movement_check',
        why: `${id}: the managed sync cursor is pending at ${after.cursor?.index ?? '?'}/${after.cursor?.total ?? '?'} and nothing live is moving it (no sync run holds the lock; ${after.admitted} admitted request(s), no live consumer on the owner host). After a restart this means the catch-up was not started again.`,
        fix: renderAction({ argv: (after.cursor?.resume_command ?? `gbrain sync --source ${id} --no-pull`).split(' '), consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Resumes the managed catch-up where its cursor stopped; the same command is safe to rerun in a loop.', verify }, ctx), before, after };
    case 'not_moving':
      return { source_id: id, state, exit: 1, code: 'managed_sync_not_moving', reason: 'movement_check',
        why: `${id}: ${after.cursor ? `${after.cursor.remaining} entries pending, ` : ''}no page committed and no step advance inside the ${Math.round(windowMs / 1000)}s window while ${after.live.drain ? `a sync (pid ${after.live.drain_pid}) holds the lock` : 'a consumer is live'}; last progress ${after.last_progress_at ?? 'unknown'}.${head}`,
        fix: renderAction({ ...status, verify }, ctx), before, after };
  }
}

export function formatMovementReport(r: MovementReport): string[] {
  const lines = [`${r.state === 'not_moving' || r.state === 'parked' ? '✗' : '✓'} ${r.source_id}: ${r.state}${r.code ? ` [${r.code}${r.reason ? `/${r.reason}` : ''}]` : ''}`, `  ${r.why}`];
  if (r.fix?.command) lines.push(`  Next: ${r.fix.command}${r.retry_after_ms ? ` (after ${Math.round(r.retry_after_ms / 1000)}s)` : ''}${r.fix.next === 'tell_user_to_run' ? ' (the host operator runs it)' : ''}`);
  return lines;
}

export async function runWriterMovementCli(args: string[], connected?: BrainEngine): Promise<void> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(MOVEMENT_HELP); return; }
  let owned: BrainEngine | undefined;
  let json = false;
  try {
    const parsed = parseMovementArgs(args);
    json = parsed.json;
    const brainId = resolveBrainId(parsed.brain ?? getCliOptions().brain);
    const config = adminHostConfig(persistenceConfigForBrain(loadConfig(), brainId, brainId === 'host' ? [] : loadMounts()), brainId, 'The movement check', 'sources writer movement');
    if (!connected) {
      const { createEngine } = await import('../core/engine-factory.ts');
      owned = await createEngine(toEngineConfig(config));
      await owned.connect(toEngineConfig(config));
    }
    const engine = connected ?? owned!;
    const result = await runMovementCheck(engine, parsed, line => { if (!json) console.error(line); });
    const exitCode = parsed.warnOnly ? 0 : result.exit_code;
    if (json) await writeStdoutFinal(JSON.stringify({ ...result, exit_code: exitCode, warn_only: parsed.warnOnly, selected_brain: brainId }, null, 2) + '\n');
    else for (const r of result.sources) for (const line of formatMovementReport(r)) console.log(line);
    if (!json && !result.sources.length) console.log('No active managed source: nothing to judge (exit 0).');
    if (!json && parsed.warnOnly && result.exit_code !== 0) console.log('--warn-only: exiting 0 despite the verdict above.');
    setCliExitVerdict(exitCode);
  } catch (error) {
    if (!await reportPersistenceCliError(error, json)) {
      console.error(error instanceof Error ? error.message : String(error));
      setCliExitVerdict(1);
    }
  } finally { if (owned) await finishCliTeardown({ engine: owned, drainTimeoutMs: 1000 }); }
}

export interface MovementCheckResult {
  schema_version: 1;
  window_ms: number;
  budget_ms: number;
  window_source: 'default' | '--wait';
  waited_ms: number;
  sources: MovementReport[];
  exit_code: 0 | 1;
  /** The envelope of the first failing source (what a caller reads first), when any. */
  error?: AgentEnvelope;
}

/** Snapshot, wait (ending early once every pending source moved), snapshot, judge. `note` receives the human progress lines. */
export async function runMovementCheck(engine: BrainEngine, opts: { sourceId?: string; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> }, note: (line: string) => void = () => {}): Promise<MovementCheckResult> {
  const policy = await readPreparationPolicy(engine);
  const window = movementWindowMs(policy, opts.waitMs);
  const scope = opts.sourceId ? { sourceIds: [opts.sourceId] } : {};
  const before = await readSourceMovement(engine, scope);
  const pendingBefore = before.filter(m => m.movement_state !== 'nothing_pending');
  note(`[movement] window ${Math.round(window.window_ms / 1000)}s (${window.source === 'default' ? `default: max(300s, sync preparation budget ${Math.round(window.budget_ms / 1000)}s + 60s)` : `--wait, floored at the ${Math.round(window.budget_ms / 1000)}s sync preparation budget`}); `
    + `${before.length} managed source(s), ${pendingBefore.length} with pending work.`);
  const byId = new Map(before.map(m => [m.source_id, m]));
  let after = before, waited = 0;
  if (pendingBefore.length) {
    const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const poll = Math.max(1, Math.min(opts.pollMs ?? POLL_MS, window.window_ms));
    const started = Date.now();
    for (;;) {
      await sleep(Math.min(poll, window.window_ms - waited));
      waited = Date.now() - started;
      after = await readSourceMovement(engine, scope);
      const settled = after.every(m => { const v = judgeMovement(byId.get(m.source_id), m); return v === 'moved' || v === 'nothing_pending'; });
      if (settled || waited >= window.window_ms) break;
      note(`[movement] ${Math.round(waited / 1000)}s: ${after.map(m => `${m.source_id} ${judgeMovement(byId.get(m.source_id), m)}`).join(', ')}`);
    }
  }
  const sources = after.map(m => movementReport(byId.get(m.source_id), m, window.window_ms));
  const failing = sources.find(r => r.exit !== 0);
  const error = failing ? toAgentError(opError('managed_sync_not_moving', failing.why, `Run ${writerStatusCommand(failing.source_id)} and follow the running claim's next step; verify with gbrain sources writer movement ${failing.source_id}.`,
    { reason: failing.reason, fix: readFix('Read-only: the request at the head, its step, wait cause, owner and next action.', { argv: ['gbrain', 'sources', 'writer', 'status', '--source', failing.source_id, '--json'] }) }),
  { transport: 'cli', command: 'sources writer movement', render: cliRenderContext() }) : undefined;
  return { schema_version: 1, window_ms: window.window_ms, budget_ms: window.budget_ms, window_source: window.source, waited_ms: waited, sources, exit_code: failing ? 1 : 0, ...(error ? { error } : {}) };
}
