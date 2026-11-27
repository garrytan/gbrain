/**
 * Facts and their supersession chains (BrainEngine insertFact, insertFacts, deleteFactsForPage, expireFact,
 * listFactsByEntity, listFactsSince, listFactsKeyset, listFactsBySession, listSupersessions, countUnconsolidatedFacts,
 * findCandidateDuplicates, consolidateFact, findTrajectory, getFactsHealth, migrateFactsToCanonical, listUnattributedFacts,
 * pageCollapseFacts, listFenceRetireCandidates).
 *
 * Each member applies the defaults and clamps of src/core/engine-sql/facts.ts, then makes one store call. What the
 * store cannot answer exactly refuses with `engine_capability_missing`: a read eligibility policy (except on
 * `listSupersessions`, which sends it to the store), `excludePrivate` for a
 * caller other than the one the store's policy models (private-provenance.ts), the keyword arm in an FTS language other
 * than `english`, a visibility list that the member-page or grant rules widen, and inputs whose PGLite outcome the store cannot reproduce (a non-finite
 * `claim_value`, `row_num` or `superseded_by_row`, a fractional offset, a keyset time in another text form).
 *
 * A vector travels as the literal PGLite inlines (`'[a,b,...]'`); the store casts it to the column's `halfvec` and
 * returns stored vectors as number lists, which become `Float32Array`s here.
 */
import { clampSearchLimit, MAX_SEARCH_LIMIT, type BrainEngine, type FactListOpts, type RecallFactReadOpts } from '../../engine.ts';
import { escapeLikePattern } from '../../cjk.ts';
import { valueHash } from '../../chronicle/ontology.ts';
import { factVisibilitySql } from '../../access/member-facts.ts';
import { ensureWellFormed } from '../../text-safe.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';
import { facetOfMetric } from '../../profile/facets.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type FactRow = Awaited<ReturnType<BrainEngine['listFactsByEntity']>>[number];
type TrajectoryPoint = Awaited<ReturnType<BrainEngine['findTrajectory']>>[number];
type Row = Record<string, unknown>;

const FACT_DATES = ['valid_from', 'valid_until', 'expired_at', 'consolidated_at', 'embedded_at', 'created_at'] as const;
/** A returned vector (a number list or null) as the `Float32Array` PGLite hands back. */
const withVector = (row: Row): Row =>
  Array.isArray(row.embedding) ? { ...row, embedding: new Float32Array(row.embedding as number[]) } : row;
const facts = (rows: Row[]): FactRow[] => rows.map((row) => withDates(withVector(row), FACT_DATES) as unknown as FactRow);

/** PGLite's inlined vector literal (engine-sql/facts.ts `toPgVectorLiteral`). */
const vectorLiteral = (v: Float32Array | number[]): string => '[' + Array.from(v).join(',') + ']';

/** The options every list read declares; each member reads its own subset and ignores the rest, as PGLite does. */
const LIST_OPTIONS = ['activeOnly', 'unconsolidatedOnly', 'limit', 'offset', 'kinds', 'visibility', 'grep', 'sessionId',
  'eventTime', 'excludeAuditRows', 'fingerprint', 'excludePrivate'] as const;

/**
 * `privacyClause` (engine-sql/facts.ts): the policy as the store reads it, or undefined without `excludePrivate`. A
 * caller with a reader identity and a private-readable grant is served (`callerReaders`).
 */
const factPolicy = (member: string, excludePrivate: unknown) =>
  storePrivacyPolicy(member, excludePrivate, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true });
/** `includeUndated` changes nothing here: the store fills `valid_from` on every insert below, so it holds no undated row (#10288). */
const RECALL_OPTIONS = [...LIST_OPTIONS, 'entitySlug', 'sourceMarkdownSlug', 'includeUndated'] as const;

/** A string the SQL path binds inside a JSONB document: a lone surrogate becomes U+FFFD. */
const wellFormed = <T>(s: T): T => (typeof s === 'string' ? ensureWellFormed(s) as T : s);
const iso = (d: Date | null | undefined): string | null | undefined => (d == null ? d : d.toISOString());

