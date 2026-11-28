/**
 * The belief-ledger half of a purge (src/core/belief/purge.ts, belief/preimages.ts): the reads and writes a fact purge
 * (facts/purge.ts), a page purge (persistence/page-purge.ts) and the restore replay (belief/purge-mirror.ts) run on a
 * source that records belief events. One SQL implementation for both engines. Each statement is the text its caller ran
 * through executeRaw, byte for byte and with the same parameters (test/belief-purge-ledger-sql-pin.test.ts), so PGLite
 * and Postgres answer exactly as before; the matching of claims, the marker and the hashes stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { REDACT_PURGED_KEYS_LEGACY_SQL } from '../belief/legacy-fingerprint.ts';

/** `redactPurgedBeliefKeys`' argument. `legacyClaims`: the purged claims that may have a pre-v353 fingerprint. */
export interface RedactPurgedKeysInput { sourceId: string; claimFps: readonly string[]; lifetimes: readonly string[]; legacyClaims: readonly string[] }
/** One event `listBeliefCarrierEvents` answers: its carrying fields as text (`value->>'context'`, `value->>'resolved_source'`). */
export interface BeliefCarrierEvent { id: number; subject_kind: string; subject_key: string; context: string | null; resolved_source: string | null }
/** `readBeliefEventValue`'s answer. */
export interface BeliefEventValue { value: unknown; value_hash: string | null; redacted_fields: string[] | null }
/** `rewriteBeliefEventFields`' argument: the event's new value (canonical JSON text), its hash and the redacted field list. */
export interface BeliefEventRewrite { sourceId: string; id: number; value: string; valueHash: string; redactedFields: readonly string[] }
/** `rechainBeliefPriorHash`' argument: the subject's later events chained to `oldHash` take `newHash`. */
export interface BeliefPriorRechain { sourceId: string; subjectKey: string; oldHash: string; newHash: string; afterId: number }
/** The live rows whose carrying field `listBeliefQuotingRows` reads: a fact's context, a take's resolution source, a link's context. */
export type BeliefQuotingKind = 'facts' | 'takes' | 'links';
/** One `listBeliefQuotingRows` row: the row id, its stream slug (null when it has none) and the field's text. */
export interface BeliefQuotingRow { id: number; slug: string | null; text: string }
/** One retained version `listPurgeCarrierVersions` answers, with whether its page passes the no-caller page policy. */
export interface PurgeCarrierVersion { page_id: number; slug: string; visible: boolean; compiled_truth: string | null; timeline: string | null }

/** The stream slug of each derived row: `facts:<id>`, `takes:<id>` and `pages:<id>` refs of the source. No set order. */
export async function listDerivedStreamSlugs(exec: LegacyUnscopedRead, sourceId: string, factIds: readonly number[], takeIds: readonly number[],
  pageIds: readonly number[]): Promise<Array<{ ref: string; slug: string }>> {
  return exec.executeRaw<{ ref: string; slug: string }>(`SELECT 'facts:' || id AS ref, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts
      WHERE source_id = $1 AND id = ANY($2::bigint[]) AND COALESCE(source_markdown_slug, entity_slug) IS NOT NULL
    UNION ALL SELECT 'takes:' || k.id, p.slug FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.source_id = $1 AND k.id = ANY($3::bigint[])
    UNION ALL SELECT 'pages:' || id, slug FROM pages WHERE source_id = $1 AND id = ANY($4::int[])`, [sourceId, [...factIds], [...takeIds], [...pageIds]]);
}

/** The 1-based positions of the (page, revision) pairs that no version of the page holds. No set order. */
export async function listMissingPreimages(exec: LegacyUnscopedRead, pageIds: readonly number[], revisions: readonly string[]): Promise<number[]> {
  const rows = await exec.executeRaw<{ i: number }>(`SELECT n.i FROM unnest($1::bigint[], $2::uuid[]) WITH ORDINALITY AS n(page_id, revision, i)
    WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = n.page_id AND v.knowledge_revision = n.revision)`,
  [[...pageIds], [...revisions]]);
  return rows.map(r => Number(r.i));
}

const REDACT_PURGED_KEYS_SQL = `UPDATE belief_events SET value = NULL, value_hash = NULL, prior_hash = NULL, purged = true
    WHERE source_id = $1 AND ((subject_kind IN ('fact','take') AND (claim_fp = ANY($2::text[])))
        OR page_lifetime = ANY($3::uuid[]))
      AND (purged = false OR value IS NOT NULL OR prior_hash IS NOT NULL) RETURNING id`;

