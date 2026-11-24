/**
 * The reads of the atom generation adapter (generations/adapters/atoms.ts) and of page.ts `pageVersionEvidence` as
 * typed engine members. Each member sends the statement the adapter sent through `executeRaw`, byte for byte, with the
 * same parameters: a page origin's input pin (`readAtomOriginInput`), the stored versions an extractor wrote at the
 * listed slugs (`listProducerVersionRows`) and the committed managed atom write receipts of the listed slugs
 * (`listAtomWriteReceipts`). These are internal reads of derived pages and the write journal, not caller page reads, so
 * they take no page read policy, as the statements never did. The statements have no ORDER BY; the callers key the rows
 * by slug. The Rust engine serves them from its page, version, request and activation records
 * (rust/crates/gbrain-store/src/generations/atom_reads.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** A live page origin's input: its id, content hash, knowledge revision and stored body size. */
export interface AtomOriginInputRow { id: number; content_hash: string | null; revision: string | null; body_bytes: number | null }

/** The producers whose stored versions count as evidence: `extract_atoms` (`frontmatter.extracted_by` starts with it). */
export type GenerationVersionProducer = 'extract_atoms';

/** One stored version of a listed page that the producer wrote, with the page's live `visibility` value. */
export interface ProducerVersionRow {
  slug: string; type: string; title: string; compiled_truth: string; timeline: string | null;
  frontmatter: Record<string, unknown> | null; tags: string[] | null; live_visibility: unknown;
}

/** One committed managed atom write receipt and the content it wrote. */
export interface AtomWriteReceiptRow { slug: string; content: string | null }

export const GENERATION_ATOM_READS_SQL = {
  originInput: `SELECT id, content_hash, knowledge_revision::text AS revision,
        CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, '')) END AS body_bytes
       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`,
  extractAtomsVersions: `SELECT p.slug, v.type, v.title, v.compiled_truth, v.timeline, v.frontmatter, v.tags, p.frontmatter->'visibility' AS live_visibility
       FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND v.compiled_truth IS NOT NULL AND v.title IS NOT NULL AND (v.frontmatter->>'extracted_by' LIKE 'extract\\_atoms%')`,
  atomWriteReceipts: `SELECT r.slug, r.intent->>'content' AS content FROM persistence_requests r
      WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.state='committed' AND r.intent->>'kind'='managed_atom_page' AND r.intent ? 'content'
        AND (r.intent->>'activationId' IS NULL OR EXISTS (SELECT 1 FROM derived_generation_activations a WHERE a.id=r.intent->>'activationId' AND a.state='activated'))`,
} as const;

/** Refuses a producer no statement names, so every engine refuses the same calls. */
export function checkGenerationVersionProducer(producer: GenerationVersionProducer): void {
  if (producer !== 'extract_atoms') throw new Error(`listProducerVersionRows: not a version producer: ${JSON.stringify(producer)}`);
}

/** The live page `slug` of `sourceId` as an atom origin input, or null. `id` and `body_bytes` are numbers. */
export async function readAtomOriginInput(raw: EngineRawRead, sourceId: string, slug: string): Promise<AtomOriginInputRow | null> {
  const [row] = await raw<{ id: unknown; content_hash: string | null; revision: string | null; body_bytes: unknown }>(GENERATION_ATOM_READS_SQL.originInput, [sourceId, slug]);
  return row ? { id: Number(row.id), content_hash: row.content_hash, revision: row.revision, body_bytes: row.body_bytes == null ? null : Number(row.body_bytes) } : null;
}

/** The stored versions with a body and title of the pages `slugs` of `sourceId` that `producer` wrote, in no set order. */
export async function listProducerVersionRows(raw: EngineRawRead, sourceId: string, slugs: readonly string[],
  producer: GenerationVersionProducer): Promise<ProducerVersionRow[]> {
  checkGenerationVersionProducer(producer);
  return raw<ProducerVersionRow>(GENERATION_ATOM_READS_SQL.extractAtomsVersions, [sourceId, [...slugs]]);
}

/**
 * The committed `managed_atom_page` write receipts with content of the pages `slugs` of `sourceId` whose activation, if
 * they name one, activated; in no set order.
 */
export async function listAtomWriteReceipts(raw: EngineRawRead, sourceId: string, slugs: readonly string[]): Promise<AtomWriteReceiptRow[]> {
  return raw<AtomWriteReceiptRow>(GENERATION_ATOM_READS_SQL.atomWriteReceipts, [sourceId, [...slugs]]);
}
