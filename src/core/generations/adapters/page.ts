/**
 * GBRA-161: the page building blocks every page-backed generation adapter shares (atoms and the synthetic test adapter
 * here; concepts, summaries and synthesis output in later PRs). The identity hash covers what a page says (type, title,
 * body, timeline, tags and frontmatter) and leaves out every stamp and provenance key, so a completion flip, an extraction
 * timestamp or a retirement stamp never reads as an edit, while a person's edit always does. Preimages are bounded copies
 * kept in `derived_generation_items`; a segmented page has none (the primitive holds it instead).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { importFromContent } from '../../import-file.ts';
import { parseMarkdown, serializeMarkdown } from '../../markdown.ts';
import { PAGE_INLINE_MAX_BYTES } from '../../page-size-policy.ts';
import { stableJson } from '../../persistence/digest.ts';
import { RESERVED_RETIREMENT_KEYS } from '../../persistence/derived-retirement-hold.ts';
import type { PageType } from '../../types.ts';
import { HASH_EPHEMERAL_FRONTMATTER_KEYS } from '../../utils.ts';
import type { ItemRow, Preimage, ProposedItem } from '../contract.ts';

/**
 * Frontmatter keys the identity hash ignores: completion, extraction and retirement stamps, the keys the content hash
 * already treats as ephemeral, and the first-write provenance a managed writer stamps (source_kind, ingested_via).
 */
export const IDENTITY_EXCLUDED_KEYS: ReadonlySet<string> = new Set(['source_hash', 'extracted_at', 'extracted_by', 'source_kind', 'ingested_via',
  ...HASH_EPHEMERAL_FRONTMATTER_KEYS, ...RESERVED_RETIREMENT_KEYS]);

/** The largest preimage a generation item keeps (UTF-8 bytes of its JSON); a larger page restores from no copy. */
export const PREIMAGE_MAX_BYTES = PAGE_INLINE_MAX_BYTES;

export interface PageIdentityInput {
  type: string; title: string; compiled_truth: string | null; timeline: string | null; frontmatter: Record<string, unknown> | null; tags: readonly string[];
}

export interface PageRowData extends PageIdentityInput { slug: string; page_id: number; deleted: boolean; segmented: boolean }

function normalizedFrontmatter(frontmatter: Record<string, unknown> | null): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(frontmatter ?? {})) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(plain).filter(([key]) => !IDENTITY_EXCLUDED_KEYS.has(key) && key !== 'type' && key !== 'title' && key !== 'tags'));
}

export function pageIdentityHash(page: PageIdentityInput): string {
  return createHash('sha256').update(stableJson({ type: page.type, title: page.title, body: (page.compiled_truth ?? '').trim(), timeline: (page.timeline ?? '').trim(),
    frontmatter: normalizedFrontmatter(page.frontmatter), tags: [...page.tags].sort() })).digest('hex');
}

/** A proposed page item from the markdown the producer would import. */
export function markdownItem(slug: string, content: string): ProposedItem {
  const parsed = parseMarkdown(content, slug);
  return { key: slug, content, identityHash: pageIdentityHash({ type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags }) };
}

/** Rows of `sourceId` matching `where` (a constant predicate over alias `p`; parameters start at $2), deleted rows included. */
export async function readPageRows(engine: BrainEngine, sourceId: string, where: string, params: readonly unknown[]): Promise<PageRowData[]> {
  const rows = await engine.executeRaw<PageRowData & { tags: string[] | null }>(
    `SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,
            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
       FROM pages p WHERE p.source_id = $1 AND (${where}) ORDER BY p.slug`, [sourceId, ...params]);
  return rows.map(row => ({ ...row, page_id: Number(row.page_id), tags: row.tags ?? [] }));
}

export function pagePreimage(row: PageRowData): Preimage {
  const json = { slug: row.slug, type: row.type, title: row.title, compiled_truth: row.compiled_truth, timeline: row.timeline ?? '',
    frontmatter: row.frontmatter ?? {}, tags: [...row.tags], deleted: row.deleted };
  const bytes = Buffer.byteLength(JSON.stringify(json));
  return row.segmented || row.compiled_truth === null || bytes > PREIMAGE_MAX_BYTES ? { json: null, bytes } : { json, bytes };
}

export function pageItemRow(row: PageRowData, owned: boolean): ItemRow {
  return { key: row.slug, identityHash: pageIdentityHash(row), live: !row.deleted, owned, segmented: row.segmented, preimage: () => pagePreimage(row) };
}

export function preimageIdentity(preimage: Record<string, unknown>): string {
  return pageIdentityHash({ type: String(preimage.type), title: String(preimage.title), compiled_truth: preimage.compiled_truth as string,
    timeline: (preimage.timeline as string) ?? '', frontmatter: (preimage.frontmatter as Record<string, unknown>) ?? {}, tags: (preimage.tags as string[]) ?? [] });
}

/** The markdown a preimage restores, without retirement stamps. */
export function preimageMarkdown(preimage: Record<string, unknown>): string {
  const frontmatter = { ...(preimage.frontmatter as Record<string, unknown>) };
  for (const key of RESERVED_RETIREMENT_KEYS) delete frontmatter[key];
  return serializeMarkdown(frontmatter, String(preimage.compiled_truth ?? ''), String(preimage.timeline ?? ''),
    { type: String(preimage.type) as PageType, title: String(preimage.title), tags: (preimage.tags as string[]) ?? [] });
}

/** Writes one page item inside the activation transaction; without a post-commit embedding hook it leaves embeddings to the backfill. */
export async function importPageItem(tx: BrainEngine, sourceId: string, slug: string, content: string,
  opts: Partial<Parameters<typeof importFromContent>[3]> = {}): Promise<void> {
  await importFromContent(tx, slug, content, { noEmbed: true, ...opts, sourceId, preserveGateMarkers: true });
}

/** Rows whose retained page version was written by the producer (`producer`: a predicate over version alias `v`) at the row's identity. */
export async function pageVersionEvidence(engine: BrainEngine, sourceId: string, rows: readonly ItemRow[], producer: string): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const versions = await engine.executeRaw<PageIdentityInput & { slug: string; tags: string[] | null }>(
    `SELECT p.slug, v.type, v.title, v.compiled_truth, v.timeline, v.frontmatter, v.tags
       FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND v.compiled_truth IS NOT NULL AND v.title IS NOT NULL AND (${producer})`,
    [sourceId, rows.map(row => row.key)]);
  const wanted = new Map(rows.map(row => [row.key, row.identityHash]));
  return new Set(versions.filter(v => pageIdentityHash({ ...v, tags: v.tags ?? [] }) === wanted.get(v.slug)).map(v => v.slug));
}