/**
 * `visibility` as the store reads it: null for no filter (an empty list), else the list. A list without 'private'
 * that the caller's member pages or grants widen (access/member-facts.ts) refuses: the store has no such rule.
 */
function visibilityFilter(member: string, visibility: readonly string[] | undefined): string[] | undefined {
  if (!visibility || visibility.length === 0) return undefined;
  const known = (['world', 'private'] as const).filter((v) => visibility.includes(v));
  const listed = known.length ? `facts.visibility IN (${known.map((v) => `'${v}'`).join(', ')})` : 'FALSE';
  if (factVisibilitySql('facts', visibility) !== listed) refuseMember(member, 'visibility widened by member pages or grants');
  return [...visibility];
}

function grepPattern(grep: unknown): string | undefined {
  return typeof grep === 'string' && grep.trim() ? '%' + escapeLikePattern(grep.trim()) + '%' : undefined;
}

function offsetOf(member: string, offset: unknown): number {
  const n = Math.max(0, (offset as number | undefined) ?? 0);
  if (!Number.isInteger(n)) refuseMember(member, 'a fractional offset');
  return n;
}

const kindsOf = (kinds: unknown): string[] | undefined => (Array.isArray(kinds) && kinds.length > 0 ? kinds : undefined);

function listQuery(member: string, sourceId: string, opts: FactListOpts | RecallFactReadOpts | undefined, recall: boolean): Row {
  const o = takeOptions(member, opts, recall ? RECALL_OPTIONS : LIST_OPTIONS) as RecallFactReadOpts;
  return {
    sourceId,
    activeOnly: o.activeOnly !== false,
    unconsolidatedOnly: o.unconsolidatedOnly === true,
    kinds: kindsOf(o.kinds),
    visibility: visibilityFilter(member, o.visibility),
    excludeAuditRows: o.excludeAuditRows === true,
    grep: grepPattern(o.grep),
    fingerprint: o.fingerprint === true,
    limit: clampSearchLimit(o.limit, 50, MAX_SEARCH_LIMIT),
    excludePrivate: factPolicy(member, o.excludePrivate),
    ...(recall ? {
      entitySlug: o.entitySlug ?? undefined,
      sourceMarkdownSlug: o.sourceMarkdownSlug ?? undefined,
      sessionId: o.sessionId || undefined,
    } : {}),
  };
}

export const insertFact: Member<'insertFact'> = (brain, input, ctx) => {
  if (input.claim_value != null && !Number.isFinite(input.claim_value)) refuseMember('insertFact', 'a non-finite claim_value');
  const confidence = input.confidence == null ? undefined : Number.isFinite(input.confidence) ? input.confidence : 2;
  const row = {
    fact: input.fact, kind: input.kind, entity_slug: input.entity_slug, visibility: input.visibility, context: input.context,
    valid_from: iso(input.valid_from ?? new Date()), valid_until: iso(input.valid_until), source: input.source,
    source_session: input.source_session, confidence, notability: input.notability, claim_metric: input.claim_metric,
    claim_value: input.claim_value, claim_unit: input.claim_unit, claim_period: input.claim_period,
    attributed_to: input.attributed_to,
    ...(input.embedding ? { embedding: vectorLiteral(input.embedding), embedding_model: input.embedding_model ?? undefined } : {}),
  };
  return storeCall({ member: 'insertFact' }, () =>
    brain.insertFact({ input: row, sourceId: ctx.source_id, supersedeId: ctx.supersedeId }));
};

