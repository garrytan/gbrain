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

const VERIFY = { argv: ['gbrain', 'sources', 'writer', 'status', '--probe', '--json'] };
const WHY = 'This brain uses managed storage. The Rust engine never holds managed storage, so this brain can never swap to Rust and a shadow on it measures nothing it could use.';

/** Inlined: core will export a `managed_storage` builder from src/core/engine-swap/refusals.ts; it is not on master yet. */
function managedStorageRefused(detail?: string): OperationError {
  return opError('engine_shadow_refused', 'Shadow mode is refused: this brain uses managed storage.',
    'Ask the user how they want to proceed; nothing was written.', {
      reason: 'managed_storage', why: WHY, ...(detail ? { detail } : {}),
      fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, why: WHY, verify: VERIFY,
        user_message: 'This brain uses managed storage, and the Rust engine never holds it, so a shadow on it would measure nothing it could use. Do you want to leave shadow mode off? Nothing was written.' },
    });
}

/** The managed-storage refusal, or null when the brain is unmanaged. Any failure to read the mode is also a refusal, carrying the read error. */
export async function managedStorageRefusal(engine: SqlEngine): Promise<OperationError | null> {
  try {
    return await readManagedMode(engine) ? managedStorageRefused() : null;
  } catch (e) {
    return managedStorageRefused(describeReadError(e));
  }
}

/** What went wrong reading the mode, for the refusal's `detail`: the error's code, message and own detail. */
export function describeReadError(e: unknown): string {
  const err = e as { code?: unknown; message?: unknown; detail?: unknown };
  const message = typeof err?.message === 'string' ? err.message : String(e);
  const code = typeof err?.code === 'string' ? `${err.code}: ` : '';
  const detail = typeof err?.detail === 'string' && err.detail ? ` (${err.detail})` : '';
  return `could not read the persistence mode: ${code}${message}${detail}`;
}

/** The refusal for a brain that could not be opened to read its mode. */
export function unopenableBrainRefusal(e: unknown): OperationError {
  return managedStorageRefused(`could not open the brain: ${describeReadError(e).replace(/^could not read the persistence mode: /, '')}`);
}
