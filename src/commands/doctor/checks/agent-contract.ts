/**
 * `agent_contract` (agent-first operator wave E11): reads the bounded
 * agent-contract event log (`readAgentContractEvents()`, written by dispatch,
 * `renderCliError`, `requireConsent`, the budget tracker and the `--json`
 * guard) and warns when agents recently hit a dead end: `internal_error` or
 * suggestion-less envelopes, unattended runs refused for consent, derived
 * spend caps exhausted, or a `--json` command that printed no document. The
 * fix is the exact preapproval command when one would have let the run
 * proceed. Engine-free, read-only; the log never holds params or messages.
 */
import { readAgentContractEvents, type AgentContractEvent } from '../../../core/agent-contract-log.ts';
import { PREAPPROVE_PAID_MAX_USD_PER_RUN, PREAPPROVE_PERSISTENT_INSTALL, preapprovalCommand } from '../../../core/consent-preapproval.ts';
import type { Action } from '../../../core/agent-output.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import type { DoctorEntry } from '../context.ts';

const NAME = 'agent_contract';
export const AGENT_CONTRACT_WINDOW_DAYS = 7;
const USD_INPUT = 'usd';

type Event = AgentContractEvent & { ts: string };

function who(e: Event): string { return e.op ?? e.command ?? 'unknown'; }

function top(events: readonly Event[], n = 3): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(who(e), (counts.get(who(e)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k, v]) => `${k}×${v}`).join(', ');
}

function preapprovePaid(): Action {
  return {
    argv: preapprovalCommand(PREAPPROVE_PAID_MAX_USD_PER_RUN, '<usd>'),
    consent: ['paid'], actor: 'user', requires_exclusive: false, verify: doctorVerify(NAME),
    inputs: [{ name: USD_INPUT, how: 'Ask the user the most gbrain may spend per run without asking first (for example 1).' }],
    why: 'Unattended paid runs stopped for consent or hit their derived cap. A per-run preapproval lets them proceed up to that amount; only the user may grant it.',
    user_message: 'Some background gbrain work stopped because it would spend money and nobody was there to approve it. Want to let gbrain spend up to a fixed amount per run without asking? If so, run this with your limit in dollars.',
    docs: 'docs/protocol/AGENT_OPERATOR_v1.md',
  };
}

function preapproveInstall(): Action {
  return {
    argv: preapprovalCommand(PREAPPROVE_PERSISTENT_INSTALL, 'true'),
    consent: ['persistent_install'], actor: 'user', requires_exclusive: false, verify: doctorVerify(NAME),
    why: 'Unattended runs that install background services or harness config stopped for consent. This preapproval covers installs only, never credentials.',
    user_message: 'gbrain wanted to install a background service and nobody was there to approve it. Run this if you want such installs to proceed without asking.',
    docs: 'docs/protocol/AGENT_OPERATOR_v1.md',
  };
}

/** Pure: the check for a list of events (newest last), relative to `now`. */
export function agentContractCheck(events: readonly Event[], now = Date.now()): Check {
  const since = now - AGENT_CONTRACT_WINDOW_DAYS * 86_400_000;
  const recent = events.filter((e) => Date.parse(e.ts) >= since);
  const faults = recent.filter((e) => e.code === 'internal_error' || e.code === 'internal' || e.has_suggestion === false);
  const refused = recent.filter((e) => e.code === 'confirmation_required' && (e.outcome === 'refused' || e.outcome === 'declined'));
  const paidRefused = refused.filter((e) => e.effects?.includes('paid'));
  const installRefused = refused.filter((e) => e.effects?.includes('persistent_install') && !e.effects.includes('paid'));
  const capped = recent.filter((e) => e.code === 'derived_cap_exhausted');
  const noDoc = recent.filter((e) => e.code === 'json_document_missing');
  const details = {
    window_days: AGENT_CONTRACT_WINDOW_DAYS, events: recent.length,
    internal_errors: faults.length, consent_refused: refused.length, derived_cap_exhausted: capped.length, json_document_missing: noDoc.length,
  };
  const parts: string[] = [];
  if (faults.length) parts.push(`${faults.length} error(s) reached an agent without a specific next step (${top(faults)}); report them to the user with \`gbrain doctor --json\` output`);
  if (refused.length) parts.push(`${refused.length} unattended run(s) stopped for consent (${top(refused)})`);
  if (capped.length) parts.push(`${capped.length} paid run(s) hit their derived spend cap (${top(capped)})`);
  if (noDoc.length) parts.push(`${noDoc.length} \`--json\` run(s) printed no JSON document (${top(noDoc)})`);
  if (parts.length === 0) {
    return { name: NAME, status: 'ok', message: `No agent dead ends in the last ${AGENT_CONTRACT_WINDOW_DAYS} days (${recent.length} non-success event(s) logged).`, details };
  }
  const fix = paidRefused.length || capped.length ? preapprovePaid() : installRefused.length ? preapproveInstall() : undefined;
  return {
    name: NAME, status: 'warn', message: `Last ${AGENT_CONTRACT_WINDOW_DAYS} days: ${parts.join('; ')}.`, details,
    ...(fix ? { fix } : { fix_unavailable_reason: 'operator_judgement' as const }),
  };
}

async function runAgentContract(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(agentContractCheck(readAgentContractEvents()));
  return checks;
}

export const agentContractEntry: DoctorEntry = {
  name: 'agent_contract',
  emits: ['agent_contract'],
  run: runAgentContract,
};
