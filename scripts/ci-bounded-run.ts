#!/usr/bin/env bun
/**
 * Run one CI setup command with a per-attempt bound and one retry.
 *
 * A network-bound setup step (`bun install`, Playwright's browser and OS
 * dependency install) normally takes seconds, and on a bad registry, mirror or
 * CDN connection it can crawl until the job timeout cancels it, with nothing
 * naming the cause (.195's 805 s `bun install` on darwin-x64; .204's 12-minute
 * `playwright install --with-deps chromium` on admin-browser). This runs the
 * command in its own process group and ends an attempt (SIGTERM to the group,
 * so `sudo apt-get` under it is relayed the signal, then SIGKILL after a grace
 * period) when it stalls: still running at `--attempt-s`, or silent on stdout
 * and stderr for `--idle-s`. A stalled attempt is retried once after a pause,
 * and a second failure stops with a named `::error::`. `--total-s` caps every
 * attempt and pause together, so a slow download that keeps printing progress
 * runs to the budget instead of being restarted from zero, and no retry starts
 * without time left for it. A failure that is not a stall is retried once too
 * and then reported with the command's exit code. No dependency: it runs
 * before they are installed.
 *
 * Usage: bun scripts/ci-bounded-run.ts (--attempt-s <n> | --total-s <n>) [--idle-s <n>] [--retry-s <n>] [--hint <text>] -- <command> [args...]
 */
import { spawn } from 'node:child_process';

export interface BoundedRun {
  argv: string[];
  /** The command as the annotations name it. */
  label: string;
  /** Wall-clock bound on one attempt. */
  attemptSeconds?: number;
  /** An attempt that prints nothing on stdout or stderr for this long is stalled. */
  idleSeconds?: number;
  /** Wall-clock budget for every attempt and pause together; no retry starts once it is spent. */
  totalSeconds?: number;
  retrySeconds: number;
  /** Why a stall is unusual for this command, appended to the stall line. */
  hint?: string;
  graceSeconds?: number;
}

const ATTEMPTS = 2;

type Ending = 'exit' | 'attempt' | 'idle' | 'budget';

function attempt(run: BoundedRun, boundMs: number, budgetBound: boolean): Promise<{ code: number | null; ending: Ending }> {
  const grouped = process.platform !== 'win32';
  const watched = run.idleSeconds !== undefined;
  const child = spawn(run.argv[0]!, run.argv.slice(1), { stdio: ['ignore', watched ? 'pipe' : 'inherit', watched ? 'pipe' : 'inherit'], detached: grouped });
  const signal = (name: NodeJS.Signals) => {
    try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* the group is gone */ }
  };
  let ending: Ending = 'exit', kill: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
  const end = (why: Ending) => {
    if (ending !== 'exit') return;
    ending = why;
    signal('SIGTERM');
    kill = setTimeout(() => signal('SIGKILL'), (run.graceSeconds ?? 10) * 1000);
  };
  const bound = Number.isFinite(boundMs) ? setTimeout(() => end(budgetBound ? 'budget' : 'attempt'), boundMs) : undefined;
  const quiet = () => { clearTimeout(idle); idle = setTimeout(() => end('idle'), run.idleSeconds! * 1000); };
  if (watched) {
    quiet();
    child.stdout!.on('data', chunk => { process.stdout.write(chunk); quiet(); });
    child.stderr!.on('data', chunk => { process.stderr.write(chunk); quiet(); });
  }
  const settle = () => { clearTimeout(bound); clearTimeout(kill); clearTimeout(idle); };
  return new Promise(resolve => {
    child.once('error', () => { settle(); resolve({ code: 127, ending }); });
    child.once('exit', code => { settle(); if (ending !== 'exit') signal('SIGKILL'); resolve({ code, ending }); });
  });
}

export async function runBounded(run: BoundedRun): Promise<number> {
  const deadline = run.totalSeconds !== undefined ? Date.now() + run.totalSeconds * 1000 : Infinity;
  const hint = run.hint ? ` (${run.hint})` : '';
  for (let n = 1; ; n++) {
    const started = Date.now();
    const attemptMs = run.attemptSeconds !== undefined ? run.attemptSeconds * 1000 : Infinity;
    const { code, ending } = await attempt(run, Math.min(attemptMs, deadline - started), deadline - started <= attemptMs);
    if (code === 0 && ending === 'exit') return 0;
    const why = {
      exit: `exited ${code} after ${Math.round((Date.now() - started) / 1000)}s`,
      attempt: `stalled: no result after ${run.attemptSeconds}s${hint}`,
      idle: `stalled: no output for ${run.idleSeconds}s${hint}`,
      budget: `was still running when its ${run.totalSeconds}s budget ran out${hint}`,
    }[ending];
    if (n >= ATTEMPTS || deadline - Date.now() <= run.retrySeconds * 1000) {
      console.error(`::error::${run.label} ${why} on attempt ${n} of ${ATTEMPTS}; giving up`);
      return 1;
    }
    console.error(`::warning::${run.label} attempt ${n} ${why}; retrying in ${run.retrySeconds}s`);
    await Bun.sleep(run.retrySeconds * 1000);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2), split = args.indexOf('--');
  const option = (name: string) => { const i = args.indexOf(name); return i >= 0 && i < split ? args[i + 1] : undefined; };
  const seconds = (name: string) => { const v = option(name); return v === undefined ? undefined : Number(v); };
  const argv = split >= 0 ? args.slice(split + 1) : [];
  const attemptSeconds = seconds('--attempt-s'), idleSeconds = seconds('--idle-s'), totalSeconds = seconds('--total-s');
  const valid = [attemptSeconds, idleSeconds, totalSeconds].every(v => v === undefined || v > 0);
  if (!argv.length || !valid || (attemptSeconds === undefined && totalSeconds === undefined)) {
    console.error('usage: bun scripts/ci-bounded-run.ts (--attempt-s <n> | --total-s <n>) [--idle-s <n>] [--retry-s <n>] [--hint <text>] -- <command> [args...]');
    process.exit(2);
  }
  process.exit(await runBounded({ argv, label: argv.join(' '), attemptSeconds, idleSeconds, totalSeconds, retrySeconds: Number(option('--retry-s') ?? 10), hint: option('--hint') }));
}
