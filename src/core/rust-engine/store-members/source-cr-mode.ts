/**
 * A source's own contextual-retrieval mode (src/core/engine-sql/source-cr-mode.ts), served by gbrain-store
 * (rust/crates/gbrain-store/src/source_cr_mode.rs): `gbrain sources set-cr-mode` writes it, and `getSource` and the
 * synopsis tier read it back. What the store keeps: rust/docs/store/source-cr-mode.md.
 */
import { storeCall, type StoreMember } from './common.ts';

/** Sets the mode, or clears it for null; false when the source does not exist. */
export const setSourceContextualMode: StoreMember<[sourceId: string, mode: string | null], boolean> = (brain, sourceId, mode) =>
  storeCall({ member: 'setSourceContextualMode', sourceId }, () => brain.setSourceContextualMode(sourceId, mode ?? null));
