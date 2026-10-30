/**
 * GBRA-161 PR 2: model-extracted facts on the generation primitive (kind `extracted_facts`, one owner key per source page
 * and writer). This is the publish path the conversation lane and the facts backstop move onto (GBRA-60):
 * `publishExtractedFacts`.
 *
 * - Coverage: a result that read the whole page (`whole_body`) is complete, so the rows it no longer has retire, each
 *   with its before-state on the ledger, under the model-produced shrink floor and valve; an empty `whole_body` result
 *   retires nothing without a proof (`no_proof`). A result over an appended range (`appended_range`) is additive: it
 *   writes its rows and retires nothing.
 * - Ownership: an assistant-attributed or third-party fact (`attributed_to` `assistant` or `other`) is never attached
 *   to an entity page as an owner fact. Whatever subject the extractor or subject inference gave it, it is stored on the
 *   page it was extracted from with no entity, and the outcome lists it under `detached`.
 */
import type { BrainEngine, NewFact } from '../../engine.ts';
import { digest } from '../../persistence/digest.ts';
import type { GenerationAdapter, GenerationKey, InputState, ItemRow, ProposedItem } from '../contract.ts';
import { publishGeneration, type PublishOutcome } from '../publish.ts';
import { factPreimages, restoreFactRow, type FactPreimage } from './fact-rows.ts';

export const EXTRACTED_FACTS_KIND = 'extracted_facts';
export type ExtractedFactsWriter = 'conversation' | 'backstop';
/** What the producer read: the whole page, or only a range appended since its last run. Only `whole_body` may retire. */
export type ExtractionCoverage = 'whole_body' | 'appended_range';

const SOURCE_PREFIX: Record<ExtractedFactsWriter, string> = { conversation: 'cli:extract-conversation-facts', backstop: 'backstop:extracted-facts' };

export interface ExtractedFactsRequest {
  sourceId: string;
  /** The page the facts were extracted from (a conversation, a captured turn). */
  slug: string;
  writer: ExtractedFactsWriter;
  coverage: ExtractionCoverage;
  /** The page as the producer read it (`pin` changes whenever it does); activation refuses when it moved. */
  input: InputState;
  facts: ReadonlyArray<Omit<NewFact, 'source'> & { source?: string }>;
  runId?: string;
}

export type ExtractedFactsOutcome = PublishOutcome & { detached: Array<{ fact: string; entity_slug: string; attributed_to: 'assistant' | 'other' }> };

type StoredFact = Omit<NewFact, 'valid_from' | 'valid_until'> & { valid_from?: string | null; valid_until?: string | null };

const ownerKey = (slug: string, writer: ExtractedFactsWriter) => `page:${slug}:${writer}`;
const parseOwner = (key: GenerationKey) => {
  const writer = key.ownerKey.slice(key.ownerKey.lastIndexOf(':') + 1) as ExtractedFactsWriter;
  return { slug: key.ownerKey.slice('page:'.length, key.ownerKey.lastIndexOf(':')), writer, prefix: SOURCE_PREFIX[writer] };
};
const identityOf = (row: { fact: string; visibility?: string | null; entity_slug?: string | null; attributed_to?: string | null }) =>
  digest(['extracted-fact-v1', row.fact, row.visibility ?? 'private', row.entity_slug ?? null, row.attributed_to ?? null]).slice(0, 32);
const itemKeyOf = (row: Parameters<typeof identityOf>[0]) => `fact:${identityOf(row)}`;

/** The ownership rule, applied before anything is keyed or written. */
function placeFacts(request: ExtractedFactsRequest): { rows: StoredFact[]; detached: ExtractedFactsOutcome['detached'] } {
  const detached: ExtractedFactsOutcome['detached'] = [];
  const rows = request.facts.map(fact => {
    const { valid_from, valid_until, ...rest } = fact;
    const row: StoredFact = { ...rest, source: fact.source ?? SOURCE_PREFIX[request.writer], valid_from: valid_from ? valid_from.toISOString() : null,
      valid_until: valid_until ? valid_until.toISOString() : null };
    const attribution = fact.attributed_to;
    if ((attribution === 'assistant' || attribution === 'other') && fact.entity_slug && fact.entity_slug !== request.slug) {
      detached.push({ fact: fact.fact, entity_slug: fact.entity_slug, attributed_to: attribution });
      return { ...row, entity_slug: null, context: [fact.context, `entity ${fact.entity_slug} not attached: ${attribution}-attributed`].filter(Boolean).join('; ') };
    }
    return row;
  });
  return { rows, detached };
}

