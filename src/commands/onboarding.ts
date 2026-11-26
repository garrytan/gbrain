/**
 * `gbrain onboarding status|off`: the first-session suggestion (onboarding roadmap PR 2, core in
 * src/core/onboard/first-session.ts). status says whether it is armed and why not when it is off, plus the newest
 * startup session's outcome from the local hook record; off turns it off for this install and reads the stored state
 * back (exit 1 when the store does not say stopped). Trusted local CLI; agents use the MCP ops onboarding_status and
 * onboarding_off (src/core/ops/onboarding.ts).
 */
import type { BrainEngine } from '../core/engine.ts';

export const ONBOARDING_HELP = 'Usage:\n'
  + '  gbrain onboarding status [--json]   Is the first-session suggestion armed, and why not when it is off\n'
  + '  gbrain onboarding off [--json]      Turn it off for this install (verified against the stored state)\n\n'
  + 'For the first 3 sessions within 14 days of setup on a new personal brain, the session-start context tells the\n'
  + 'agent to offer one thing it found in the brain, citing it, then one more import. setup --no-suggestion turns it\n'
  + 'off at install time; MCP: onboarding_status, onboarding_off. Guide: docs/guides/first-session-suggestion.md';

export async function runOnboarding(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes('--json');
  const { exitCliError, usageError } = await import('../cli/cli-error.ts');
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help' || args.includes('--help') || args.includes('-h')) { console.log(ONBOARDING_HELP); return; }
  const ctx = { engine, remote: false } as unknown as import('../core/ops/contract.ts').OperationContext;
  if (sub === 'status') {
    const { onboardingStatusFor } = await import('../core/ops/onboarding.ts');
    const s = await onboardingStatusFor(ctx);
    if (json) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(s.why);
    console.log(`Delivered: ${s.delivered_sessions} of ${s.max_sessions} sessions${s.window_ends_at ? `; window ends ${s.window_ends_at}` : ''}.`);
    if (s.last_session) console.log(`Newest startup session (${s.last_session.harness}, ${s.last_session.ts}): ${s.last_session.outcome}${s.last_session.reason ? ` (${s.last_session.reason})` : ''}.`);
    if (s.state === 'armed') console.log(`Turn it off: ${s.off.argv.join(' ')} (MCP ${s.off.mcp}).`);
    return;
  }
  if (sub === 'off') {
    const { stopFirstSession } = await import('../core/onboard/first-session.ts');
    const r = await stopFirstSession(engine, { by: args[args.indexOf('--by') + 1] === 'setup' && args.includes('--by') ? 'setup' : 'cli' });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.verified ? `First-session suggestion: off (${r.already ? 'it already was' : 'verified in the stored state'}).` : 'First-session suggestion: the stop did not show up in the stored state; nothing is confirmed. Run gbrain onboarding status.');
    if (!r.verified) (await import('../core/cli-force-exit.ts')).setCliExitVerdict(1);
    return;
  }
  exitCliError(usageError(`unknown onboarding subcommand ${sub}.`, 'Pass status or off, for example gbrain onboarding status --json.'), 'onboarding', { json });
}