/**
 * Clears the recorded value of the source's fact and take events with one of the fingerprints, and of every event of
 * the lifetimes, unless already cleared; with `legacyClaims`, also of the fact and take events recorded under such a
 * claim's pre-v353 fingerprint. Answers how many events it marked. Write.
 */
export async function redactPurgedBeliefKeys(exec: SqlExecutor, input: RedactPurgedKeysInput): Promise<number> {
  const params: unknown[] = [input.sourceId, [...input.claimFps], [...input.lifetimes]];
  if (input.legacyClaims.length) params.push([...input.legacyClaims]);
  const rows = await exec.executeRaw(input.legacyClaims.length ? REDACT_PURGED_KEYS_LEGACY_SQL : REDACT_PURGED_KEYS_SQL, params);
  return rows.length;
}

/** The next 1000 fact, take and link events of the source after `after` with a non-empty context or resolution source, in id order. */
export async function listBeliefCarrierEvents(exec: LegacyUnscopedRead, sourceId: string, after: number): Promise<BeliefCarrierEvent[]> {
  return exec.executeRaw<BeliefCarrierEvent>(`SELECT e.id,
        e.subject_kind, e.subject_key, e.value->>'context' AS context, e.value->>'resolved_source' AS resolved_source FROM belief_events e
      WHERE e.source_id = $1 AND e.id > $2 AND e.subject_kind IN ('fact','take','link')
        AND (COALESCE(e.value->>'context', '') <> '' OR COALESCE(e.value->>'resolved_source', '') <> '')
      ORDER BY e.id LIMIT 1000`, [sourceId, after]);
}

/** One event's value, value hash and redacted fields, or null. `sourceId` names the event's source; the statement reads by id. */
export async function readBeliefEventValue(exec: LegacyUnscopedRead, _sourceId: string, id: number): Promise<BeliefEventValue | null> {
  const [row] = await exec.executeRaw<BeliefEventValue>('SELECT value, value_hash, redacted_fields FROM belief_events WHERE id = $1', [id]);
  return row ?? null;
}

/**
 * Rewrites one event's value, value hash and redacted fields; its prior hash stays only while an earlier event of the
 * same source and subject still has that value hash. `sourceId` names the event's source; the statement writes by id. Write.
 */
export async function rewriteBeliefEventFields(exec: SqlExecutor, input: BeliefEventRewrite): Promise<void> {
  await exec.executeRaw(`UPDATE belief_events e SET value = $2::text::jsonb, value_hash = $3, redacted_fields = $4::text[],
          prior_hash = CASE WHEN EXISTS (SELECT 1 FROM belief_events o WHERE o.source_id = e.source_id AND o.subject_key = e.subject_key AND o.id < e.id
            AND o.value_hash = e.prior_hash) THEN e.prior_hash END WHERE e.id = $1`, [input.id, input.value, input.valueHash, [...input.redactedFields]]);
}

/** The subject's events after `afterId` whose prior hash is `oldHash` take `newHash`. Write. */
export async function rechainBeliefPriorHash(exec: SqlExecutor, input: BeliefPriorRechain): Promise<void> {
  await exec.executeRaw('UPDATE belief_events SET prior_hash = $4 WHERE source_id = $1 AND subject_key = $2 AND id > $5 AND prior_hash = $3',
    [input.sourceId, input.subjectKey, input.oldHash, input.newHash, input.afterId]);
}

const QUOTING_SQL = {
  facts: `SELECT f.id, COALESCE(f.source_markdown_slug, f.entity_slug) AS slug, f.context AS text FROM facts f
    WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL AND COALESCE(f.context, '') <> '' ORDER BY 1 LIMIT 1000`,
  takes: `SELECT k.id, p.slug, k.resolved_source AS text FROM takes k JOIN pages p ON p.id = k.page_id
    WHERE p.source_id = $1 AND k.id > $2 AND COALESCE(k.resolved_source, '') <> '' ORDER BY 1 LIMIT 1000`,
  links: `SELECT l.id, COALESCE(o.slug, f.slug) AS slug, l.context AS text FROM links l JOIN pages f ON f.id = l.from_page_id
    LEFT JOIN pages o ON o.id = l.origin_page_id WHERE COALESCE(o.source_id, f.source_id) = $1 AND l.id > $2 AND l.context <> '' ORDER BY 1 LIMIT 1000`,
} as const;

