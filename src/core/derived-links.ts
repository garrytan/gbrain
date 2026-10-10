import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { assertPageRevision, type PageSnapshot } from './page-state/types.ts';
import { pipelined } from './page-state/transactions.ts';
import { executeRawJsonb } from './sql-query.ts';
import { pageSnapshotKey, readPageSnapshotsBatch } from './page-snapshot-batch.ts';
import { sanitizeForJsonb } from './batch-rows.ts';
import { replaceWantedLinks, type WantedLinksReplacement } from './wanted-links-store.ts';
import { applyTemporalEvidence, relationshipKeysForOrigin } from './link-temporal-apply.ts';
import { primeRelationSemantics } from './link-semantics-pack.ts';
import { effectiveRangesEnabled, LINK_EXTRACTION_GENERATION_KEY, type LineGrammarSettings } from './line-grammar.ts';

export interface DerivedLinkOrigin {
  slug: string;
  sourceId: string;
  expectedRevision: string;
  sourceIncarnation: string;
  /**
   * The caller's own read of the origin (live rows only) in the transaction this
   * replacement nests in, taken under that transaction's guard of every key the
   * replacement locks and after its last write to the origin; skips the re-read.
   */
  snapshot?: PageSnapshot | null;
}

export interface DerivedLinkReplacementOptions {
  includeFrontmatter?: boolean;
  preserveExisting?: boolean;
  includeLegacyNullProducer?: boolean;
  expectedEndpoints?: Array<{ slug: string; sourceId: string; revision: string }>;
  /** The origin's unresolved authored references, replaced in the same transaction (wanted pages). */
  wanted?: WantedLinksReplacement;
  /** The caller installed the pack relation semantics already (links-preparation.ts `primeSemantics`). */
  semanticsPrimed?: boolean;
  /**
   * The line-grammar settings the links were prepared under. Publication uses
   * them for validity ranges (never a second read) and refuses with
   * DerivedLinkSettingsChangedError when the extraction generation moved since,
   * so a page is never published from one setting and ranged from another.
   */
  lineGrammar?: LineGrammarSettings;
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

/** The line-grammar settings changed between preparation and publication; the page stays stale and re-extracts. */
export class DerivedLinkSettingsChangedError extends DerivedLinkEndpointChangedError {
  constructor() { super('Line-grammar settings changed after these links were prepared'); this.name = 'DerivedLinkSettingsChangedError'; }
}

/** replaceDerivedLinks, or null when the line-grammar settings moved since preparation (the page stays stale). */
export async function replaceDerivedLinksUnlessSettingsChanged(engine: Pick<BrainEngine, 'replaceDerivedLinks'>,
  ...args: Parameters<BrainEngine['replaceDerivedLinks']>): Promise<{ created: number; removed: number } | null> {
  try { return await engine.replaceDerivedLinks(...args); }
  catch (error) { if (error instanceof DerivedLinkSettingsChangedError) return null; throw error; }
}

/** The operator line for pages a settings change left stale mid-run. */
export const settingsChangedSkipLine = (n: number) =>
  `Skipped ${n} page(s) because the line-grammar settings changed during this run; they stay stale. Run \`gbrain extract --stale\` to finish them.`;

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

/** Validate and normalize one origin's candidate rows (deduplicated, producer and origin stamped). */
function derivedLinkRows(origin: DerivedLinkOrigin, links: LinkBatchInput[], opts: DerivedLinkReplacementOptions) {
  const producers = ['markdown', 'wikilink-resolved', ...(opts.includeFrontmatter === false ? [] : ['frontmatter'])];
  const unique = new Map<string, LinkBatchInput>();
  for (const link of links) {
    const producer = link.link_source ?? 'markdown';
    if (!producers.includes(producer)) throw new TypeError(`Only selected derived link producers can be replaced (got: ${JSON.stringify(producer)}, allowed: ${producers.join(', ')})`);
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
  return { producers, rows: [...unique.values()] };
}

const derivedLinkLockKeys = (origin: DerivedLinkOrigin, rows: LinkBatchInput[]) => [{ sourceId: origin.sourceId, slug: origin.slug },
  ...rows.flatMap(row => [{ sourceId: row.from_source_id!, slug: row.from_slug }, { sourceId: row.to_source_id!, slug: row.to_slug }])];

/** FOR SHARE: a concurrent setting change (which updates this row) waits for this publication, or this one sees it. */
const lockedExtractionGeneration = async (tx: BrainEngine) => (await tx.executeRaw<{ value: string }>(
  'SELECT value FROM config WHERE key = $1 FOR SHARE', [LINK_EXTRACTION_GENERATION_KEY]))[0]?.value ?? null;

export async function replaceDerivedLinks(
  engine: Pick<BrainEngine, 'transaction'>,
  origin: DerivedLinkOrigin,
  links: LinkBatchInput[],
  opts: DerivedLinkReplacementOptions = {},
): Promise<{ created: number; removed: number }> {
  const { producers, rows } = derivedLinkRows(origin, links, opts);
  return engine.transaction(async tx => {
    await pipelined(tx, [
      async () => { if (!opts.semanticsPrimed) await primeRelationSemantics(tx); },
      () => tx.lockPageKeys(derivedLinkLockKeys(origin, rows)),
    ]);
    if (opts.lineGrammar && await lockedExtractionGeneration(tx) !== opts.lineGrammar.generation) throw new DerivedLinkSettingsChangedError();
    const snapshot = origin.snapshot !== undefined ? origin.snapshot : await tx.readPageSnapshot(origin.slug, { sourceId: origin.sourceId });
    return publishDerivedLinks(tx, origin, producers, rows, opts, snapshot);
  });
}

export interface DerivedLinkBatchItem { origin: DerivedLinkOrigin; links: LinkBatchInput[]; opts?: DerivedLinkReplacementOptions }

/**
 * replaceDerivedLinks for many origins in one transaction (bulk `extract
 * --source db`). Each origin runs the same checks and writes as its own call,
 * in order; the relation-semantics prime, the page guards (every origin and
 * endpoint, one sorted lock), the extraction-generation check and the origin
 * reads are shared. Any failure, a settings change included, rolls the whole
 * batch back; callers that need per-origin outcomes then replay the origins
 * one by one through replaceDerivedLinks.
 */
export async function replaceDerivedLinksBatch(
  engine: Pick<BrainEngine, 'transaction'>,
  items: readonly DerivedLinkBatchItem[],
): Promise<Array<{ created: number; removed: number }>> {
  const prepared = items.map(item => ({ origin: item.origin, opts: item.opts ?? {}, ...derivedLinkRows(item.origin, item.links, item.opts ?? {}) }));
  if (!prepared.length) return [];
  return engine.transaction(async tx => {
    await pipelined(tx, [
      async () => { if (prepared.some(item => !item.opts.semanticsPrimed)) await primeRelationSemantics(tx); },
      () => tx.lockPageKeys(prepared.flatMap(item => derivedLinkLockKeys(item.origin, item.rows))),
    ]);
    if (prepared.some(item => item.opts.lineGrammar)) {
      const generation = await lockedExtractionGeneration(tx);
      if (prepared.some(item => item.opts.lineGrammar && item.opts.lineGrammar.generation !== generation)) throw new DerivedLinkSettingsChangedError();
    }
    const { snapshots } = await readPageSnapshotsBatch(tx, prepared.filter(item => item.origin.snapshot === undefined)
      .map(item => ({ slug: item.origin.slug, sourceId: item.origin.sourceId })), { maxBytes: Number.MAX_SAFE_INTEGER });
    const results: Array<{ created: number; removed: number }> = [];
    for (const { origin, producers, rows, opts } of prepared) {
      const snapshot = origin.snapshot !== undefined ? origin.snapshot : snapshots.get(pageSnapshotKey(origin.sourceId, origin.slug)) ?? null;
      results.push(await publishDerivedLinks(tx, origin, producers, rows, opts, snapshot));
    }
    return results;
  });
}

/**
 * Publish through replaceDerivedLinksBatch; when that transaction fails,
 * replay the origins one by one so every outcome is the unbatched one: null
 * for a settings-changed skip, and the first failing origin's error thrown
 * (after `onError`) with the origins before it committed.
 */
export async function replaceDerivedLinksBatchOrReplay(engine: Pick<BrainEngine, 'replaceDerivedLinks' | 'replaceDerivedLinksBatch'>,
  items: readonly DerivedLinkBatchItem[], onError?: (item: DerivedLinkBatchItem) => void): Promise<Array<{ created: number; removed: number } | null>> {
  if (!items.length) return [];
  try { return await engine.replaceDerivedLinksBatch(items); }
  catch {
    const results: Array<{ created: number; removed: number } | null> = [];
    for (const item of items) {
      try { results.push(await replaceDerivedLinksUnlessSettingsChanged(engine, item.origin, item.links, item.opts)); }
      catch (error) { onError?.(item); throw error; }
    }
    return results;
  }
}

/** Under the caller's guards: check the origin read, then replace its derived links and temporal evidence. */
async function publishDerivedLinks(tx: BrainEngine, origin: DerivedLinkOrigin, producers: string[], rows: LinkBatchInput[],
  opts: DerivedLinkReplacementOptions, snapshot: PageSnapshot | null): Promise<{ created: number; removed: number }> {
  assertPageRevision(snapshot, { expectedRevision: origin.expectedRevision });
  if (!snapshot || snapshot.sourceIncarnation !== origin.sourceIncarnation || snapshot.page.deleted_at) {
    throw new Error('Derived link origin changed or was deleted');
  }
  const id = snapshot.page.id;
  // The wanted-page replacement and every read the checks below need are sent together, then judged in order.
  // Temporal evidence (tense, dated transitions, relationship state) is part
  // of the same derived projection: captured before, replaced after.
  type Existing = { id: number; from_slug: string; to_slug: string; from_source_id: string; to_source_id: string; link_type: string;
    link_source: string | null; origin_slug: string | null; origin_source_id: string | null; context: string; origin_field: string | null };
  const [, temporalKeysBefore, ambiguous, missing, changed, existing, inlineRanges] = await pipelined(tx, [
    async () => { if (opts.wanted) await replaceWantedLinks(tx, { pageId: id, sourceId: origin.sourceId }, opts.wanted); },
    () => relationshipKeysForOrigin(tx, Number(id)),
    () => opts.includeFrontmatter !== false && !opts.preserveExisting ? tx.executeRaw(`SELECT 1 FROM links WHERE link_source='frontmatter'
        AND origin_page_id IS NULL AND (from_page_id=$1 OR to_page_id=$1) LIMIT 1`, [id]) : Promise.resolve([]),
    () => executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
      AS v(from_slug text, to_slug text, from_source_id text, to_source_id text)
      LEFT JOIN pages f ON f.slug=v.from_slug AND f.source_id=v.from_source_id AND f.deleted_at IS NULL
      LEFT JOIN pages t ON t.slug=v.to_slug AND t.source_id=v.to_source_id AND t.deleted_at IS NULL
      WHERE f.id IS NULL OR t.id IS NULL LIMIT 1`, [], [{ rows }]),
    () => opts.expectedEndpoints?.length ? executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
        AS v(slug text, "sourceId" text, revision text)
        LEFT JOIN pages p ON p.slug=v.slug AND p.source_id=v."sourceId" AND p.deleted_at IS NULL
        WHERE p.id IS NULL OR p.knowledge_revision::text <> v.revision LIMIT 1`, [], [{ rows: opts.expectedEndpoints }]) : Promise.resolve([]),
    () => opts.preserveExisting ? tx.executeRaw<Existing>(`SELECT l.id, f.slug from_slug, t.slug to_slug,
          f.source_id from_source_id, t.source_id to_source_id, l.link_type, l.link_source,
          o.slug origin_slug, o.source_id origin_source_id, l.context, l.origin_field
        FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        LEFT JOIN pages o ON o.id=l.origin_page_id
        WHERE (l.link_source=ANY($2::text[]) OR ($3::boolean AND l.link_source IS NULL))
          AND (l.origin_page_id=$1 OR (l.origin_page_id IS NULL AND l.from_page_id=$1
            AND (l.link_source IN ('markdown','wikilink-resolved') OR l.link_source IS NULL)))`, [id, producers, opts.includeLegacyNullProducer !== false]) : Promise.resolve([]),
    () => opts.lineGrammar ? Promise.resolve(opts.lineGrammar.effectiveRanges) : effectiveRangesEnabled(tx),
  ]) as [unknown, Awaited<ReturnType<typeof relationshipKeysForOrigin>>, unknown[], unknown[], unknown[], Existing[], boolean];
  const withTemporal = async (result: { created: number; removed: number }) => {
    await applyTemporalEvidence(tx, snapshot.page, rows, temporalKeysBefore, { inlineRanges });
    return result;
  };
  if (ambiguous.length) throw new DerivedLinkRepairRequiredError();
  if (missing.length) throw new DerivedLinkEndpointChangedError('A derived link endpoint changed or was deleted');
  if (changed.length) throw new DerivedLinkEndpointChangedError('A derived link endpoint changed after type resolution');
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
    return withTemporal({ created, removed: obsolete.length });
  }
  const removed = await tx.executeRaw(`DELETE FROM links WHERE link_source=ANY($2::text[])
      AND (origin_page_id=$1 OR (origin_page_id IS NULL AND from_page_id=$1
        AND link_source IN ('markdown','wikilink-resolved'))) RETURNING id`, [id, producers]);
  const created = await tx.addLinksBatch(rows, { auditSite: 'addLinksBatch' });
  if (created !== rows.length) throw new Error('Derived link replacement did not persist every candidate');
  return withTemporal({ created, removed: removed.length });
}
