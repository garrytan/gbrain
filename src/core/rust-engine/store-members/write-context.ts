/**
 * The write context persistence/context.ts sets and reads on a transaction (engine-sql/transaction-settings.ts):
 * `readCurrentWriteTrust`, the writer's trust declaration in force. It reads through the transaction-settings members
 * (transactions.ts): the trust settings live in the store's write trust context on the transaction's handle.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { readTransactionSettings } from './transactions.ts';

/** The raw tier and origin settings, as `current_setting(name, true)` reads them (null, or '' once set before). */
export const readCurrentWriteTrust = async function readCurrentWriteTrust(this: RustEngine, brain: StoreBrain): Promise<{ tier: string | null; origin: string | null }> {
  const [tier, origin] = await readTransactionSettings.call(this, brain, ['gbrain.write_trust_tier', 'gbrain.write_origin']);
  return { tier: tier ?? null, origin: origin ?? null };
};
