/**
 * Owner confirmation for tier-raising actions (#5575: CEO-9, CEO-14, DX-3,
 * ENG-15). One rule: raising any fact, take or page tier (confirm, accepting a
 * trust proposal, quarantine release, reverting an agent edit) needs either an
 * interactive TTY on the local CLI where the user types a target-specific
 * token (the ref or a hash8, never y/N), or a connection holding the
 * `memory_confirm` scope. `--yes` never confirms, and every fix emitted for a
 * tier-raising action is `tell_user_to_run` with no `--yes`.
 *
 * The TTY check is the shared `isInteractive` seam (core/interaction.ts);
 * tests drive both modes through `__setConfirmationIoForTests` without a pty.
 * The ops that use this (confirm_memory, trust review actions) live in
 * src/core/ops/trust.ts.
 */
import type { Action } from '../agent-output.ts';
import { isInteractive, readLine, type InteractiveProbe } from '../interaction.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { databaseRefusal } from '../persistence/publication-failure.ts';
import { hasScope } from '../scope.ts';

export const MEMORY_CONFIRM_SCOPE = 'memory_confirm';

export interface ConfirmationIo {
  probe?: InteractiveProbe;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
}
let testIo: ConfirmationIo | null = null;
/** CEO-14 test override: a probe that reports a TTY (or not) and the streams the prompt reads and writes. */
export function __setConfirmationIoForTests(io: ConfirmationIo | null): void { testIo = io; }

export interface ConfirmationTarget {
  /** The typed ref the user sees, e.g. `f123`, `tp7`, `p:default/notes/x`. */
  ref: string;
  /** What the user must type; defaults to `ref`. Use a hash8 when the ref is long. */
  token?: string;
  /** One line naming the change, e.g. "Raise fact f123 to confirmed by you". */
  summary: string;
  /** The exact local command that performs this action on a TTY (no `--yes`). */
  command: string[];
}

export type TypedConfirmation = 'confirmed' | 'declined' | 'non_interactive';

/** ENG-15: the user types the target's token; anything else (or EOF, or a timeout) declines. */
export async function promptTypedConfirmation(target: ConfirmationTarget, io: ConfirmationIo = testIo ?? {}): Promise<TypedConfirmation> {
  if (!isInteractive(io.probe)) return 'non_interactive';
  const token = target.token ?? target.ref;
  const read = await readLine({
    prompt: `${target.summary}\nType ${token} to confirm (anything else cancels): `,
    probe: io.probe, input: io.input, output: io.output, timeoutMs: io.timeoutMs,
  });
  return read.kind === 'line' && read.text === token ? 'confirmed' : 'declined';
}

/** DX-3: a fix for a tier-raising action. Always the user's to run; refuses an argv that would auto-confirm. */
export function tierRaiseFix(argv: string[], why: string, userMessage?: string): Action {
  if (argv.some(arg => arg === '--yes' || arg === '-y' || arg.startsWith('--yes='))) {
    throw new Error(`tier-raising fix must not carry --yes: ${argv.join(' ')}`);
  }
  return { argv, consent: [], actor: 'user', why, requires_exclusive: false, ...(userMessage ? { user_message: userMessage } : {}) };
}

export type OwnerConfirmation = { via: 'memory_confirm_scope' } | { via: 'tty' };

/**
 * Establishes the owner's confirmation for one tier-raising action, or throws.
 * A remote connection needs `memory_confirm` (`insufficient_scope` otherwise);
 * the local CLI needs an interactive TTY and the typed token
 * (`confirmation_required` otherwise). `--yes` is deliberately not an input.
 */
export async function requireOwnerConfirmation(ctx: OperationContext, target: ConfirmationTarget): Promise<OwnerConfirmation> {
  const fix = tierRaiseFix(target.command,
    'Raising trust needs the owner: run this on the brain host in an interactive terminal and type the confirmation token when asked.',
    `Run on the brain host, in a terminal: ${target.command.join(' ')}`);
  if (ctx.remote !== false) {
    if (hasScope(ctx.auth?.scopes ?? [], MEMORY_CONFIRM_SCOPE)) return { via: 'memory_confirm_scope' };
    throw opError('insufficient_scope', `This connection cannot confirm memory: ${target.summary.toLowerCase()} needs the owner.`,
      'Do not retry. Tell the user to run the command in fix on the brain host; only they can confirm memory.',
      { why: 'Confirming memory raises its trust tier, which only the owner may do (an interactive terminal on the brain host, or a connection granted memory_confirm by the local CLI).', fix });
  }
  const answer = await promptTypedConfirmation(target);
  if (answer === 'confirmed') return { via: 'tty' };
  throw opError('confirmation_required', answer === 'declined'
    ? `Not confirmed: the typed token did not match ${target.token ?? target.ref}. Nothing was changed.`
    : 'This needs the owner to confirm in an interactive terminal; nothing was changed.',
  'Do not retry with --yes (it never confirms). Tell the user to run the command in fix in an interactive terminal on the brain host.',
  { why: 'Raising trust is the owner\'s decision, so it needs a person at a terminal typing the confirmation token; piped input, agents and --yes cannot confirm.', fix });
}

/**
 * The tier trigger's database refusal (trust/schema.ts) as the registered
 * `trust_raise_refused` error, for direct writers outside the coordinator
 * (the coordinator classifies it through publication-failure.ts). Null when
 * `error` is something else.
 */
export function trustRaiseRefusal(error: unknown): OperationError | null {
  const refusal = databaseRefusal(error);
  if (refusal?.code !== 'trust_raise_refused') return null;
  return opError('trust_raise_refused', refusal.message,
    'Do not retry. Ask the user to confirm the row on the brain host, or leave its tier as it is.');
}
