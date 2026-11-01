/**
 * Fixture writes at the owner's tier (operator_curated, "your notes"): what a sync of the owner's own files stamps.
 * Rows written outside any trust declaration read as `unknown`, which a remote reader gets quoted (GST-687).
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { withWriteTrust } from '../../src/core/persistence/context.ts';

export function asOwner<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(tx => withWriteTrust(tx, { tier: 'operator_curated', origin: { channel: 'sync' } }, () => fn(tx)));
}