export const insertFacts: Member<'insertFacts'> = async (brain, rows, ctx, opts) => {
  const o = takeOptions('insertFacts', opts, ['deleteForPageFirst']) as NonNullable<typeof opts>;
  if (rows.length === 0) return { inserted: 0, ids: [], warnings: [], deleted: 0 };
  const mapped = rows.map((input) => {
    if (input.row_num != null && !Number.isFinite(input.row_num)) refuseMember('insertFacts', 'a non-finite row_num');
    if (input.superseded_by_row !== undefined && !Number.isFinite(input.superseded_by_row)) {
      refuseMember('insertFacts', 'a non-finite superseded_by_row');
    }
    const confidence = input.confidence ?? 1.0;
    const ontology = input.dimension && input.value != null
      ? { dimension: wellFormed(input.dimension), value: wellFormed(input.value), value_hash: valueHash(input.value) }
      : {};
    return {
      fact: wellFormed(input.fact), kind: input.kind, entity_slug: wellFormed(input.entity_slug),
      visibility: input.visibility, notability: input.notability, context: wellFormed(input.context),
      valid_from: (input.valid_from ?? new Date()).toISOString(), valid_until: iso(input.valid_until),
      expired_at: iso(input.expired_at), source: wellFormed(input.source), source_session: wellFormed(input.source_session),
      ...(Number.isFinite(confidence) ? { confidence } : { confidence_null: true }),
      row_num: input.row_num, source_markdown_slug: wellFormed(input.source_markdown_slug),
      claim_metric: wellFormed(input.claim_metric),
      claim_value: input.claim_value != null && Number.isFinite(input.claim_value) ? input.claim_value : undefined,
      claim_unit: wellFormed(input.claim_unit), claim_period: wellFormed(input.claim_period),
      event_type: wellFormed(input.event_type), attributed_to: input.attributed_to,
      superseded_by_row: input.superseded_by_row,
      ...(input.embedding
        ? { embedding: vectorLiteral(input.embedding), embedding_model: wellFormed(input.embedding_model ?? null) ?? undefined }
        : {}),
      ...ontology,
    };
  });
  const del = o.deleteForPageFirst;
  return storeCall({ member: 'insertFacts' }, () => brain.insertFacts({
    rows: mapped,
    sourceId: ctx.source_id,
    deleteForPageFirst: del ? {
      slug: del.slug, sourceId: ctx.source_id, excludeSourcePrefixes: del.excludeSourcePrefixes ?? [],
      preserveExpiredLegacy: del.preserveExpiredLegacy === true,
    } : undefined,
  }));
};

export const deleteFactsForPage: Member<'deleteFactsForPage'> = async (brain, slug, sourceId, opts) => {
  const o = takeOptions('deleteFactsForPage', opts, ['excludeSourcePrefixes', 'preserveExpiredLegacy']) as NonNullable<typeof opts>;
  const deleted: number = await storeCall({ member: 'deleteFactsForPage' }, () => brain.deleteFactsForPage({
    slug, sourceId, excludeSourcePrefixes: o.excludeSourcePrefixes ?? [], preserveExpiredLegacy: o.preserveExpiredLegacy === true,
  }));
  return { deleted };
};

export const expireFact: Member<'expireFact'> = (brain, id, opts) => {
  const o = takeOptions('expireFact', opts, ['supersededBy', 'at', 'successorFrom']) as NonNullable<typeof opts>;
  return storeCall({ member: 'expireFact' }, () => brain.expireFact({
    id, supersededBy: o.supersededBy, at: iso(o.at ?? new Date()), successorFrom: iso(o.successorFrom),
  }));
};

export const listFactsByEntity: Member<'listFactsByEntity'> = async (brain, sourceId, entitySlug, opts) => {
  const q = listQuery('listFactsByEntity', sourceId, opts, false);
  const rows: Row[] = await storeCall({ member: 'listFactsByEntity' }, () => brain.listFactsByEntity({
    ...q, entitySlug, sessionId: opts?.sessionId || undefined, fingerprint: false,
    offset: offsetOf('listFactsByEntity', opts?.offset),
  }));
  return facts(rows);
};

export const listFactsSince: Member<'listFactsSince'> = async (brain, sourceId, since, opts) => {
  const q = listQuery('listFactsSince', sourceId, opts, true);
  const rows: Row[] = await storeCall({ member: 'listFactsSince' }, () => brain.listFactsSince({
    ...q, since: since.toISOString(), eventTime: opts?.eventTime === true, offset: offsetOf('listFactsSince', opts?.offset),
  }));
  return facts(rows);
};

