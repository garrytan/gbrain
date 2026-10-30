/**
 * GBRA-161: the contract between the generation primitive (publish.ts) and the adapters that own one ledger kind each.
 * The primitive decides when a result may replace the live generation; the adapter knows how its items are read, written,
 * retired and restored. Items are identified by key (a page slug for page kinds) and compared by identity hash, a digest
 * of what the item says that leaves out completion, extraction and retirement stamps (adapters/page.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { DerivedRetiredBy } from '../persistence/derived-retirement-hold.ts';

/** One derived set: the items of one kind a single input owns in one source. */
export interface GenerationKey { kind: string; sourceId: string; ownerKey: string }

export const HELD_REASONS = ['shrunk', 'oversize', 'valve', 'no_proof', 'fence_absent', 'attempts_exhausted', 'segmented_unsupported', 'tie'] as const;
export type HeldReason = typeof HELD_REASONS[number];

/** A held result the operator may publish once with `gbrain repair generations --mode release-held`. */
export const RELEASABLE_HELD_REASONS: ReadonlySet<HeldReason> = new Set(['shrunk', 'valve', 'attempts_exhausted', 'oversize']);

/** One item of a proposed generation: its key, the content the adapter writes, and its identity hash. */
/** `order`: the item's rank in a strict-order result (adapters with `strictOrder`); two items sharing one is a tie. */
export interface ProposedItem { key: string; content: string; identityHash: string; order?: number }

/** A bounded copy of an item's stored state, kept on the ledger so a restore can bring it back (null: too large or segmented). */
export interface Preimage { json: Record<string, unknown> | null; bytes: number }

/** An item as stored now. `owned`: the row names this key's input as its origin (and is not imported or managed). */
export interface ItemRow { key: string; identityHash: string; live: boolean; owned: boolean; segmented: boolean; preimage(): Preimage }

/** The input a generation was derived from: a pin that changes whenever the input does, and its size in bytes. */
export interface InputState { pin: string; size: number }

export interface GenerationAdapter<C = unknown> {
  kind: string;
  /** The `retired_by` stamp the adapter's retirements carry. */
  retiredBy: DerivedRetiredBy;
  /** Model-produced kinds take the input-relative shrink floor; canonical projections do not. */
  modelProduced: boolean;
  /** The result is a ranked cut: every item carries a distinct `order`, and a tie (or a missing rank) holds the result (`tie`). */
  strictOrder?: boolean;
  /** A canonical fence kind (generations/fence.ts): it publishes through `publishFenceGeneration` and restores by transplanting the fence. */
  fence?: 'facts' | 'takes';
  /**
   * Its items are database-only pages (no canonical file). A managed source then writes the new and changed items as
   * ordinary requests before the activation, and the activation itself retires what the generation dropped (no retire
   * members, nothing left pending); a restore runs as one coordinated request (managed.ts).
   */
  databaseOnly?: boolean;
  /**
   * Its producer writes the items itself before the activation (synthesis: the phase's children). The activation records
   * them where they are and never writes one; a managed plan keeps them without members and only retires (managed-retire.ts).
   */
  publishesInPlace?: boolean;
  /** Page keys locked before the ledger row, in slug order with the input guard (D7). */
  lockKeys(key: GenerationKey, itemKeys: readonly string[]): Array<{ sourceId: string; slug: string }>;
  /** The input as stored now, or null when it is gone. `context` carries an input the database does not hold (a transcript). */
  readInput(engine: BrainEngine, key: GenerationKey, context: C | undefined): Promise<InputState | null>;
  /** Rows of the named keys (deleted rows included) and of every live row the key owns by its origin metadata. */
  readItems(engine: BrainEngine, key: GenerationKey, itemKeys: readonly string[], context?: C): Promise<Map<string, ItemRow>>;
  /** Of these unrecorded owned rows, the keys whose retained producer evidence shows them unedited at their identity. */
  legacyEvidence(engine: BrainEngine, key: GenerationKey, rows: readonly ItemRow[]): Promise<Set<string>>;
  /** Writes new and changed items inside the activation transaction. */
  publishItems(tx: BrainEngine, key: GenerationKey, items: readonly ProposedItem[], context: C | undefined): Promise<void>;
  /** Marks the generation's items complete (an atom's `source_hash` flip); skipped for a partial generation. */
  completeItems?(tx: BrainEngine, key: GenerationKey, itemKeys: readonly string[], context: C | undefined): Promise<void>;
  /** Versions, soft-deletes and stamps items the new generation no longer has. */
  retireItems(tx: BrainEngine, key: GenerationKey, itemKeys: readonly string[], retiredBy: DerivedRetiredBy): Promise<void>;
  /** Writes a preimage back (reviving a retired item, or returning an overwritten one to its earlier state). */
  restoreItem(tx: BrainEngine, key: GenerationKey, itemKey: string, preimage: Record<string, unknown>): Promise<void>;
  /** The identity hash of a preimage, so a restore can tell whether the item changed since. */
  preimageIdentity(preimage: Record<string, unknown>): string;
  /** Rechecks an `originIneligible` proof against the input as stored now (proofs.ts); an adapter without it never accepts one. */
  proofHolds?(engine: BrainEngine, key: GenerationKey, proof: import('./proofs.ts').EmptySourceProof): Promise<boolean>;
}
