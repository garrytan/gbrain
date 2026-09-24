import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { assertPageRevision } from './page-state/types.ts';
import { executeRawJsonb } from './sql-query.ts';

export interface DerivedLinkOrigin {
  slug: string;
  sourceId: string;
  expectedRevision: string;
  sourceIncarnation: string;
}

export interface DerivedLinkReplacementOptions {
  includeFrontmatter?: boolean;
  expectedEndpoints?: Array<{ slug: string; sourceId: string; revision: string }>;
}

export class DerivedLinkRepairRequiredError extends Error {
  readonly code = 'derived_link_provenance_required';
  constructor() {
    super('Derived frontmatter edges have no origin. Repair their provenance before reconciliation.');
    this.name = 'DerivedLinkRepairRequiredError';
  }
}

export async function replaceDerivedLinks(
  engine: Pick<BrainEngine, 'transaction'>,
  origin: DerivedLinkOrigin,
  links: LinkBatchInput[],
  opts: DerivedLinkReplacementOptions = {},
): Promise<{ created: number; removed: number }> {
  const producers = ['markdown', 'wikilink-resolved', ...(opts.includeFrontmatter === false ? [] : ['frontmatter'])];
  const unique = new Map<string, LinkBatchInput>();
  for (const link of links) {
    const producer = link.link_source ?? 'markdown';
    if (!producers.includes(producer)) throw new TypeError('Only selected derived link producers can be replaced');
    if ((link.origin_slug && link.origin_slug !== origin.slug)
      || (link.origin_source_id && link.origin_source_id !== origin.sourceId)) {
      throw new TypeError('Derived link origin does not match the replacement scope');
    }
    const row = { ...link, link_source: producer, origin_slug: producer === 'frontmatter' ? origin.slug : undefined, origin_source_id: origin.sourceId,
      from_source_id: link.from_source_id ?? origin.sourceId, to_source_id: link.to_source_id ?? origin.sourceId };
    if (producer !== 'frontmatter' && (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId)) {
      throw new TypeError('Markdown links must originate at the replaced page');
    }
    if (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId) {
      if (row.to_slug !== origin.slug || row.to_source_id !== origin.sourceId) throw new TypeError('Derived links must reference their origin');
    }
    const key = JSON.stringify([row.from_source_id, row.from_slug, row.to_source_id, row.to_slug, row.link_type ?? '', producer]);
    if (!unique.has(key)) unique.set(key, row);
  }
  const rows = [...unique.values()];
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: origin.sourceId, slug: origin.slug }, ...rows.flatMap(row => [
      { sourceId: row.from_source_id!, slug: row.from_slug }, { sourceId: row.to_source_id!, slug: row.to_slug },
    ])]);
    const snapshot = await tx.readPageSnapshot(origin.slug, { sourceId: origin.sourceId });
    assertPageRevision(snapshot, { expectedRevision: origin.expectedRevision });
    if (!snapshot || snapshot.sourceIncarnation !== origin.sourceIncarnation || snapshot.page.deleted_at) {
      throw new Error('Derived link origin changed or was deleted');
    }
    const id = snapshot.page.id;
    if (opts.includeFrontmatter !== false) {
      const ambiguous = await tx.executeRaw(`SELECT 1 FROM links WHERE link_source='frontmatter'
        AND origin_page_id IS NULL AND (from_page_id=$1 OR to_page_id=$1) LIMIT 1`, [id]);
      if (ambiguous.length) throw new DerivedLinkRepairRequiredError();
    }
    const missing = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
      AS v(from_slug text, to_slug text, from_source_id text, to_source_id text)
      LEFT JOIN pages f ON f.slug=v.from_slug AND f.source_id=v.from_source_id AND f.deleted_at IS NULL
      LEFT JOIN pages t ON t.slug=v.to_slug AND t.source_id=v.to_source_id AND t.deleted_at IS NULL
      WHERE f.id IS NULL OR t.id IS NULL LIMIT 1`, [], [{ rows }]);
    if (missing.length) throw new Error('A derived link endpoint changed or was deleted');
    if (opts.expectedEndpoints?.length) {
      const changed = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
        AS v(slug text, "sourceId" text, revision text)
        LEFT JOIN pages p ON p.slug=v.slug AND p.source_id=v."sourceId" AND p.deleted_at IS NULL
        WHERE p.id IS NULL OR p.knowledge_revision::text <> v.revision LIMIT 1`, [], [{ rows: opts.expectedEndpoints }]);
      if (changed.length) throw new Error('A derived link endpoint changed after type resolution');
    }
    const removed = await tx.executeRaw(`DELETE FROM links WHERE link_source=ANY($2::text[])
      AND (origin_page_id=$1 OR (origin_page_id IS NULL AND from_page_id=$1
        AND link_source IN ('markdown','wikilink-resolved'))) RETURNING id`, [id, producers]);
    const created = await tx.addLinksBatch(rows, { auditSite: 'addLinksBatch' });
    if (created !== rows.length) throw new Error('Derived link replacement did not persist every candidate');
    return { created, removed: removed.length };
  });
}
