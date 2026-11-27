/**
 * #7242: the terminal hook. A command from LOCAL file-plane config (`minions.terminal_hook` in
 * ~/.gbrain/config.json, set with `gbrain config set minions.terminal_hook '["/abs/path", "arg"]'`) that the
 * worker runs once each job it ran reaches completed, failed, dead or cancelled. It is off by default and is
 * never read from the database config plane, MCP or job data, so nobody who can only submit jobs or write DB
 * config can choose what runs.
 *
 * The command is an argv array spawned without a shell; job data is never interpolated into it. The job
 * arrives in a fixed set of env vars (GBRAIN_JOB_ID, GBRAIN_JOB_NAME, GBRAIN_JOB_QUEUE, GBRAIN_JOB_STATUS)
 * and as one JSON object on stdin (TERMINAL_HOOK_FIELDS, never data or result). It runs as the gbrain process
 * user with that process's environment, is killed after timeout_ms (default 10 s), and a failure is logged
 * once and never retried, never changing the job.
 */
import { spawn } from '../spawn.ts';
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { isTerminalJobStatus } from './wait-for-completion.ts';
import { rowToMinionJob, type MinionJob } from './types.ts';

export const TERMINAL_HOOK_CONFIG_KEY = 'minions.terminal_hook';
export const TERMINAL_HOOK_DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONCURRENT = 4;
const TERMINAL_HOOK_FIELDS = ['id', 'name', 'queue', 'status', 'attempts_made', 'parent_job_id', 'created_at', 'started_at', 'finished_at', 'error_text'] as const;

export interface TerminalHook { argv: string[]; timeout_ms: number }
export type TerminalHookOutcome = 'ok' | 'exit_nonzero' | 'timeout' | 'spawn_error' | 'skipped_busy';

/** The validated hook from a config value (an argv array, or {argv, timeout_ms}); a string or relative argv[0] is an error. */
export function parseTerminalHook(raw: unknown): TerminalHook {
  const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const argv = Array.isArray(value) ? value : record?.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string' && a.length > 0 && !a.includes('\0'))) {
    throw new Error(`${TERMINAL_HOOK_CONFIG_KEY} must be a JSON array of strings (the command and its arguments, no shell), e.g. ["/usr/local/bin/notify-job"]`);
  }
  if (!isAbsolute(argv[0])) throw new Error(`${TERMINAL_HOOK_CONFIG_KEY}: the command must be an absolute path (got a relative one).`);
  const t = record?.timeout_ms;
  if (t !== undefined && !(typeof t === 'number' && Number.isInteger(t) && t >= 100 && t <= MAX_TIMEOUT_MS)) {
    throw new Error(`${TERMINAL_HOOK_CONFIG_KEY}.timeout_ms must be an integer from 100 to ${MAX_TIMEOUT_MS}.`);
  }
  return { argv: argv as string[], timeout_ms: (t as number | undefined) ?? TERMINAL_HOOK_DEFAULT_TIMEOUT_MS };
}

/** The configured hook, or null when none is set. A malformed value logs once and disables the hook. */
export function resolveTerminalHook(cfg: GBrainConfig | null): TerminalHook | null {
  const raw = (cfg as { minions?: { terminal_hook?: unknown } } | null)?.minions?.terminal_hook;
  if (raw == null) return null;
  try { return parseTerminalHook(raw); }
  catch (e) { console.warn(`[worker] terminal hook disabled: ${(e as Error).message}`); return null; }
}

/** `gbrain config set minions.terminal_hook <json>`: validate, then write the file plane only. */
export function setTerminalHookConfig(cfg: GBrainConfig, value: string, save: (cfg: GBrainConfig) => void): void {
  let hook: TerminalHook;
  try { hook = parseTerminalHook(value); }
  catch (e) { console.error(`[config] ${e instanceof SyntaxError ? `${TERMINAL_HOOK_CONFIG_KEY} is not valid JSON` : (e as Error).message}. Nothing was written.`); process.exit(1); }
  const stored = hook.timeout_ms === TERMINAL_HOOK_DEFAULT_TIMEOUT_MS ? hook.argv : hook;
  save({ ...cfg, minions: { ...((cfg as { minions?: object }).minions ?? {}), terminal_hook: stored } } as GBrainConfig);
  console.log(`Set ${TERMINAL_HOOK_CONFIG_KEY} (file plane: ~/.gbrain/config.json). Workers started after this run it, as the gbrain process user, when a job they ran finishes; restart the worker or supervisor to apply.`);
}

function hookPayload(job: MinionJob): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TERMINAL_HOOK_FIELDS) {
    const v = job[f];
    out[f] = v instanceof Date ? v.toISOString() : f === 'error_text' && typeof v === 'string' ? v.slice(0, 2000) : v ?? null;
  }
  return out;
}

/** Run the hook for one terminal job. Never throws; resolves with how it ended. */
export function runTerminalHook(hook: TerminalHook, job: MinionJob): Promise<TerminalHookOutcome> {
  return new Promise(resolve => {
    let settled = false;
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (outcome: TerminalHookOutcome, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome !== 'ok') console.warn(`[worker] terminal hook for job ${job.id} (${job.name}, ${job.status}) ${outcome}${detail ? `: ${detail}` : ''}`);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.argv[0], hook.argv.slice(1), {
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, GBRAIN_JOB_ID: String(job.id), GBRAIN_JOB_NAME: job.name, GBRAIN_JOB_QUEUE: job.queue, GBRAIN_JOB_STATUS: job.status },
      });
    } catch (e) {
      done('spawn_error', (e as Error).message);
      return;
    }
    timer = setTimeout(() => { child.kill('SIGKILL'); done('timeout', `killed after ${hook.timeout_ms}ms`); }, hook.timeout_ms);
    child.on('error', e => done('spawn_error', e.message));
    child.stderr?.on('data', (b: Buffer) => { if (stderr.length < 500) stderr += b.toString('utf8'); });
    child.on('close', (code, signal) => done(code === 0 ? 'ok' : 'exit_nonzero', `exit ${code ?? signal}${stderr ? `, stderr: ${stderr.trim().slice(0, 300)}` : ''}`));
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(hookPayload(job)) + '\n');
  });
}

/**
 * The worker's `onJobSettled` callback: re-read the row and run the hook when it is terminal. A job handed back
 * (waiting, delayed) is not an event. At most MAX_CONCURRENT hooks run at once; past that one is skipped and logged.
 */
export function terminalHookNotifier(engine: BrainEngine, hook: TerminalHook): { onJobSettled: (job: MinionJob) => void; drain: () => Promise<void> } {
  const running = new Set<Promise<unknown>>();
  const onJobSettled = (claimed: MinionJob) => {
    const p = (async () => {
      const row = await engine.getJob(claimed.id);
      const job = row ? rowToMinionJob(row) : null;
      if (!job || !isTerminalJobStatus(job.status)) return;
      if (running.size - 1 >= MAX_CONCURRENT) { console.warn(`[worker] terminal hook for job ${job.id} skipped_busy: ${MAX_CONCURRENT} hooks already running`); return; }
      await runTerminalHook(hook, job);
    })().catch(e => console.warn(`[worker] terminal hook for job ${claimed.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    running.add(p);
    void p.finally(() => running.delete(p));
  };
  return { onJobSettled, drain: async () => { await Promise.allSettled([...running]); } };
}