const KEYSET_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;

export const listFactsKeyset: Member<'listFactsKeyset'> = async (brain, sourceId, after, opts) => {
  const q = listQuery('listFactsKeyset', sourceId, opts, true);
  if (after !== null && !KEYSET_TIME.test(after.createdAt)) refuseMember('listFactsKeyset', 'a keyset time in another text form');
  const rows: Row[] = await storeCall({ member: 'listFactsKeyset' }, () => brain.listFactsKeyset({
    ...q, kinds: undefined, unconsolidatedOnly: false,
    after: after === null ? undefined : { createdAt: after.createdAt, id: after.id },
  }));
  return facts(rows);
};

export const listFactsBySession: Member<'listFactsBySession'> = async (brain, sourceId, sessionId, opts) => {
  const q = listQuery('listFactsBySession', sourceId, opts, false);
  const rows: Row[] = await storeCall({ member: 'listFactsBySession' }, () => brain.listFactsBySession({
    ...q, sessionId, offset: offsetOf('listFactsBySession', opts?.offset),
  }));
  return facts(rows);
};

export const listSupersessions: Member<'listSupersessions'> = async (brain, sourceId, opts) => {
  const o = takeOptions('listSupersessions', opts, ['since', 'limit', 'visibility', 'excludePrivate', 'eligibility']) as NonNullable<typeof opts>;
  const rows: Row[] = await storeCall({ member: 'listSupersessions' }, () => brain.listSupersessions({
    sourceId, since: o.since ? o.since.toISOString() : undefined, limit: clampSearchLimit(o.limit, 50, MAX_SEARCH_LIMIT),
    visibility: visibilityFilter('listSupersessions', o.visibility),
    excludePrivate: factPolicy('listSupersessions', o.excludePrivate),
    // projectionEligibleSql('facts') (engine-sql/facts.ts eligibilityClause): any policy adds the quarantine clause.
    eligible: o.eligibility !== undefined,
    minTrust: o.eligibility?.floor || null,
    suppressFlagged: o.eligibility?.suppressFlagged === true,
  }));
  return facts(rows);
};

/**
 * `pageCollapseFacts` (engine-sql/search-reads.ts): the collapse-stage reads of each page in `ids`, by id (the SQL has
 * no ORDER BY). Both lists bind as `int[]`, so an id that is not a 32-bit integer refuses rather than guess at
 * PGLite's cast error.
 */
export const pageCollapseFacts: Member<'pageCollapseFacts'> = async (brain, ids, bodyIds) => {
  for (const id of [...ids, ...bodyIds]) {
    if (!Number.isInteger(id) || Math.abs(id) > 2 ** 31 - 1) refuseMember('pageCollapseFacts', 'a page id that is not a 32-bit integer');
  }
  if (ids.length === 0) return [];
  return storeCall({ member: 'pageCollapseFacts' }, () => brain.pageCollapseFacts(ids, bodyIds));
};

export const countUnconsolidatedFacts: Member<'countUnconsolidatedFacts'> = (brain, sourceId) =>
  storeCall({ member: 'countUnconsolidatedFacts' }, () => brain.countUnconsolidatedFacts(sourceId));

