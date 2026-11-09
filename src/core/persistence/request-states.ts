/**
 * Wave C 1H (large-pages spec §3.1 step 8, §17 ceo-r3-native-2): the one place that says what each
 * `persistence_requests.state` means.
 *
 * - **pending** (`queued`, `deferred`, `running`, `recovering`): admitted and not yet published (`deferred` waits behind a
 *   worktree refresh, docs/designs/REFRESH_WRITE_BARRIER.md). It sequences its source (a later
 *   write of the worktree waits behind it), counts as outstanding, and stuck detection watches it.
 * - **committed in Git** (`indexing`): the door commit landed, so Git holds the bytes and `persistence.git_commit`
 *   names the commit, and the database has not derived the page yet. To the source it is published: it no longer
 *   sequences later writes, the write watermark passes it, its recovery record and reservation are cleared, and stuck
 *   detection ignores it. To a caller it is still pending: its receipt and the waiter treat it as non-terminal
 *   (`retry_after_ms` set, CLI exit 10) until the index flip makes it `committed`.
 * - **terminal** (`committed`, `conflict`, `failed`, `cancelled`): the outcome is final.
 *
 * New code reads these classes from here instead of spelling a state list: `scripts/check-request-state-lists.mjs`
 * (in `verify`) fails on a new literal list outside its baseline.
 */
export const PENDING_REQUEST_STATES = ['queued', 'deferred', 'running', 'recovering'] as const;
export const INDEXING_REQUEST_STATE = 'indexing' as const;
export const TERMINAL_REQUEST_STATES = ['committed', 'conflict', 'failed', 'cancelled'] as const;
export const REQUEST_STATES = [...PENDING_REQUEST_STATES, INDEXING_REQUEST_STATE, ...TERMINAL_REQUEST_STATES] as const;

export type RequestStateName = typeof REQUEST_STATES[number];
export type RequestStateClass = 'pending' | 'committed_in_git' | 'terminal';

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_REQUEST_STATES);
const PENDING: ReadonlySet<string> = new Set(PENDING_REQUEST_STATES);

export function requestStateClass(state: string): RequestStateClass {
  if (TERMINAL.has(state)) return 'terminal';
  if (state === INDEXING_REQUEST_STATE) return 'committed_in_git';
  if (PENDING.has(state)) return 'pending';
  throw new Error(`Unknown write request state ${JSON.stringify(state)}`);
}

/** Receipts and the waiter: final only for a terminal state; `indexing` is still in flight to its caller. */
export function isTerminalReceiptState(state: string): boolean { return TERMINAL.has(state); }

/** Source sequencing, the write watermark and stuck detection: published once Git holds it (`indexing`) or final. */
export function isPublishedRequestState(state: string): boolean { return state === INDEXING_REQUEST_STATE || TERMINAL.has(state); }

/** A parenthesized SQL list of states, for `state IN ${...}`. */
export const sqlStateList = (states: readonly string[]): string => `(${states.map(state => `'${state}'`).join(',')})`;
/** States that hold the source's sequence: `state IN ${PENDING_STATES_SQL}`. */
export const PENDING_STATES_SQL = sqlStateList(PENDING_REQUEST_STATES);
/** States whose write is published (Git holds it, or it ended): `state IN ${PUBLISHED_STATES_SQL}`. */
export const PUBLISHED_STATES_SQL = sqlStateList([INDEXING_REQUEST_STATE, ...TERMINAL_REQUEST_STATES]);
/** Final states: `state IN ${TERMINAL_STATES_SQL}`. */
export const TERMINAL_STATES_SQL = sqlStateList(TERMINAL_REQUEST_STATES);
