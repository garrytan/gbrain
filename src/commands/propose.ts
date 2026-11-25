/**
 * `gbrain propose [--days N] [--json]` and `gbrain propose accept|decline <signal>`: onboarding job proposals (agent
 * platform lane 5, O2; core in src/core/onboard/propose.ts). Lists the jobs an agent could take on, found in data
 * already in the brain with no model call, each with a count, cited pages, a sentence and the installed skill or core
 * command that does it; accept and decline record the owner's answer in the first-session record and read it back
 * (exit 1 when the store does not agree). Trusted local CLI; agents use the MCP ops propose_jobs and propose_decide.
 */
import type { BrainEngine } from '../core/engine.ts';

export const PROPOSE_HELP = 'Usage:\n'
  + '  gbrain propose [--days N] [--json]          Jobs your agent could take on, from what is already in this brain\n'
  + '  gbrain propose accept <signal> [--json]     Record that you took a job (it stops being offered at session start)\n'
  + '  gbrain propose decline <signal> [--json]    Record that you do not want it (it is not offered again)\n\n'
  + 'Signals: waiting_on_you, owe_reply, meeting_prep, repeat_question, bulk_senders. --days looks back N days (1-90,\n'
  + 'default 7). No model or provider is called. MCP: propose_jobs, propose_decide (the owner only).\n'
  + 'Guide: docs/guides/job-proposals.md';

export async function runPropose(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const { exitCliError, usageError } = await import('../cli/cli-error.ts');
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(PROPOSE_HELP); return; }
  const { PROPOSE_DEFAULT_DAYS, PROPOSE_MAX_DAYS, PROPOSE_SIGNALS, isProposeSignal, proposeJobs, refreshProposalCache, setProposalDecision, clampDays } = await import('../core/onboard/propose.ts');
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : null;
  if (sub === 'accept' || sub === 'decline') {
    const signal = args[1];
    if (!isProposeSignal(signal)) { exitCliError(usageError(`gbrain propose ${sub} needs a signal.`, `Pass one of ${PROPOSE_SIGNALS.join(', ')}, for example gbrain propose ${sub} owe_reply.`), 'propose', { json }); return; }
    const r = await setProposalDecision(engine, { signal, decision: sub === 'accept' ? 'accepted' : 'declined', by: 'cli' });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.verified ? `${signal}: ${r.decision} (verified in the stored state).` : `${signal}: the answer did not show up in the stored state; nothing is confirmed. Run gbrain propose --json.`);
    if (!r.verified) (await import('../core/cli-force-exit.ts')).setCliExitVerdict(1);
    return;
  }
  if (sub) exitCliError(usageError(`unknown propose subcommand ${sub}.`, 'Run gbrain propose, or gbrain propose accept|decline <signal>.'), 'propose', { json });
  const i = args.indexOf('--days');
  const raw = i === -1 ? undefined : Number(args[i + 1]);
  if (raw !== undefined && !(Number.isInteger(raw) && raw >= 1 && raw <= PROPOSE_MAX_DAYS)) exitCliError(usageError('--days needs a whole number of days from 1 to 90.', 'For example gbrain propose --days 14.'), 'propose', { json });
  const r = await proposeJobs(engine, { days: clampDays(raw) });
  if (r.days === PROPOSE_DEFAULT_DAYS) await refreshProposalCache(engine, { jobs: r.jobs }).catch(() => null); // silent-read-ok: the session-start cache is optional
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  if (!r.jobs.length) { console.log(`No jobs to propose from the last ${r.days} days of this brain. Connect more (gbrain google setup, gbrain transcripts archive) and run it again.`); return; }
  console.log(`Jobs your agent could take on (last ${r.days} days, from what is already in this brain):`);
  r.jobs.forEach((j, n) => {
    console.log(`${n + 1}. ${j.sentence}${j.decision ? ` [${j.decision}]` : ''}`);
    if (j.cites.length) console.log(`   Pages: ${j.cites.map(c => c.slug).join(', ')}${j.count > j.cites.length && j.signal !== 'waiting_on_you' ? ' ...' : ''}`);
    console.log(j.handled_by.kind === 'skill' ? `   Do it with: skill ${j.handled_by.id} (${j.handled_by.catalog}); or: ${j.fallback_command}` : `   Do it with: ${j.fallback_command}`);
    console.log(`   Signal: ${j.signal}`);
  });
  if (r.quiet.length) console.log(`Nothing found for: ${r.quiet.join(', ')}.`);
  console.log('Answer one: gbrain propose accept|decline <signal>. Agents: MCP propose_jobs and propose_decide.');
}