export const findCandidateDuplicates: Member<'findCandidateDuplicates'> = async (brain, sourceId, entitySlug, factText, opts) => {
  const o = takeOptions('findCandidateDuplicates', opts,
    ['k', 'embedding', 'embeddingModel', 'arm', 'attributedTo', 'excludeMemberPages', 'onlyPage']) as NonNullable<typeof opts>;
  const keyword = o.arm === 'keyword';
  if (o.embedding && !o.embeddingModel) return [];
  // The store's full-text search is the `english` configuration only.
  if (keyword && getFtsLanguage() !== 'english') refuseMember('findCandidateDuplicates', `the keyword arm in FTS language ${getFtsLanguage()}`);
  const rows: Row[] = await storeCall({ member: 'findCandidateDuplicates' }, () => brain.findCandidateDuplicates({
    sourceId, entitySlug, k: Math.min(Math.max(o.k ?? 5, 1), 20), attributedTo: o.attributedTo || undefined,
    onlyPage: o.onlyPage || undefined, excludeMemberPages: o.excludeMemberPages === true,
    ...(keyword ? { keyword: true, factText: wellFormed(factText) } : {}),
    ...(o.embedding ? { embedding: vectorLiteral(o.embedding), embeddingModel: o.embeddingModel } : {}),
  }));
  return facts(rows);
};

export const consolidateFact: Member<'consolidateFact'> = async (brain, id, takeId) => {
  await storeCall({ member: 'consolidateFact' }, () => brain.consolidateFact(id, takeId));
};

const TRAJECTORY_NATIVE_PAGE = 500;

export const findTrajectory: Member<'findTrajectory'> = async (brain, opts) => {
  const o = takeOptions('findTrajectory', opts,
    ['entitySlug', 'sourceId', 'sourceIds', 'remote', 'metric', 'kind', 'since', 'until', 'limit', 'excludePrivate']) as unknown as typeof opts;
  const worldOnly = opts.remote !== false;
  if (worldOnly && factVisibilitySql('facts', ['world']) !== "facts.visibility IN ('world')") {
    refuseMember('findTrajectory', 'visibility widened by member pages or grants');
  }
  const sourceIds = Array.isArray(o.sourceIds) && o.sourceIds.length > 0 ? [...new Set(o.sourceIds)] : [o.sourceId ?? 'default'];
  const limit = clampSearchLimit(o.limit, 100, 500);
  const read = (until: string | undefined): Promise<Row[]> => storeCall({ member: 'findTrajectory' }, () => brain.findTrajectory({
    sourceIds, entitySlug: o.entitySlug, worldOnly, metric: o.metric ?? undefined, kind: o.kind ?? 'all',
    since: o.since ? new Date(o.since).toISOString() : undefined, until,
    limit: TRAJECTORY_NATIVE_PAGE,
    excludePrivate: factPolicy('findTrajectory', o.excludePrivate),
  }));
  // Lane 3 P1: profile.<facet> claims are never trajectory points (engine-sql/facts.ts filters them in SQL). The native read
  // has no metric filter and returns the newest rows in date order, so it is paged back in time (until: the oldest row read,
  // whose ties the next read repeats) until `limit` other rows are found or history ends; the page is the last `limit` of them.
  const seen = new Set<unknown>();
  let points: Row[] = [];
  let until = o.until ? new Date(o.until).toISOString() : undefined;
  for (let first = true; ; first = false) {
    const rows = await read(until);
    const fresh = first ? rows : rows.filter((row) => !seen.has(row.fact_id));
    for (const row of fresh) seen.add(row.fact_id);
    points = [...fresh.filter((row) => facetOfMetric(row.metric as string | null) === null), ...points];
    if (rows.length < TRAJECTORY_NATIVE_PAGE || points.length >= limit || fresh.length === 0) break;
    until = String(rows[0]!.valid_from);
  }
  return points.slice(Math.max(0, points.length - limit))
    .map((row) => withDates(withVector(row), ['valid_from', 'valid_until']) as unknown as TrajectoryPoint);
};

export const getFactsHealth: Member<'getFactsHealth'> = (brain, sourceId) =>
  storeCall({ member: 'getFactsHealth' }, () => brain.getFactsHealth(sourceId));

export const migrateFactsToCanonical: Member<'migrateFactsToCanonical'> = async (brain, phantomSlug, canonicalSlug, sourceId) => {
  const migrated: number = await storeCall({ member: 'migrateFactsToCanonical' }, () =>
    brain.migrateFactsToCanonical(phantomSlug, canonicalSlug, sourceId));
  return { migrated };
};
