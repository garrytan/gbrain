/**
 * GBRA-161 PR 1a: the unmanaged atom adapter, the first real producer on the primitive. One owner key per origin
 * (`source_slug:<page>` or `source_path:<transcript>`); the items are the atom pages extract_atoms writes for it. A
 * completed extraction publishes its atoms, their provenance edges and the completion flip (`source_hash`) together with
 * the versioned retirement of the atoms it no longer produced, in one transaction. Managed brains keep the coordinator
 * path (persistence/atom-maintenance.ts) until PR 1b.
 *
 * An atom written before this release is the key's only when the extraction reproduces it or a retained page version
 * written by the extractor shows it unedited; any other atom naming the origin stays live and is reported as protected.
 */
import type { BrainEngine, LinkBatchInput } from '../../engine.ts';
import { ATOM_RETIRED_BY_EXTRACT, retireDerivedPagesInTransaction } from '../../persistence/derived-retirement-hold.ts';
import { deriveTrust, lowerDerivedPageIn } from '../../trust/taint.ts';
import { derivedGateInput } from '../../trust/derived-gate.ts';
import type { GenerationAdapter, GenerationKey, InputState } from '../contract.ts';
import { importPageItem, pageItemRow, pageVersionEvidence, preimageIdentity, preimageMarkdown, readPageRows } from './page.ts';

export const ATOM_KIND = 'atom';

/** What one extraction hands the adapter: the transcript's input (pages are read from the database) and the provenance edges. */
export interface AtomGenerationContext {
  /** A transcript's content hash and size; a page origin is read under the lock instead. */
  transcriptInput?: InputState;
  links?: LinkBatchInput[];
  /** Embedding calls the imports deferred until the activation commits. */
  postCommit?: Array<() => Promise<unknown>>;
  embed?: boolean;
}

type Origin = { field: 'source_slug' | 'source_path'; value: string };

export function atomOwnerKey(origin: { kind: 'page'; slug: string } | { kind: 'transcript'; filePath: string }): string {
  return origin.kind === 'page' ? `source_slug:${origin.slug}` : `source_path:${origin.filePath}`;
}

/**
 * A page origin's input pin: its content hash bound to the page row and its knowledge revision, so an extraction of a
 * page deleted and recreated (or edited back to the same text) during the provider call cannot complete (#4148). The
 * first 16 characters stay the completion stamp (`source_hash`).
 */
export function atomPagePin(contentHash: string, identity: { pageId: number; revision: string } | undefined): string {
  return identity ? `${contentHash}:${identity.pageId}:${identity.revision}` : contentHash;
}

function originOf(key: GenerationKey): Origin {
  const at = key.ownerKey.indexOf(':');
  const field = key.ownerKey.slice(0, at);
  if (field !== 'source_slug' && field !== 'source_path') throw new Error(`not an atom owner key: ${key.ownerKey}`);
  return { field, value: key.ownerKey.slice(at + 1) };
}

export const atomGenerationAdapter: GenerationAdapter<AtomGenerationContext> = {
  kind: ATOM_KIND,
  retiredBy: ATOM_RETIRED_BY_EXTRACT,
  modelProduced: true,
  lockKeys(key, itemKeys) {
    const origin = originOf(key);
    return [...(origin.field === 'source_slug' ? [origin.value] : []), ...itemKeys].map(slug => ({ sourceId: key.sourceId, slug }));
  },
  async readInput(engine, key, context) {
    const origin = originOf(key);
    if (origin.field === 'source_path') return context?.transcriptInput ?? null;
    const [row] = await engine.executeRaw<{ id: number; content_hash: string | null; revision: string | null; body_bytes: number | null }>(
      `SELECT id, content_hash, knowledge_revision::text AS revision,
        CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, '')) END AS body_bytes
       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [key.sourceId, origin.value]);
    return row?.content_hash ? { pin: atomPagePin(row.content_hash, row.revision ? { pageId: Number(row.id), revision: row.revision } : undefined), size: Number(row.body_bytes ?? 0) } : null;
  },
  async readItems(engine, key, itemKeys) {
    const origin = originOf(key);
    const rows = await readPageRows(engine, key.sourceId,
      `p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND p.frontmatter->>'${origin.field}' = $3))`, [[...itemKeys], origin.value]);
    return new Map(rows.map(row => [row.slug, pageItemRow(row, row.frontmatter?.[origin.field] === origin.value
      && row.frontmatter?.imported_from == null && row.frontmatter?.managed_extraction !== true)]));
  },
  legacyEvidence: (engine, key, rows) => pageVersionEvidence(engine, key.sourceId, rows, "v.frontmatter->>'extracted_by' LIKE 'extract\\_atoms%'"),
  async publishItems(tx, key, items, context) {
    const origin = originOf(key);
    const taint = await deriveTrust(tx, origin.field === 'source_slug' ? [{ table: 'pages', sourceId: key.sourceId, slug: origin.value }] : [], { channel: 'derive:atoms' });
    for (const item of items) {
      await importPageItem(tx, key.sourceId, item.key, item.content, { writeGate: derivedGateInput(taint.trust),
        ...(context?.embed ? { noEmbed: false, onPostCommitEmbedding: complete => { context.postCommit?.push(complete); } } : {}) });
      await lowerDerivedPageIn(tx, taint, key.sourceId, item.key);
    }
    const written = new Set(items.map(item => item.key));
    const links = (context?.links ?? []).filter(link => written.has(link.to_slug));
    if (links.length) await tx.addLinksBatch(links, { auditSite: 'cycle.extract_atoms.provenance' }); // gbrain-allow-direct-insert: atom-provenance edges derived from the extraction itself (no markdown body to reconcile from)
  },
  async completeItems(tx, key, itemKeys, context) {
    const input = await atomGenerationAdapter.readInput(tx, key, context);
    if (!input || !itemKeys.length) return;
    await tx.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
      WHERE source_id = $2 AND type = 'atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL`, [input.pin.slice(0, 16), key.sourceId, [...itemKeys]]);
  },
  retireItems: (tx, key, itemKeys, retiredBy) => retireDerivedPagesInTransaction(tx, key.sourceId, itemKeys, retiredBy),
  restoreItem: (tx, key, itemKey, preimage) => importPageItem(tx, key.sourceId, itemKey, preimageMarkdown(preimage)),
  preimageIdentity,
};

export async function readAtomInput(engine: BrainEngine, key: GenerationKey): Promise<InputState | null> {
  return atomGenerationAdapter.readInput(engine, key, undefined);
}
