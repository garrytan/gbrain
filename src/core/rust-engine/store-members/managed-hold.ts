import { capabilityMissing } from '../errors.ts';
import { RECEIPT_STOP_OWNERS } from '../receipt-stops.ts';
export function managedServed(engine: unknown): boolean { const caps = (engine as { capabilities?: ReadonlySet<string> }).capabilities; return caps?.has('managed_persistence') === true; }
export function heldRefusal(): Error { return capabilityMissing('raw_sql', 'executeRaw', 'none', RECEIPT_STOP_OWNERS.executeRaw); }
export function heldStore<S extends object>(engine: unknown, store: S): S { if (managedServed(engine)) return store; const held = {} as Record<string, unknown>; for (const key of Object.keys(store)) held[key] = () => Promise.reject(heldRefusal()); return held as S; }
