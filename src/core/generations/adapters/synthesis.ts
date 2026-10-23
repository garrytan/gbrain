/**
 * GBRA-161 PR 4 (#7065, plan D3): the synthesis adapter. One owner key per transcript (`transcript:<root>/<path>`, the
 * PR 1b transcript key: its path relative to the corpus root it was found under, with the rename map), kind `synthesis`.
 * The items are the reflection and original pages the synthesize phase's children write for it (`dream_generated`,
 * `raw_source` naming the transcript). New outputs publish as they always did, written by the children; the activation
 * (cycle/synthesize-generations.ts) records them and retires, versioned and stamped `synthesis-resynthesis`, only the
 * earlier outputs a complete re-synthesis matched (generations/synthesis-coverage.ts). Every other earlier output is
 * carried into the new generation and stays live. An output written before the ledger is never adopted as an earlier
 * output (no legacy evidence), so the existing duplicate backlog is untouched.
 */
import type { BrainEngine } from '../../engine.ts';
import { opError } from '../../ops/contract.ts';
import { retireDerivedPagesInTransaction, type DerivedRetiredBy } from '../../persistence/derived-retirement-hold.ts';
import type { GenerationAdapter, GenerationKey, InputState } from '../contract.ts';
import { importPageItem, pageItemRow, preimageIdentity, preimageMarkdown, readPageRows } from './page.ts';
import { TRANSCRIPT_KEY_PREFIX } from './atoms.ts';

export const SYNTHESIS_KIND = 'synthesis';
export const SYNTHESIS_RETIRED_BY: DerivedRetiredBy = 'synthesis-resynthesis';
export const SYNTHESIS_CLEANUP_RETIRED_BY: DerivedRetiredBy = 'synthesis-cleanup';

/** What one activation hands the adapter: the transcript's current file and the input the children read. */
export interface SynthesisGenerationContext { locator: string; transcriptInput: InputState }

export const synthesisOwnerKey = (transcriptKey: string) => `${TRANSCRIPT_KEY_PREFIX}${transcriptKey}`;

function assertKey(key: GenerationKey): void {
  if (!key.ownerKey.startsWith(TRANSCRIPT_KEY_PREFIX)) throw new Error(`not a synthesis owner key: ${key.ownerKey}`);
}

/** Item keys the live generation of `key` records (still owned whatever file they name). */
async function recordedKeys(db: BrainEngine, key: GenerationKey): Promise<Set<string>> {
  const rows = await db.executeRaw<{ item_key: string }>(
    `SELECT i.item_key FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE g.source_id=$1 AND g.kind=$2 AND g.owner_key=$3 AND g.state='live' AND i.action <> 'retired'`, [key.sourceId, key.kind, key.ownerKey]);
  return new Set(rows.map(row => row.item_key));
}

export const synthesisAdapter: GenerationAdapter<SynthesisGenerationContext> = {
  kind: SYNTHESIS_KIND,
  retiredBy: SYNTHESIS_RETIRED_BY,
  modelProduced: true,
  publishesInPlace: true,
  lockKeys: (key, itemKeys) => itemKeys.map(slug => ({ sourceId: key.sourceId, slug })),
  async readInput(_engine, key, context) {
    assertKey(key);
    return context?.transcriptInput ?? null;
  },
  async readItems(engine, key, itemKeys, context) {
    assertKey(key);
    const recorded = await recordedKeys(engine, key);
    const locator = context?.locator ?? null;
    const rows = await readPageRows(engine, key.sourceId, `p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL
      AND p.frontmatter->>'raw_source' = $3 AND p.frontmatter->>'dream_generated' = 'true')`, [[...new Set([...itemKeys, ...recorded])], locator]);
    return new Map(rows.map(row => [row.slug, pageItemRow(row, row.frontmatter?.dream_generated === true
      && (recorded.has(row.slug) || (locator !== null && row.frontmatter?.raw_source === locator)))]));
  },
  // An output written before the ledger is never another generation's earlier output: the backlog stays as it is.
  legacyEvidence: async () => new Set<string>(),
  async publishItems(_tx, key, items) {
    throw opError('generation_live_conflict', `The synthesis generation of ${key.ownerKey} was not activated: ${items.slice(0, 5).map(item => item.key).join(', ')} changed after the run read it; nothing was retired.`,
      'Nothing to do: every output stays live, and the next re-synthesis of the transcript plans from the pages as they are.', { docs: 'docs/architecture/generations.md#synthesis' });
  },
  retireItems: (tx, key, itemKeys, retiredBy) => retireDerivedPagesInTransaction(tx, key.sourceId, itemKeys, retiredBy),
  restoreItem: (tx, key, itemKey, preimage) => importPageItem(tx, key.sourceId, itemKey, preimageMarkdown(preimage)),
  preimageIdentity,
};
