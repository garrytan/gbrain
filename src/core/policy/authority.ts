/**
 * Owner authority for agent policy changes (decision F1). The governed agent often has a local
 * shell, so a local write is not proof of the owner. A change is approved only with positive,
 * revision-bound authority: the owner types the policy digest at a terminal prompt in a process
 * that carries no agent marker, or approves the revision in the owner HTTP session. A marker can
 * only add a refusal; a process with no marker and no terminal is refused too.
 *
 * The approval records (config `policy.approved.<scope>`) and `brain_first.*` settings are
 * reserved: every config writer refuses them unless it runs inside withOwnerProof, which only
 * the confirmed paths enter, carrying the proof they store beside the digest.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { userInfo } from 'node:os';
import type { Action } from '../agent-output.ts';
import { ownerWriteAgentMarker, promptLineStderr } from '../interaction.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { reservedConfigWriteRefused, withReservedConfigWrite } from '../config-snapshot.ts';

export const POLICY_APPROVAL_PREFIX = 'policy.approved.';
export const BRAIN_FIRST_CONFIG_PREFIX = 'brain_first.';
export const OWNER_SESSION_ROUTE = 'POST /admin/api/policy/accept';
/** Hex characters of the digest the owner types to approve a change. */
export const CONFIRM_CODE_LENGTH = 8;

export interface OwnerProof {
  method: 'terminal' | 'owner_session';
  at: string;
  /** The digest the owner confirmed: the proof is bound to exactly this policy text. */
  digest: string;
  /** OS user at the terminal, or the owner session's principal. */
  by: string;
  /** Agent markers checked and found absent (terminal only). */
  markers_absent?: true;
}

const proofScope = new AsyncLocalStorage<OwnerProof>();

/** The one guard every config writer calls: a reserved key is written only inside a confirmed path. */
export function assertConfigKeyWritable(key: string): void {
  if (!reservedConfigWriteRefused(key) || proofScope.getStore()) return;
  throw opError('policy_approval_reserved', `${key} is written only by an owner-confirmed policy command, so nothing was changed.`,
    key.startsWith(POLICY_APPROVAL_PREFIX)
      ? 'Approve a policy change with gbrain policy accept <revision>, run by the owner in their own terminal.'
      : 'Change it with gbrain config set run by the owner in their own terminal, outside any agent session; it asks for confirmation.',
    { fix: { argv: key.startsWith(POLICY_APPROVAL_PREFIX) ? ['gbrain', 'policy', 'show'] : ['gbrain', 'config', 'get', key], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the current state; the change itself needs the owner.' } });
}

export function withOwnerProof<T>(proof: OwnerProof, fn: () => Promise<T>): Promise<T> {
  return proofScope.run(proof, () => withReservedConfigWrite(fn));
}

export interface TerminalProbe {
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  /** Test seam: the line the owner types. */
  readAnswer?: (prompt: string) => Promise<string | null>;
}

/** Why this process cannot confirm as the owner, or null when it can prompt. */
export function terminalAuthorityProblem(probe: TerminalProbe = {}): { reason: 'agent_marker'; marker: string } | { reason: 'no_terminal' } | null {
  const marker = ownerWriteAgentMarker(probe.env ?? process.env);
  if (marker) return { reason: 'agent_marker', marker };
  const tty = (probe.stdinIsTTY ?? process.stdin.isTTY === true) && (probe.stderrIsTTY ?? process.stderr.isTTY === true);
  return tty ? null : { reason: 'no_terminal' };
}

/** policy_confirm_required: the owner runs `argv` in their own terminal, or approves in the owner session. */
export function confirmRequiredError(argv: string[], problem: { reason: 'agent_marker'; marker: string } | { reason: 'no_terminal' } | { reason: 'declined' }, extra = ''): OperationError {
  const command = argv.join(' ');
  const cause = problem.reason === 'agent_marker'
    ? `this process carries the agent marker ${problem.marker}, so it may be the agent itself`
    : problem.reason === 'no_terminal' ? 'no terminal is attached to answer the confirmation prompt' : 'the confirmation code was not typed';
  const fix: Action = {
    argv, consent: [], actor: 'user', requires_exclusive: false,
    why: `An agent policy change needs the owner's own confirmation (${cause}).${extra ? ` ${extra}` : ''}`,
    user_message: `Run this in your own terminal, outside the agent session: ${command} — it shows the change and asks you to type a short code. `
      + `Or approve the same revision in the owner session (${OWNER_SESSION_ROUTE} on your running gbrain serve --http).`,
  };
  const e = opError('policy_confirm_required', `The agent policy was not changed: ${cause}.`,
    `Ask the owner to run ${command} in their own terminal, outside the agent session, or to approve it in the owner session. Do not retry it here.`,
    { fix, reason: problem.reason, ...(problem.reason === 'agent_marker' ? { detail: `marker: ${problem.marker}` } : {}) });
  return e;
}

/**
 * Ask the owner to type the first CONFIRM_CODE_LENGTH characters of `digest`. Throws
 * policy_confirm_required (naming the marker or the missing terminal) when this process cannot
 * be the owner, or when the code is not typed.
 */
export async function confirmOnTerminal(opts: { argv: string[]; summary: string[]; digest: string; probe?: TerminalProbe }): Promise<OwnerProof> {
  const problem = terminalAuthorityProblem(opts.probe);
  if (problem) throw confirmRequiredError(opts.argv, problem);
  const code = opts.digest.slice(0, CONFIRM_CODE_LENGTH);
  process.stderr.write(`${opts.summary.map(l => `  ${l}`).join('\n')}\n`);
  const prompt = `Type ${code} to approve this agent policy change (anything else cancels): `;
  const answer = opts.probe?.readAnswer ? await opts.probe.readAnswer(prompt) : await promptLineStderr(prompt, { timeoutMs: 300_000 });
  if (answer?.trim().toLowerCase() !== code) throw confirmRequiredError(opts.argv, { reason: 'declined' });
  let by = 'owner';
  try { by = userInfo().username || by; } catch { /* no passwd entry */ }
  return { method: 'terminal', at: new Date().toISOString(), digest: opts.digest, by, markers_absent: true };
}

export function ownerSessionProof(digest: string, principal: string): OwnerProof {
  return { method: 'owner_session', at: new Date().toISOString(), digest, by: principal };
}
