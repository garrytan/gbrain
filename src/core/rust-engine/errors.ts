/**
 * The capability refusal of the optional Rust engine (docs/designs/RUST_ENGINE.md, "Error contract for the Rust
 * engine", decision D2): `engine_capability_missing` means the engine opened but does not implement what the caller
 * asked for. The check runs before any work, so nothing was written. Addon states (missing, mismatched) are not
 * refused here: the addon loader owns them and refuses before an engine exists.
 *
 * `detail` is caller-safe key=value text: the member, the capability, the outcome and what was written.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import type { Capability } from '../engine-capabilities.ts';

/** What a refusal left behind: `none` when the check ran before any work. */
export type CapabilityOutcome = 'none' | 'partial' | 'unknown';

/**
 * The engine does not implement `capability`, which `member` (a BrainEngine member, operation or command name) needs.
 * With the default `outcome: 'none'` nothing ran; the raw-SQL backstop passes `partial` or `unknown` when it is reached
 * after earlier steps of a caller already ran.
 */
export function capabilityMissing(capability: Capability, member: string, outcome: CapabilityOutcome = 'none', stop?: KnownStop): OperationError {
  const nothingRan = outcome === 'none';
  return opError('engine_capability_missing',
    `This brain's engine does not support ${member}${stop ? ` (owner ${stop.owner}, due ${stop.due})` : ''} yet (it needs the ${capability} capability)${nothingRan ? ', so nothing ran.' : '.'}`,
    'Run it on a pglite or postgres brain, or wait for a gbrain release whose Rust engine supports it.',
    { reason: capability, detail: `member=${member} capability=${capability} outcome=${outcome} written=${nothingRan ? 'nothing' : outcome}${stop ? ` owner="${stop.owner}" due="${stop.due}"` : ''}` });
}

/** A stop a lane owes: who lifts it and when (rust-engine/receipt-stops.ts), so the refusal says both. */
export interface KnownStop { owner: string; due: string }

/**
 * True when `e` is a capability refusal (`engine_capability_missing`). Fail-soft reads that turn other errors into an
 * empty answer rethrow this one, so a brain whose engine cannot serve the read refuses instead of answering. PGLite and
 * Postgres never raise it.
 */
export function isCapabilityMissing(e: unknown): e is OperationError {
  return e instanceof Error && (e as { code?: unknown }).code === 'engine_capability_missing';
}

/** Rethrow a capability refusal; any other error returns so the caller's fail-soft path runs. */
export function rethrowCapabilityMissing(e: unknown): void {
  if (isCapabilityMissing(e)) throw e;
}

/**
 * The named refusal of a persistence step that must run as one transaction, on an engine that serves none (the Rust
 * engine until its transaction API lands: docs/designs/RUST_ENGINE.md, "transaction(fn) keeps its shape"). The step
 * calls it before it opens its transaction, so the refusal names the step and why it needs one, not only the
 * `transaction` member, and nothing of the step ran. PGLite, Postgres and transaction handles (no capability set) pass.
 */
export function requireTransactions(engine: object, step: string, why: string): void {
  const caps = (engine as { capabilities?: ReadonlySet<Capability> }).capabilities;
  if (caps && !caps.has('transactions')) throw capabilityMissing('transactions', `${step} (${why})`);
}

/**
 * The named refusal of a managed-checkout persistence step (worktree admission, the refresh barrier, an import hold,
 * grouped admission, the background owner check) on an engine without `managed_persistence`. The
 * step calls it before it reads or locks anything, so nothing of the write ran. PGLite, Postgres and transaction
 * handles (no capability set) pass.
 */
export function requireManagedPersistence(engine: object, step: string, why: string): void {
  if (!managesWorktrees(engine)) throw capabilityMissing('managed_persistence', `${step} (${why})`);
}

/**
 * The named refusal of a step that still runs raw SQL (a repair's page or fact write, a privacy scan, a twin fold, the
 * refresh writer), on an engine without `raw_sql` (the Rust engine). The step calls it before it reads or writes, so
 * `step` names what did not run. PGLite, Postgres and transaction handles (no capability set) pass, so no SQL engine
 * path raises it. `capability` names a narrower missing family when there is one; `outcome` says what already ran.
 */
export function requireRawSql(engine: object, step: string, opts: { capability?: Capability; outcome?: CapabilityOutcome } = {}): void {
  if (!reports(engine, 'raw_sql')) throw capabilityMissing(opts.capability ?? 'raw_sql', step, opts.outcome);
}

/**
 * The named refusal of a step that works on SQL relations, called when `listCatalogRelations` answered
 * `store: 'keyspaces'` (the Rust engine). PGLite and Postgres answer `store: 'sql'` and never reach it.
 */
export function refuseKeyspaceStore(step: string, why: string): never {
  throw capabilityMissing('raw_sql', `${step} (${why})`);
}

/** One stop a purge entry point meets on the Rust engine (persistence/purge-path-members.ts entryStops). */
export interface PurgeEntryStop { capability: Capability; name: string; why: string; owner: string; due?: string }

/**
 * The pre-write refusal of a purge entry point that meets `stop`: a stop with a due date names its owner and date in the
 * message and the detail, one without (a lane's own) names its owner. No stop passes. The stop lists are empty on PGLite
 * and Postgres (entryStops answers only for the Rust engine), so only the Rust engine refuses here.
 */
export function refusePurgeEntryStop(what: string, stop: PurgeEntryStop | undefined): void {
  if (!stop) return;
  if (stop.due) throw capabilityMissing(stop.capability, `${what}, which needs ${stop.name}: ${stop.why}`, 'none', { owner: stop.owner, due: stop.due });
  throw capabilityMissing(stop.capability, `${what}, which needs ${stop.name} (owner ${stop.owner}: ${stop.why})`);
}

/**
 * Whether `engine` can hold managed-checkout state at all. Without `managed_persistence` no worktree, refresh or
 * worktree-owned write can exist (their admission refuses above), so an owner scan over them has nothing to find and
 * returns empty instead of reading. PGLite, Postgres and transaction handles (no capability set) answer true.
 */
export function managesWorktrees(engine: object): boolean {
  return reports(engine, 'managed_persistence');
}

/**
 * Whether `engine` serves raw SQL. Callers with one raw statement ask it first, so an engine without `raw_sql` (the
 * Rust engine) answers from typed members or refuses plainly. PGLite, Postgres and transaction handles answer true.
 */
export function servesRawSql(engine: object): boolean {
  return reports(engine, 'raw_sql');
}

/**
 * Whether `engine` runs a `transaction` body. `initGuestSource` asks it: without `transactions` (the Rust engine) it runs
 * the same steps one after another, each atomic on its own. PGLite, Postgres and transaction handles answer true.
 */
export function servesTransactions(engine: object): boolean {
  return reports(engine, 'transactions');
}

/** True unless `engine` carries a capability set without `capability`; an object with no set (a handle, a fake) passes. */
function reports(engine: object, capability: Capability): boolean {
  const caps = (engine as { capabilities?: ReadonlySet<Capability> }).capabilities;
  return typeof caps?.has !== 'function' || caps.has(capability);
}
