/**
 * GBRA-161: the atom adapter. One owner key per origin: `source_slug:<page>`, or `transcript:<root>/<path>` for a
 * transcript (its path relative to the corpus root it was found under, never its basename or content hash; a moved
 * file whose content pin matches keeps its key, extract-atoms.ts `resolveTranscriptKeys`). The items are the atom pages
 * extract_atoms writes for it. Unmanaged: a completed extraction publishes its atoms, their provenance edges and the
 * completion flip (`source_hash`) together with the versioned retirement of the atoms it no longer produced, in one
 * transaction. Managed (PR 1b): the same plan runs through a `managed_generation_activate` request and per-page member
 * requests (generations/managed.ts, persistence/atom-maintenance.ts); only `readInput`, `readItems` and
 * `legacyEvidence` are used there.
 *
 * An atom written before the ledger is the key's only when the extraction reproduces it, or retained producer evidence
 * shows it unedited: a page version written by the extractor, or a committed managed atom write receipt whose content
 * has the row's identity (not one an activation that never happened admitted). Any other atom naming the origin stays
 * live and is reported as protected.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { BrainEngine, LinkBatchInput } from '../../engine.ts';
import { sha256 } from '../../persistence/digest.ts';
import { ATOM_RETIRED_BY_EXTRACT, retireDerivedPagesInTransaction } from '../../persistence/derived-retirement-hold.ts';
import { deriveTrust, lowerDerivedPageIn } from '../../trust/taint.ts';
import { derivedGateInput } from '../../trust/derived-gate.ts';
import type { GenerationAdapter, GenerationKey, InputState } from '../contract.ts';
import { importPageItem, markdownItem, pageItemRow, pageVersionEvidence, preimageIdentity, preimageMarkdown, readPageRows } from './page.ts';

export const ATOM_KIND = 'atom';

/** What one extraction hands the adapter: the transcript's input (pages are read from the database) and the provenance edges. */
export interface AtomGenerationContext {
  /** A transcript's content hash and size as the extractor read it; a page origin is read under the lock instead. */
  transcriptInput?: InputState;
  /** A transcript's current file (its atoms' `source_path`). With `verifyFile` the input is read from the file itself. */
  locator?: string;
  verifyFile?: boolean;
  links?: LinkBatchInput[];
  /** Embedding calls the imports deferred until the activation commits. */
  postCommit?: Array<() => Promise<unknown>>;
  embed?: boolean;
}

type Origin = { field: 'source_slug' | 'source_path'; value: string | null };

export const TRANSCRIPT_KEY_PREFIX = 'transcript:';

/** A page origin's key, or a transcript's (`transcriptKey`: its root label and root-relative path, extract-atoms.ts). */
export function atomOwnerKey(origin: { kind: 'page'; slug: string } | { kind: 'transcript'; transcriptKey: string }): string {
  return origin.kind === 'page' ? `source_slug:${origin.slug}` : `${TRANSCRIPT_KEY_PREFIX}${origin.transcriptKey}`;
}

/**
 * A page origin's input pin: its content hash bound to the page row and its knowledge revision, so an extraction of a
 * page deleted and recreated (or edited back to the same text) during the provider call cannot complete (#4148). The
 * first 16 characters stay the completion stamp (`source_hash`).
 */
export function atomPagePin(contentHash: string, identity: { pageId: number; revision: string } | undefined): string {
  return identity ? `${contentHash}:${identity.pageId}:${identity.revision}` : contentHash;
}

/** The origin metadata a key's atoms carry: a page key's slug; a transcript key's current file (null when unknown). */
function originOf(key: GenerationKey, context?: AtomGenerationContext): Origin {
  if (key.ownerKey.startsWith(TRANSCRIPT_KEY_PREFIX)) return { field: 'source_path', value: context?.locator ?? null };
  if (!key.ownerKey.startsWith('source_slug:')) throw new Error(`not an atom owner key: ${key.ownerKey}`);
  return { field: 'source_slug', value: key.ownerKey.slice('source_slug:'.length) };
}

function readTranscriptFile(path: string): InputState | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return { pin: sha256(bytes), size: bytes.length };
}

export const atomGenerationAdapter: GenerationAdapter<AtomGenerationContext> = {
  kind: ATOM_KIND,
  retiredBy: ATOM_RETIRED_BY_EXTRACT,
  modelProduced: true,
  lockKeys(key, itemKeys) {
    const origin = originOf(key);
    return [...(origin.field === 'source_slug' ? [origin.value!] : []), ...itemKeys].map(slug => ({ sourceId: key.sourceId, slug }));
  },
  async readInput(engine, key, context) {
    const origin = originOf(key, context);
    if (origin.field === 'source_path') return context?.verifyFile && context.locator ? readTranscriptFile(context.locator) : context?.transcriptInput ?? null;
    const [row] = await engine.executeRaw<{ id: number; content_hash: string | null; revision: string | null; body_bytes: number | null }>(
      `SELECT id, content_hash, knowledge_revision::text AS revision,
        CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, '')) END AS body_bytes
       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [key.sourceId, origin.value]);
    return row?.content_hash ? { pin: atomPagePin(row.content_hash, row.revision ? { pageId: Number(row.id), revision: row.revision } : undefined), size: Number(row.body_bytes ?? 0) } : null;
  },
  async readItems(engine, key, itemKeys, context) {
    const origin = originOf(key, context);
    const rows = await readPageRows(engine, key.sourceId,
      `p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'${origin.field}' = $3))`, [[...itemKeys], origin.value]);
    return new Map(rows.map(row => [row.slug, pageItemRow(row, origin.value !== null && row.frontmatter?.[origin.field] === origin.value
      && row.frontmatter?.imported_from == null)]));
  },
  async legacyEvidence(engine, key, rows) {
    const versions = await pageVersionEvidence(engine, key.sourceId, rows, "v.frontmatter->>'extracted_by' LIKE 'extract\\_atoms%'");
    return new Set([...versions, ...await receiptEvidence(engine, key.sourceId, rows.filter(row => !versions.has(row.key)))]);
  },
  async publishItems(tx, key, items, context) {
    const origin = originOf(key);
    const taint = await deriveTrust(tx, origin.field === 'source_slug' ? [{ table: 'pages', sourceId: key.sourceId, slug: origin.value! }] : [], { channel: 'derive:atoms' });
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

/**
 * Rows whose committed managed atom write receipt holds content at the row's identity: the extractor wrote it and it is
 * unedited since. A receipt an activation admitted that never happened is no evidence (its atom is an orphan candidate).
 */
async function receiptEvidence(engine: BrainEngine, sourceId: string, rows: readonly { key: string; identityHash: string }[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const receipts = await engine.executeRaw<{ slug: string; content: string }>(
    `SELECT r.slug, r.intent->>'content' AS content FROM persistence_requests r
      WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.state='committed' AND r.intent->>'kind'='managed_atom_page' AND r.intent ? 'content'
        AND (r.intent->>'activationId' IS NULL OR EXISTS (SELECT 1 FROM derived_generation_activations a WHERE a.id=r.intent->>'activationId' AND a.state='activated'))`,
    [sourceId, rows.map(row => row.key)]);
  const wanted = new Map(rows.map(row => [row.key, row.identityHash]));
  return new Set(receipts.filter(receipt => markdownItem(receipt.slug, receipt.content).identityHash === wanted.get(receipt.slug)).map(receipt => receipt.slug));
}

export async function readAtomInput(engine: BrainEngine, key: GenerationKey): Promise<InputState | null> {
  return atomGenerationAdapter.readInput(engine, key, undefined);
}
