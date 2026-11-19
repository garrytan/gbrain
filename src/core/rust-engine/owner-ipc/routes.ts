/**
 * How each BrainEngine member behaves on a client of the Rust engine owner (docs/designs/RUST_ENGINE.md, "Owner
 * protocol for the Rust engine"), and the typed errors a client call ends with.
 *
 * - `local`: the client answers it itself (identity and lifecycle).
 * - `forward`: the call crosses the owner socket as data and runs on the owner engine. Every member that takes only
 *   data is forwarded, executeRaw included (one statement, never a transaction).
 * - `refuse`: the member takes a callback that must run against the engine (a transaction body, a reserved
 *   connection, a schema lock). Transactions do not cross the socket, so the member rejects at once with
 *   `engine_capability_missing` and nothing runs. A whole operation that needs a transaction is forwarded instead
 *   (owner-ipc/whole-op.ts) and runs its transaction inside the owner.
 *
 * Before any of these, a client whose owner is a Rust engine (hello `kind: 'rust'`) checks the member's capability
 * class against the capabilities in the hello. A member the owner lacks (executeRaw without raw_sql, getPage without
 * pages, transaction without transactions) rejects at the client with the same `engine_capability_missing` error the
 * in-process RustEngine gives, byte for byte, and nothing crosses the socket (client.ts, missingOnRustOwner).
 *
 * The table is derived from RUST_ENGINE_MEMBERS, which the compiler checks against BrainEngine, so a new member is
 * forwarded by default; a forwarded call whose arguments carry a function the client cannot send refuses the same way.
 */
import type { Capability } from '../../engine-capabilities.ts';
import { opError, type OperationError } from '../../ops/contract.ts';
import { RUST_ENGINE_MEMBERS, type RustEngineMember } from '../members.ts';

export type OwnerIpcRoute = 'local' | 'forward' | 'refuse';

const LOCAL: ReadonlySet<string> = new Set(['kind', 'capabilities', 'connect', 'disconnect', 'reconnect', 'registerBeforeDisconnect']);
const REFUSE: ReadonlySet<string> = new Set(['transaction', 'transactionDirect', 'withReservedConnection', 'holdSchemaMigrationLock', 'keywordBoundedRead']);

export const OWNER_IPC_ROUTES: Readonly<Record<RustEngineMember, OwnerIpcRoute>> = Object.fromEntries(
  Object.keys(RUST_ENGINE_MEMBERS).map(member => [member, LOCAL.has(member) ? 'local' : REFUSE.has(member) ? 'refuse' : 'forward']),
) as Record<RustEngineMember, OwnerIpcRoute>;

/**
 * Option keys whose function value is a void notification a client may receive back from the owner: the search
 * metadata hooks (SearchOpts, and `cjkKeyword.onMeta` / `onStatementBudget` of engine-sql/cjk-search.ts). The owner
 * sends each notification before the call's result, so the caller sees it before its promise settles.
 */
export const OWNER_IPC_CALLBACK_KEYS: ReadonlySet<string> = new Set([
  'onVectorPoolMeta', 'onKeywordIncomplete', 'onMeta', 'onStatementBudget',
]);

/** The capability family a member belongs to, for the refusal's `reason`. */
function memberCapability(member: string): Capability {
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  return (cls === undefined || cls === 'implemented' ? 'raw_sql' : cls) as Capability;
}

/** A member (or one of its arguments) that cannot run from a client process; nothing ran. */
export function ownerIpcRefusal(member: string, why: string): OperationError {
  const capability = memberCapability(member);
  return opError('engine_capability_missing',
    `${member} cannot run from a second process on this brain: ${why}, so nothing ran.`,
    'Run it in the process that owns the brain (for example through gbrain serve tools), or stop the owner process and run it again.',
    { reason: capability, detail: `member=${member} capability=${capability} outcome=none written=nothing via=owner_ipc`,
      why: 'Another process owns this brain and this process reaches it over the owner socket. Transactions and callbacks do not cross that socket; whole operations that need a transaction (page writes and imports) are sent to the owner as one request instead.' });
}

/** The owner went away. `sent` says whether the owner may have started the call (its outcome is then unknown). */
export function ownerGone(member: string, ownerPid: number | null, sent: boolean): OperationError {
  const who = ownerPid ? `The process that owns this brain (pid ${ownerPid})` : 'The process that owns this brain';
  return opError('owner_unavailable',
    sent
      ? `${who} exited or closed its socket before it answered ${member}; a write may or may not have committed.`
      : `${who} exited or closed its socket, so ${member} was not sent.`,
    sent
      ? 'Read the page before you retry the write: the next call on this engine elects a new owner (possibly this process) and runs there.'
      : 'Run the command again: with no owner running, this process opens the brain itself.',
    { reason: sent ? 'outcome_unknown' : 'not_sent', retryable: true,
      detail: `member=${member} via=owner_ipc owner_pid=${ownerPid ?? 'unknown'} sent=${sent}`,
      why: 'This process reached the brain through the owner process. A call the owner may have run is never sent again, so a write is not applied twice; the next call runs the election again and takes over the brain.' });
}

/** The call's deadline passed before the owner answered; the owner cancelled it. */
export function ownerCallTimeout(member: string, ms: number, queued: boolean): OperationError {
  return opError('timeout',
    `${member} did not finish within ${ms} ms on the brain's owner${queued ? ' (it waited in the owner queue)' : ''}; the owner cancelled it.`,
    'Retry the same call; it waits again within its own deadline. If it keeps timing out, the owner process is busy: check its log.',
    { retryable: true, detail: `member=${member} via=owner_ipc deadline_ms=${ms} queued=${queued}` });
}

/** The caller's AbortSignal fired; the owner was told to cancel the call. */
export function ownerCallCancelled(member: string, sent: boolean): OperationError {
  return opError('cancelled',
    `${member} was cancelled by its caller${sent ? '; the owner was told to stop it' : ' before it was sent'}.`,
    'Nothing to do unless the cancel was unexpected; run the call again to repeat it.',
    { detail: `member=${member} via=owner_ipc sent=${sent}` });
}

/** The owner's reply exceeded the frame cap. */
export function ownerResponseTooLarge(member: string, maxBytes: number): OperationError {
  return opError('response_too_large',
    `The owner's answer to ${member} was larger than ${maxBytes} bytes, the most the owner socket carries.`,
    'Narrow the call (a smaller limit or one page at a time) and run it again.',
    { detail: `member=${member} via=owner_ipc max_bytes=${maxBytes}` });
}