/**
 * The next 1000 live rows of the source after `after`, in id order, whose carrying field is not empty: unexpired facts
 * with a context, takes with a resolution source (the take's page in the source), links with a context (the origin
 * page's source, else the from page's).
 */
export async function listBeliefQuotingRows(exec: LegacyUnscopedRead, kind: BeliefQuotingKind, sourceId: string, after: number): Promise<BeliefQuotingRow[]> {
  return exec.executeRaw<BeliefQuotingRow>(QUOTING_SQL[kind], [sourceId, after]);
}

/** The page's lifetimes: the open one at the slug with no page hint, and every one whose page hint is the page. No set order. */
export async function listPageBeliefLifetimes(exec: LegacyUnscopedRead, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await exec.executeRaw<{ page_lifetime: string }>(`SELECT page_lifetime::text AS page_lifetime FROM belief_page_lifetimes
    WHERE source_id = $1 AND (page_id = $3 OR (slug = $2 AND ended_at IS NULL AND page_id IS NULL))`, [sourceId, slug, pageId]);
  return rows.map(r => r.page_lifetime);
}

/** Each distinct claim of the page's facts (by fence page) and takes, with its fingerprint. No set order. */
export async function listPagePurgeLiveClaims(exec: LegacyUnscopedRead, sourceId: string, slug: string, pageId: number): Promise<Array<{ claim: string; fp: string }>> {
  return exec.executeRaw<{ claim: string; fp: string }>(`SELECT fact AS claim, gbrain_fact_fingerprint(fact) AS fp FROM facts WHERE source_id = $1 AND source_markdown_slug = $2
    UNION SELECT claim, gbrain_fact_fingerprint(claim) FROM takes WHERE page_id = $3`, [sourceId, slug, pageId]);
}

/** The next 1000 versions of the page after `after`, in id order: id, compiled_truth and timeline. */
export async function listPageVersionFenceBodies(exec: LegacyUnscopedRead, pageId: number, after: number): Promise<Array<{ id: number; compiled_truth: string; timeline: string | null }>> {
  return exec.executeRaw<{ id: number; compiled_truth: string; timeline: string | null }>(`SELECT id, compiled_truth, timeline FROM page_versions
      WHERE page_id = $1 AND id > $2 ORDER BY id LIMIT 1000`, [pageId, after]);
}

/**
 * The next 1000 fact and take events of the lifetimes after `after`, in id order: id, recorded claim (`fact`, else
 * `claim`) and fingerprint. `sourceId` names the lifetimes' source; the statement reads by lifetime.
 */
export async function listLifetimeClaimEvents(exec: LegacyUnscopedRead, _sourceId: string, lifetimes: readonly string[], after: number): Promise<Array<{ id: number; claim: string | null; claim_fp: string | null }>> {
  return exec.executeRaw<{ id: number; claim: string | null; claim_fp: string | null }>(`SELECT id, COALESCE(value->>'fact', value->>'claim') AS claim, claim_fp
      FROM belief_events WHERE page_lifetime = ANY($1::uuid[]) AND subject_kind IN ('fact','take') AND id > $2 ORDER BY id LIMIT 1000`, [[...lifetimes], after]);
}

/** The versions of the source among `versionIds`, in id order, with their page, its slug and whether it passes the no-caller page policy. */
export async function listPurgeCarrierVersions(exec: LegacyUnscopedRead, sourceId: string, versionIds: readonly number[]): Promise<PurgeCarrierVersion[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id AS page_id, p.slug,
        (${trustedSql(privatePagesFilterFragment('p'))}) AS visible, v.compiled_truth, v.timeline
      FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = ${sourceId} AND v.id = ANY(${[...versionIds]}::bigint[]) ORDER BY v.id`);
  return exec.executeRaw<PurgeCarrierVersion>(text, params);
}

/** The subject keys among `keys` that have an event in the source. No set order. */
export async function listKnownBeliefSubjectKeys(exec: LegacyUnscopedRead, sourceId: string, keys: readonly string[]): Promise<string[]> {
  const rows = await exec.executeRaw<{ subject_key: string }>(`SELECT DISTINCT subject_key FROM belief_events WHERE source_id = $1 AND subject_key = ANY($2::text[])`,
    [sourceId, [...keys]]);
  return rows.map(r => r.subject_key);
}
