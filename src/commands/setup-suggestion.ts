/**
 * setup-suggestion.ts: gbrain setup's side of the first-session suggestion (onboarding roadmap PR 2; core in
 * src/core/onboard/first-session.ts). Setup is engine-free, so it reads and writes the suggestion through
 * `gbrain onboarding status|off --json` children. `--no-suggestion` turns it off for this install; every run that is not a
 * dry run reports one machine-readable `suggestion` marker in `setup --json`, next to `history`: armed, or off and why, with
 * the flag and the command that turn it off. A --no-suggestion that setup could not confirm is `failed`, and setup exits 1.
 */
import { bunSpawnSync } from '../core/spawn.ts';

const CHILD_TIMEOUT_MS = 20_000;

export interface SuggestionMarker {
  version: 1;
  state: 'armed' | 'off' | 'unknown';
  reason?: string;
  why: string;
  delivered_sessions?: number;
  max_sessions?: number;
  window_ends_at?: string | null;
  off_flag: '--no-suggestion';
  off_argv: string[];
  off_mcp: 'onboarding_off';
}

/** --no-suggestion is for gbrain setup claude-code or codex (not --remove or --instructions-only); a string is the exit-2 refusal. */
export function parseSuggestionFlag(args: string[], harness: string | undefined): boolean | string {
  if (!args.includes('--no-suggestion')) return false;
  if (harness !== 'claude-code' && harness !== 'codex') return '--no-suggestion turns off the first-session suggestion gbrain setup claude-code or codex arms; nothing was written';
  if (args.includes('--remove') || args.includes('--instructions-only')) return '--no-suggestion applies to a setup that wires the brain, not --remove or --instructions-only; nothing was written';
  return true;
}

const base = () => ({ off_flag: '--no-suggestion' as const, off_argv: ['gbrain', 'onboarding', 'off'], off_mcp: 'onboarding_off' as const });

function child(launcher: string, args: string[]): Record<string, any> | { error: string } {
  const run = bunSpawnSync([launcher, '--brain', 'host', 'onboarding', ...args, '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: CHILD_TIMEOUT_MS });
  try { return JSON.parse(run.stdout?.toString() ?? ''); } catch { return { error: (run.stderr?.toString() ?? '').trim().split('\n').at(-1) || `gbrain onboarding ${args[0]} printed no JSON` }; }
}

/** The suggestion step of one setup run, after the history step; null on a dry run. */
export function suggestionFor(ctx: { launcher: string; noSuggestion: boolean; dryRun: boolean; liveServe: { pid: number; started_at?: string } | null }): { marker: SuggestionMarker; line: string; failed?: true } | null {
  if (ctx.dryRun) return null;
  const b = base();
  if (ctx.liveServe) {
    const owner = `a running gbrain server (PID ${ctx.liveServe.pid}${ctx.liveServe.started_at ? `, started ${ctx.liveServe.started_at}` : ''}) holds this brain, which is expected while an agent session is open and needs no fix`;
    const why = ctx.noSuggestion
      ? `Setup could not turn the first-session suggestion off now: ${owner}. Run gbrain onboarding off once it stops, or call onboarding_off from that session.`
      : `Setup could not read the first-session suggestion now: ${owner}. gbrain onboarding status reads it once the server stops (MCP: onboarding_status).`;
    return { marker: { version: 1, state: 'unknown', reason: 'live_serve', why, ...b }, line: `First-session suggestion: unknown. ${why}`, ...(ctx.noSuggestion ? { failed: true as const } : {}) };
  }
  if (ctx.noSuggestion) {
    const off = child(ctx.launcher, ['off', '--by', 'setup']);
    if ('error' in off || off.verified !== true) {
      const why = `Setup could not confirm the first-session suggestion is off (${'error' in off ? off.error : 'the stored state does not say stopped'}); run gbrain onboarding off.`;
      return { marker: { version: 1, state: 'unknown', reason: 'stop_unverified', why, ...b }, line: `First-session suggestion: ${why}`, failed: true };
    }
  }
  const s = child(ctx.launcher, ['status']);
  if ('error' in s || (s.state !== 'armed' && s.state !== 'off')) {
    const why = `Setup could not read the first-session suggestion (${'error' in s ? s.error : 'unexpected status'}); gbrain onboarding status reads it.`;
    return { marker: { version: 1, state: 'unknown', reason: 'status_unreadable', why, ...b }, line: `First-session suggestion: ${why}` };
  }
  const marker: SuggestionMarker = {
    version: 1, state: s.state, ...(s.reason ? { reason: s.reason } : {}), why: s.why,
    delivered_sessions: s.delivered_sessions, max_sessions: s.max_sessions, window_ends_at: s.window_ends_at, ...b,
  };
  const line = s.state === 'armed'
    ? `First-session suggestion: armed for the first ${s.max_sessions} sessions; the agent offers one thing it found in the brain, then one more import. Turn it off: gbrain onboarding off (or setup --no-suggestion).`
    : `First-session suggestion: off (${s.reason}).`;
  return { marker, line };
}
