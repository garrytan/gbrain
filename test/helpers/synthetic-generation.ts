/**
 * GBRA-161: a synthetic generation kind for the primitive's tests. Its items are pages carrying
 * `synthetic_owner: <owner key>`; its input is whatever the test last set for the key (`setSyntheticInput`), so a test
 * can move the input under a producer. Retirements carry the extract-atoms stamp, so the derived purge hold applies.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GenerationAdapter, GenerationKey, InputState, ProposedItem } from '../../src/core/generations/contract.ts';
import { registerGenerationAdapter } from '../../src/core/generations/adapters/index.ts';
import { importPageItem, markdownItem, pageItemRow, pageVersionEvidence, preimageIdentity, preimageMarkdown, readPageRows } from '../../src/core/generations/adapters/page.ts';
import { retireDerivedPagesInTransaction } from '../../src/core/persistence/derived-retirement-hold.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

export const SYNTHETIC_KIND = 'synthetic';
const inputs = new Map<string, InputState>();

export function setSyntheticInput(key: GenerationKey, input: InputState | null): void {
  if (input) inputs.set(`${key.sourceId}:${key.ownerKey}`, input); else inputs.delete(`${key.sourceId}:${key.ownerKey}`);
}

export const syntheticAdapter: GenerationAdapter<undefined> = {
  kind: SYNTHETIC_KIND,
  retiredBy: 'extract-atoms',
  modelProduced: true,
  lockKeys: (key, itemKeys) => itemKeys.map(slug => ({ sourceId: key.sourceId, slug })),
  readInput: async (_engine, key) => inputs.get(`${key.sourceId}:${key.ownerKey}`) ?? null,
  async readItems(engine, key, itemKeys) {
    const rows = await readPageRows(engine, key.sourceId, `p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND p.frontmatter->>'synthetic_owner' = $3)`, [[...itemKeys], key.ownerKey]);
    return new Map(rows.map(row => [row.slug, pageItemRow(row, row.frontmatter?.synthetic_owner === key.ownerKey)]));
  },
  legacyEvidence: (engine, key, rows) => pageVersionEvidence(engine, key.sourceId, rows, "v.frontmatter->>'synthetic_producer' = 'synthetic'"),
  async publishItems(tx, key, items) { for (const item of items) await importPageItem(tx, key.sourceId, item.key, item.content); },
  retireItems: (tx, key, itemKeys, retiredBy) => retireDerivedPagesInTransaction(tx, key.sourceId, itemKeys, retiredBy),
  restoreItem: (tx, key, itemKey, preimage) => importPageItem(tx, key.sourceId, itemKey, preimageMarkdown(preimage)),
  preimageIdentity,
};
registerGenerationAdapter(syntheticAdapter as GenerationAdapter<unknown>);

/** The same kind as a ranked cut (`strictOrder`): a tie in the result holds it (#6023 shape). */
export const strictSyntheticAdapter: GenerationAdapter<undefined> = { ...syntheticAdapter, strictOrder: true };

/** One proposed synthetic item: a note page owned by `ownerKey` with this body. */
export function syntheticItem(ownerKey: string, slug: string, body: string, order?: number): ProposedItem {
  if (order !== undefined) return { ...syntheticItem(ownerKey, slug, body), order };
  return markdownItem(slug, serializeMarkdown({ synthetic_owner: ownerKey, synthetic_producer: 'synthetic' }, body, '', { type: 'note', title: slug.split('/').pop()!, tags: [] }));
}

export const syntheticKey = (sourceId: string, ownerKey: string): GenerationKey => ({ kind: SYNTHETIC_KIND, sourceId, ownerKey });

export async function liveSlugs(engine: BrainEngine, ownerKey: string): Promise<string[]> {
  return (await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE deleted_at IS NULL AND frontmatter->>'synthetic_owner' = $1 ORDER BY slug`, [ownerKey])).map(row => row.slug);
}