async function storedRows(engine: BrainEngine, key: GenerationKey): Promise<FactPreimage[]> {
  const { slug, prefix } = parseOwner(key);
  const ids = (await engine.executeRaw<{ id: number }>(
    `SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND COALESCE(source,'') LIKE $3 ORDER BY id`, [key.sourceId, slug, `${prefix}%`])).map(row => Number(row.id));
  return factPreimages(engine, key.sourceId, ids);
}

export const extractedFactsAdapter: GenerationAdapter<{ input: InputState }> = {
  kind: EXTRACTED_FACTS_KIND,
  retiredBy: 'generation-restore',
  modelProduced: true,
  lockKeys: key => [{ sourceId: key.sourceId, slug: parseOwner(key).slug }],
  async readInput(engine, key, context) {
    const [page] = await engine.executeRaw<{ live: boolean }>('SELECT deleted_at IS NULL AS live FROM pages WHERE source_id=$1 AND slug=$2 ORDER BY deleted_at NULLS FIRST LIMIT 1',
      [key.sourceId, parseOwner(key).slug]);
    return page?.live ? context?.input ?? null : null;
  },
  async readItems(engine, key) {
    const out = new Map<string, ItemRow>();
    for (const row of await storedRows(engine, key)) {
      const itemKey = itemKeyOf(row);
      const live = row.expired_at === null;
      if (out.get(itemKey)?.live && !live) continue;
      out.set(itemKey, { key: itemKey, identityHash: identityOf(row), live, owned: true, segmented: false,
        preimage: () => ({ json: row as unknown as Record<string, unknown>, bytes: JSON.stringify(row).length }) });
    }
    return out;
  },
  legacyEvidence: async () => new Set(),
  async publishItems(tx, key, items: readonly ProposedItem[]) {
    const { slug } = parseOwner(key);
    const [max] = await tx.executeRaw<{ n: number | null }>('SELECT MAX(row_num)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [key.sourceId, slug]);
    let rowNum = Number(max?.n ?? 0);
    const rows = items.map(item => {
      const { valid_from, valid_until, ...stored } = JSON.parse(item.content) as StoredFact;
      return { ...stored, source: stored.source, row_num: ++rowNum, source_markdown_slug: slug,
        ...(valid_from ? { valid_from: new Date(valid_from) } : {}), ...(valid_until ? { valid_until: new Date(valid_until) } : {}) } as NewFact & { row_num: number; source_markdown_slug: string };
    });
    if (rows.length) await tx.insertFacts(rows, { source_id: key.sourceId }); // gbrain-allow-direct-insert: extracted-facts generation activation, inside its maintenance transaction
  },
  async retireItems(tx, key, itemKeys) {
    if (!itemKeys.length) return;
    const wanted = new Set(itemKeys);
    const ids = (await storedRows(tx, key)).filter(row => row.expired_at === null && wanted.has(itemKeyOf(row))).map(row => Number(row.id));
    if (ids.length) await tx.executeRaw('UPDATE facts SET expired_at = now() WHERE source_id=$1 AND id = ANY($2::bigint[]) AND expired_at IS NULL', [key.sourceId, ids]);
  },
  async restoreItem(tx, key, _itemKey, preimage) {
    if (!await restoreFactRow(tx, key.sourceId, preimage)) throw new Error(`extracted fact ${String(preimage.id)} changed; nothing restored`);
  },
  preimageIdentity: preimage => identityOf(preimage as unknown as Parameters<typeof identityOf>[0]),
};

/**
 * GBRA-60 entry point: publishes one page's extracted facts as a generation of `writer` on that page. Call it
 * with the whole result of one extraction and the page input it read; `coverage` says whether that was the whole page.
 * `facts` are the rows the write gate already let through (`decideFactWrite`, as conversation-publication.ts and
 * backstop.ts decide today); this publishes them and records no gate receipt.
 */
export async function publishExtractedFacts(engine: BrainEngine, request: ExtractedFactsRequest): Promise<ExtractedFactsOutcome> {
  const { rows, detached } = placeFacts(request);
  const items = [...new Map(rows.map(row => [itemKeyOf(row), { key: itemKeyOf(row), content: JSON.stringify(row), identityHash: identityOf(row) }])).values()];
  const outcome = await publishGeneration(engine, extractedFactsAdapter, { key: { kind: EXTRACTED_FACTS_KIND, sourceId: request.sourceId, ownerKey: ownerKey(request.slug, request.writer) },
    items, input: request.input, partial: request.coverage === 'appended_range', runId: request.runId, context: { input: request.input } });
  return { ...outcome, detached };
}
