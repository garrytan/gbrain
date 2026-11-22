/**
 * The managed-storage gate shared by `gbrain engine shadow start` and `seed`.
 *
 * The Rust engine never holds managed storage (src/core/rust-engine/store-members/persistence.ts), so a brain with managed
 * storage can never swap to Rust and a shadow on it measures nothing it could use. Both commands refuse it before
 * they write anything. A brain whose mode cannot be read is refused too: an impossible read is not a mode.
 */
import type { SqlEngine } from '../core/persistence/model.ts';
import { readManagedMode } from '../core/persistence/managed-mode.ts';
import { opError, type OperationError } from '../core/ops/contract.ts';

// After the master merge: if core's engine_swap_refused `managed_storage` row is on master, switch to it and delete the
// engine_shadow_refused registry row; one row only. This constant is the only place in src that names the code besides its registry row.
const SHADOW_REFUSAL_CODE = 'engine_shadow_refused';
const VERIFY = { argv: ['gbrain', 'sources', 'writer', 'status', '--probe', '--json'] };
const MANAGED_WHY = 'This brain uses managed storage. The Rust engine never holds managed storage, so this brain can never swap to Rust and a shadow on it measures nothing it could use. '
  + 'Brains made by a default `gbrain init` use managed storage and cannot be shadowed or swapped yet.';
const WAYS_OUT = 'For a new brain, `gbrain init --db-only` creates one without managed storage. For this brain, `gbrain sources writer deactivate --dry-run` previews converting it back to classic mode; the real deactivate needs the user\'s consent.';
const NEXT = 'Ask the user how they want to proceed; nothing was written.';
const MANAGED_NEXT = `Ask the user. ${WAYS_OUT} Nothing was written.`;
const BUSY_NEXT = 'Ask the user to stop `gbrain serve` and any other process holding this brain, run the same command again, then restart serve (shadow mode attaches only to processes that open the brain after start); nothing was written.';

/** The brain's mode was read as managed (a literal `true`): the only case that says "this brain uses managed storage". Inlined: core will export a `managed_storage` builder from src/core/engine-swap/refusals.ts; it is not on master yet. */
function managedStorageRefused(): OperationError {
  return build('Shadow mode is refused: this brain uses managed storage.', MANAGED_NEXT, MANAGED_WHY,
    `This brain uses managed storage, and the Rust engine never holds it, so a shadow on it would measure nothing it could use. Brains made by a default \`gbrain init\` use managed storage and cannot be shadowed or swapped yet. ${WAYS_OUT} Nothing was written.`);
}

/** The mode was NOT read as true: a failed read refuses (an impossible read is not a mode), but it does not claim the brain is managed. */
function modeUnconfirmed(failure: string, busy: boolean): OperationError {
  const why = `gbrain could not read whether this brain uses managed storage (${failure}), so it refuses rather than guess. The brain may well be unmanaged. A shadow on a managed brain measures nothing, because the Rust engine never holds managed storage.`;
  return build('Shadow mode is refused: gbrain could not confirm that this brain does not use managed storage.', busy ? BUSY_NEXT : NEXT, why,
    busy ? 'Another gbrain process holds this brain, so its storage mode could not be read. Can you stop `gbrain serve` and anything else using it, run the command again, then restart serve? Nothing was written.'
      : 'gbrain could not read this brain\'s storage mode, so shadow mode stays off. Can you check the brain with `gbrain doctor --json` and run the command again? Nothing was written.',
    failure);
}

function build(message: string, next: string, why: string, userMessage: string, detail?: string): OperationError {
  return opError(SHADOW_REFUSAL_CODE, message, next, {
    reason: 'managed_storage', why, ...(detail ? { detail } : {}),
    fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, why, verify: VERIFY, user_message: userMessage },
  });
}

/** The managed-storage refusal, or null when the brain is unmanaged. Any failure to read the mode is also a refusal, carrying the read error. */
export async function managedStorageRefusal(engine: SqlEngine): Promise<OperationError | null> {
  try {
    return await readManagedMode(engine) ? managedStorageRefused() : null;
  } catch (e) {
    return modeUnconfirmed(describeReadError(e), isBusy(e));
  }
}

const isBusy = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'pglite_busy';

/** What went wrong reading the mode, for the refusal's `detail`: the error's code, message and own detail. */
export function describeReadError(e: unknown): string {
  const err = e as { code?: unknown; message?: unknown; detail?: unknown };
  const message = typeof err?.message === 'string' ? err.message : String(e);
  const code = typeof err?.code === 'string' ? `${err.code}: ` : '';
  const detail = typeof err?.detail === 'string' && err.detail ? ` (${err.detail})` : '';
  return `could not read the persistence mode: ${code}${message}${detail}`;
}

/** The refusal for a brain that could not be opened to read its mode; a `pglite_busy` open names the process holding it. */
export function unopenableBrainRefusal(e: unknown): OperationError {
  return modeUnconfirmed(`could not open the brain: ${describeReadError(e).replace(/^could not read the persistence mode: /, '')}`, isBusy(e));
}
