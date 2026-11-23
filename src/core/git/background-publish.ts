/**
 * GST-2988 PR 2: the background retry of a publish that ran past its budget. When a managed worktree's Git effect
 * publishes and the keep-checkout child stops with publish_secret_rebuild_unbounded (redacting a long unpushed range)
 * or with a scan timeout (publish_scan_unreadable, timed_out), the owner starts the same publish once more in a
 * detached child with BACKGROUND_BUDGET_FACTOR times the budget (gbrain git commit-push --scan-timeout, one bound on
 * the whole publish: its scans, the redaction and the scans after it, so the child holds the publish lock no longer) and moves on: the root's Git effects retry as a dependency wait while it runs, and
 * effects of other roots are not held. The child's JSON result is kept beside the commit ledger; the next attempt
 * reads it. A run that ends over budget again, or racing new commits (publish_secret_rebuild_race), is final: the
 * effects are held as publish_scan_unreadable until the remote branch moves (a publish by hand), whatever HEAD does.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from '../spawn.ts';
import { isPidAlive } from '../autopilot-lock.ts';
import { DEFAULT_SCAN_TIMEOUT_MS } from './range-secret-scan.ts';
import { ledgerLocation } from './commit-ledger.ts';

export const BACKGROUND_BUDGET_FACTOR = 2;
/** The budget the background run gets: 2x the default publish budget (10 minutes), the longest it holds the publish lock past one in-flight fetch or push. */
export const BACKGROUND_BUDGET_MS = BACKGROUND_BUDGET_FACTOR * DEFAULT_SCAN_TIMEOUT_MS;
/** A background run older than this is treated as gone (fetches, pushes and both budgets fit well inside it). */
const MAX_AGE_MS = 2 * BACKGROUND_BUDGET_MS + 600_000;

interface State { pid: number; head: string; remote_tip: string; budget_ms: number; started_at: string; out: string }
export type BackgroundPublish =
  | { state: 'none' }
  | { state: 'running'; head: string; started_at: string }
  | { state: 'done'; head: string; remote_tip: string; doc: Record<string, unknown> | null };

function paths(root: string): { dir: string; state: string } | null {
  const loc = ledgerLocation(root);
  if (!loc) return null;
  const dir = join(loc.common, 'gbrain');
  return { dir, state: join(dir, 'background-publish.json') };
}

/** Whether codes from a keep-checkout publish call for the background retry: an over-budget redaction or scan. */
export function overBudget(code: string, detail: string | null | undefined): boolean {
  if (code === 'publish_secret_rebuild_unbounded') return true;
  if (code !== 'publish_scan_unreadable' || !detail) return false;
  try { return (JSON.parse(detail) as { timed_out?: unknown }).timed_out === true; } catch { return false; }
}

/** The background run recorded for the checkout holding root. */
export function backgroundPublish(root: string, now = Date.now()): BackgroundPublish {
  const p = paths(root);
  if (!p) return { state: 'none' };
  let state: State;
  try { state = JSON.parse(readFileSync(p.state, 'utf8')) as State; } catch { return { state: 'none' }; }
  if (!state?.pid || !state.head) return { state: 'none' };
  if (isPidAlive(state.pid) && now - Date.parse(state.started_at) < MAX_AGE_MS) return { state: 'running', head: state.head, started_at: state.started_at };
  let doc: Record<string, unknown> | null = null;
  try { doc = JSON.parse(readFileSync(state.out, 'utf8').trim().split('\n').filter(Boolean).pop() ?? '') as Record<string, unknown>; } catch { /* no result */ }
  return { state: 'done', head: state.head, remote_tip: state.remote_tip ?? '', doc };
}

/** Forgets the recorded background run (its result has been read). */
export function clearBackgroundPublish(root: string): void {
  const p = paths(root);
  if (!p) return;
  try { const state = JSON.parse(readFileSync(p.state, 'utf8')) as State; rmSync(state.out, { force: true }); } catch { /* none */ }
  rmSync(p.state, { force: true });
}

/** Starts the detached publish of root with the longer budget; head is the commit it was started for, remoteTip the remote branch then. */
export function startBackgroundPublish(root: string, head: string, remoteTip: string, cli: { cmd: string; argsPrefix: string[] }): void {
  const p = paths(root);
  if (!p) return;
  mkdirSync(p.dir, { recursive: true });
  const out = join(p.dir, `background-publish-${head.slice(0, 12)}.out`);
  const fd = openSync(out, 'w', 0o600);
  try {
    const child = spawn(cli.cmd, [...cli.argsPrefix, 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets',
      '--scan-timeout', String(Math.round(BACKGROUND_BUDGET_MS / 1000)), '--path', root, '--json'],
    { detached: true, stdio: ['ignore', fd, 'ignore'], env: { ...process.env, GBRAIN_PUBLISH_LOCK_WAIT_SECONDS: '600', GBRAIN_PUSH_LOCK_WAIT_SECONDS: '600' } });
    child.unref();
    const state: State = { pid: child.pid ?? 0, head, remote_tip: remoteTip, budget_ms: BACKGROUND_BUDGET_MS, started_at: new Date().toISOString(), out };
    const tmp = `${p.state}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, p.state);
  } finally { closeSync(fd); }
}
