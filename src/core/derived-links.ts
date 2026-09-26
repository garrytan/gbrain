import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { assertPageRevision } from './page-state/types.ts';
import { executeRawJsonb } from './sql-query.ts';
import { sanitizeForJsonb } from './batch-rows.ts';

export interface DerivedLinkOrigin {
  slug: string;
  sourceId: string;
  expectedRevision: string;
  sourceIncarnation: string;
}

export interface DerivedLinkReplacementOptions {
  includeFrontmatter?: boolean;
  preserveExisting?: boolean;
  includeLegacyNullProducer?: boolean;
  expectedEndpoints?: Array<{ slug: string; sourceId: string; revision: string }>;
  /** Limit remote reconciliation to visible edges owned by its source. */
  remoteSource?: { sourceId: string; excludePrivate: boolean };
}

export class DerivedLinkRepairRequiredError extends Error {
  readonly code = 'derived_link_provenance_required';
  constructor() {
    super('Derived frontmatter edges have no origin. Repair their provenance before reconciliation.');
    this.name = 'DerivedLinkRepairRequiredError';
  }
}

export class DerivedLinkEndpointChangedError extends Error {
  readonly code = 'revision_conflict';
}

export async function applyAttendanceDelta(tx: Pick<BrainEngine, 'executeRaw' | 'addLinksBatch'>,
  origin: { id: string; slug: string; source_id: string; type: string }, remove: string[], additions: LinkBatchInput[]) {
  if (origin.type !== 'meeting' || remove.length > 512 || additions.length > 256
    || additions.some(row => row.link_type !== 'attended' || row.to_slug !== origin.slug
      || row.to_source_id !== origin.source_id || row.from_source_id !== origin.source_id
      || row.origin_slug !== origin.slug || row.origin_source_id !== origin.source_id
      || row.link_source !== 'markdown')) throw new Error('Invalid attendance delta');
  const removed = remove.length ? await tx.executeRaw(`DELETE FROM links WHERE id=ANY($1::bigint[])
    AND link_type='attended' AND link_source='markdown'
    AND (origin_page_id=$2::bigint OR (origin_page_id IS NULL AND from_page_id=$2::bigint AND link_source='markdown'))
    RETURNING id`, [remove, origin.id]) : [];
  if (removed.length !== remove.length) throw new Error('Attendance removal changed');
  const created = additions.length ? await tx.addLinksBatch(additions, { auditSite: 'addLinksBatch' }) : 0;
  if (created !== additions.length) throw new Error('Attendance insertion did not persist the approved delta');
  return { created, removed: removed.length };
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
    const reversedAttendance = (producer === 'markdown' || producer === 'wikilink-resolved') && link.link_type === 'attended'
      && link.origin_slug === origin.slug && link.origin_source_id === origin.sourceId
      && (link.from_slug !== origin.slug || (link.from_source_id ?? origin.sourceId) !== origin.sourceId)
      && link.to_slug === origin.slug && (link.to_source_id ?? origin.sourceId) === origin.sourceId;
    const row = { ...link, link_source: producer, origin_slug: producer === 'frontmatter' || reversedAttendance ? origin.slug : undefined, origin_source_id: origin.sourceId,
      from_source_id: link.from_source_id ?? origin.sourceId, to_source_id: link.to_source_id ?? origin.sourceId };
    if (producer !== 'frontmatter' && !reversedAttendance && (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId)) {
      throw new TypeError('Markdown links must originate at the replaced page');
    }
    if (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId) {
      if (row.to_slug !== origin.slug || row.to_source_id !== origin.sourceId) throw new TypeError('Derived links must reference their origin');
    }
    const key = JSON.stringify([row.from_source_id, row.from_slug, row.to_source_id, row.to_slug, row.link_type ?? '', producer]);
    if (!unique.has(key)) unique.set(key, row);
  }
  const rows = [...unique.values()];
  if (opts.remoteSource && (origin.sourceId !== opts.remoteSource.sourceId || rows.some(row =>
    row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId
      || row.to_source_id !== origin.sourceId || row.link_source === 'frontmatter'))) {
    throw new TypeError('Remote derived links must be visible outgoing links in the writer source');
  }
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
    if (opts.includeFrontmatter !== false && !opts.preserveExisting) {
      const ambiguous = await tx.executeRaw(`SELECT 1 FROM links WHERE link_source='frontmatter'
        AND origin_page_id IS NULL AND (from_page_id=$1 OR to_page_id=$1) LIMIT 1`, [id]);
      if (ambiguous.length) throw new DerivedLinkRepairRequiredError();
    }
    const missing = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
      AS v(from_slug text, to_slug text, from_source_id text, to_source_id text)
      LEFT JOIN pages f ON f.slug=v.from_slug AND f.source_id=v.from_source_id AND f.deleted_at IS NULL
      LEFT JOIN pages t ON t.slug=v.to_slug AND t.source_id=v.to_source_id AND t.deleted_at IS NULL
      WHERE f.id IS NULL OR t.id IS NULL LIMIT 1`, [], [{ rows }]);
    if (missing.length) throw new DerivedLinkEndpointChangedError('A derived link endpoint changed or was deleted');
    if (opts.remoteSource && rows.length) {
      const visible = await executeRawJsonb(tx, `SELECT p.slug FROM jsonb_to_recordset(($2::jsonb)->'rows')
        AS v(to_slug text, to_source_id text)
        JOIN pages p ON p.slug=v.to_slug AND p.source_id=v.to_source_id AND p.deleted_at IS NULL
        WHERE (NOT $1::boolean OR p.frontmatter->>'visibility' IS DISTINCT FROM 'private')
        FOR SHARE OF p`, [opts.remoteSource.excludePrivate], [{ rows }]);
      if (visible.length !== rows.length) throw new DerivedLinkEndpointChangedError('A derived link endpoint is unavailable');
    }
    if (opts.expectedEndpoints?.length) {
      const changed = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
        AS v(slug text, "sourceId" text, revision text)
        LEFT JOIN pages p ON p.slug=v.slug AND p.source_id=v."sourceId" AND p.deleted_at IS NULL
        WHERE p.id IS NULL OR p.knowledge_revision::text <> v.revision LIMIT 1`, [], [{ rows: opts.expectedEndpoints }]);
      if (changed.length) throw new DerivedLinkEndpointChangedError('A derived link endpoint changed after type resolution');
    }
    const reversed = rows.filter(row => row.link_type === 'attended' && row.origin_slug
      && row.to_slug === origin.slug && row.to_source_id === origin.sourceId
      && (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId));
    if (reversed.length) {
      if (snapshot.page.type !== 'meeting' || reversed.some(row => row.link_source !== 'frontmatter' && !opts.expectedEndpoints?.some(endpoint =>
        endpoint.slug === row.from_slug && endpoint.sourceId === row.from_source_id))) {
        throw new TypeError('Canonical attendance requires a meeting origin and revision-bound person endpoints');
      }
      const invalid = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
        AS v(from_slug text, from_source_id text)
        JOIN pages p ON p.slug=v.from_slug AND p.source_id=v.from_source_id
        WHERE p.type <> 'person' LIMIT 1`, [], [{ rows: reversed }]);
      if (invalid.length) throw new TypeError('Canonical attendance requires person endpoints');
    }
    if (opts.preserveExisting) {
      const existing = await tx.executeRaw<{ id: number; from_slug: string; to_slug: string;
        from_source_id: string; to_source_id: string; link_type: string; link_source: string | null;
        origin_slug: string | null; origin_source_id: string | null; context: string; origin_field: string | null }>(`SELECT l.id, f.slug from_slug, t.slug to_slug,
          f.source_id from_source_id, t.source_id to_source_id, l.link_type, l.link_source,
          o.slug origin_slug, o.source_id origin_source_id, l.context, l.origin_field
        FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        LEFT JOIN pages o ON o.id=l.origin_page_id
        WHERE (l.link_source=ANY($2::text[]) OR ($3::boolean AND l.link_source IS NULL))
          AND (l.origin_page_id=$1 OR (l.origin_page_id IS NULL AND l.from_page_id=$1
            AND (l.link_source IN ('markdown','wikilink-resolved') OR l.link_source IS NULL)))
          AND ($4::text IS NULL OR (f.source_id=$4 AND f.id=$1 AND t.source_id=$4
            AND (NOT $5::boolean OR t.frontmatter->>'visibility' IS DISTINCT FROM 'private')))
        ${opts.remoteSource ? 'FOR SHARE OF t' : ''}`,
        [id, producers, opts.includeLegacyNullProducer !== false,
          opts.remoteSource?.sourceId ?? null, opts.remoteSource?.excludePrivate ?? false]);
      const identity = (row: Pick<LinkBatchInput, 'from_source_id' | 'from_slug' | 'to_source_id' | 'to_slug' | 'link_type'>
        & { link_source?: string | null; origin_slug?: string | null }) => JSON.stringify([row.from_source_id, row.from_slug,
        row.to_source_id, row.to_slug, row.link_type ?? '', row.link_source ?? 'markdown', row.origin_slug ?? null]);
      const wanted = new Map(rows.map(row => [identity(row), row]));
      const retained = new Set(existing.map(identity));
      const obsolete = existing.filter(row => !wanted.has(identity(row))).map(row => row.id);
      if (obsolete.length) await tx.executeRaw('DELETE FROM links WHERE id=ANY($1::bigint[])', [obsolete]);
      const updates = existing.flatMap(previous => {
        const desired = wanted.get(identity(previous));
        if (!desired) return [];
        const context = sanitizeForJsonb(desired.context || '');
        const origin_field = desired.origin_field || null;
        return previous.context !== context || previous.origin_field !== origin_field
          ? [{ id: previous.id, context, origin_field }] : [];
      });
      if (updates.length) await executeRawJsonb(tx, `UPDATE links l SET context=v.context, origin_field=v.origin_field
        FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(id bigint, context text, origin_field text)
        WHERE l.id=v.id`, [], [{ rows: updates }]);
      const additions = rows.filter(row => !retained.has(identity(row)));
      const created = additions.length ? await tx.addLinksBatch(additions, { auditSite: 'addLinksBatch' }) : 0;
      if (created !== additions.length) throw new Error('Derived link replacement did not persist every candidate');
      return { created, removed: obsolete.length };
    }
    const removed = await tx.executeRaw(`DELETE FROM links WHERE link_source=ANY($2::text[])
      AND (origin_page_id=$1 OR (origin_page_id IS NULL AND from_page_id=$1
        AND link_source IN ('markdown','wikilink-resolved'))) RETURNING id`, [id, producers]);
    const created = await tx.addLinksBatch(rows, { auditSite: 'addLinksBatch' });
    if (created !== rows.length) throw new Error('Derived link replacement did not persist every candidate');
    return { created, removed: removed.length };
  });
}
