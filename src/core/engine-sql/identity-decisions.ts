/**
 * The owner's identity decisions (`BrainEngine.listIdentityDecisions` / `applyIdentityDecisions`, migration v325): "same
 * person" and "different people" verdicts on a group of pages, kept by (source_id, slug), and the entity_identities rows
 * a "same" decision materializes (established_by 'dedupe:confirm'). One implementation for both engines; the write runs
 * inside the engine's transaction, so the decision rows and the identity rows change together or not at all.
 *
 * Materializing: every member page that exists (live) and belongs to no identity group gets a row in the decision's
 * entity_id; the decision's canonical member is the group's canonical unless the group already has one. A
 * 'dedupe:confirm' row with no "same" decision behind it (the decision was removed or turned into "different") is
 * deleted. Rows any other actor wrote (a hand link) are never touched. A member whose page is missing, or sits in
 * another group, is pending: listIdentityDecisions names it, and the next apply retries it.
 *
 * The company sweep's links ('dedupe:auto', core/entities/company-auto-link.ts) are written here too, so they change in the
 * same locked transaction as the decisions they depend on. A planned automatic group is written only when every member
 * page still exists at the generation the sweep read and sits in no other group; otherwise it is skipped and the next
 * sweep plans it again. Every apply also removes the automatic groups a decision now covers (a member of a "same"
 * decision, whose confirm takes over, or two members of one "different" decision) and any left with one member, no canonical member or a deleted member.
 *
 * Every apply takes one transaction-scoped advisory lock on Postgres, so applies run one at a time; an apply given the
 * revision of the rows its caller read writes nothing when they changed since (a projection planned from an older read).
 */
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

export interface IdentityMemberRef { source_id: string; slug: string }
export type IdentityVerdict = 'same' | 'different';

export interface IdentityDecision {
  /** 16 hex characters of sha256 over the sorted "source_id<TAB>slug" member lines. */
  decision_id: string;
  verdict: IdentityVerdict;
  /** Sorted by (source_id, slug). */
  members: IdentityMemberRef[];
  /** The preview group id the owner decided on, when it came from one. */
  group_id: string | null;
  /** The identity group a "same" decision materializes into; null for "different". */
  entity_id: string | null;
  canonical: IdentityMemberRef | null;
  decided_by: string;
  decided_at: string;
  /** 'git': projected from .gbrain/identity/<decision_id>.md in home_source_id; 'database': the row is the record. */
  origin: 'database' | 'git';
  home_source_id: string | null;
  git_blob: string | null;
  /** On a "different" decision: each member's fingerprint (pageFingerprint) when it was recorded; null when none was kept. */
  evidence: string[] | null;
}

/** page_missing: no live page; unlinked: the page exists and sits in no group (the next apply links it); other_group: it sits in another group. */
export interface PendingIdentityMember extends IdentityMemberRef { decision_id: string; reason: 'page_missing' | 'unlinked' | 'other_group' }

/** revision: decisionsRevision of the rows read, for an apply that must not overwrite a newer change (expectRevision). */
export interface IdentityDecisionsRead { decisions: IdentityDecision[]; pending: PendingIdentityMember[]; revision: string }

export interface ApplyIdentityDecisionsInput {
  /** Decisions written as given (decided_at defaults to now). */
  upsert?: Array<Omit<IdentityDecision, 'decided_at' | 'evidence'> & { decided_at?: string; evidence?: string[] | null }>;
  /** Decision ids removed. */
  remove?: string[];
  /** decisionsRevision of the rows the caller read; when the rows changed since, nothing is written and the result is stale. */
  expectRevision?: string;
  /** The company sweep's plan: automatic groups to write, and automatic groups (by entity_id) to remove first. */
  auto?: { link: AutoLinkGroup[]; unlink: string[] };
}

export interface AutoLinkGroup {
  entity_id: string;
  canonical_page_id: number;
  members: Array<{ source_id: string; page_id: number; generation: number }>;
}

export interface ApplyIdentityDecisionsResult {
  upserted: number; removed: number; linked: number; unlinked: number; stale?: true;
  /** Automatic groups written, removed, and skipped because a member changed or joined another group since the sweep read it. */
  auto?: { linked: number; unlinked: number; skipped: number };
}

/** A revision of the decision rows: every row's id, verdict, entity, origin and blob, in id order. */
function decisionsRevision(decisions: ReadonlyArray<Pick<IdentityDecision, 'decision_id' | 'verdict' | 'entity_id' | 'origin' | 'git_blob'>>): string {
  return [...decisions].sort((a, b) => (a.decision_id < b.decision_id ? -1 : a.decision_id > b.decision_id ? 1 : 0))
    .map(d => [d.decision_id, d.verdict, d.entity_id ?? '', d.origin, d.git_blob ?? ''].join(':')).join(',');
}

interface DecisionRow {
  decision_id: string; verdict: IdentityVerdict; members: unknown; group_id: string | null; entity_id: string | null;
  canonical_source_id: string | null; canonical_slug: string | null; decided_by: string; decided_at: string | Date;
  origin: 'database' | 'git'; home_source_id: string | null; git_blob: string | null; evidence: unknown;
}

const MEMBER_PAGES = `entity_identity_reviews r
  CROSS JOIN LATERAL jsonb_array_elements(r.members) m(member)
  LEFT JOIN pages p ON p.source_id = m.member->>'source_id' AND p.slug = m.member->>'slug' AND p.deleted_at IS NULL`;

export async function listIdentityDecisions(exec: LegacyUnscopedRead): Promise<IdentityDecisionsRead> {
  const { rows } = await exec.run<DecisionRow>(sqlFragment`
    SELECT decision_id, verdict, members, group_id, entity_id, canonical_source_id, canonical_slug, decided_by,
           decided_at::text AS decided_at, origin, home_source_id, git_blob, evidence
      FROM entity_identity_reviews
     ORDER BY decision_id`);
  const { rows: pending } = await exec.query<PendingIdentityMember>(`
    SELECT r.decision_id, m.member->>'source_id' AS source_id, m.member->>'slug' AS slug,
           CASE WHEN p.id IS NULL THEN 'page_missing' WHEN x.entity_id IS NULL THEN 'unlinked' ELSE 'other_group' END AS reason
      FROM ${MEMBER_PAGES}
      LEFT JOIN entity_identities x ON x.source_id = p.source_id AND x.page_id = p.id
     WHERE r.verdict = 'same' AND (p.id IS NULL OR x.entity_id IS DISTINCT FROM r.entity_id)
     ORDER BY r.decision_id, 2, 3`);
  return {
    decisions: rows.map(r => ({
      decision_id: r.decision_id, verdict: r.verdict,
      members: (typeof r.members === 'string' ? JSON.parse(r.members) : r.members) as IdentityMemberRef[],
      group_id: r.group_id, entity_id: r.entity_id,
      canonical: r.canonical_source_id && r.canonical_slug ? { source_id: r.canonical_source_id, slug: r.canonical_slug } : null,
      decided_by: r.decided_by, decided_at: String(r.decided_at), origin: r.origin, home_source_id: r.home_source_id, git_blob: r.git_blob,
      evidence: (typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence ?? null) as string[] | null,
    })),
    pending: pending.map(p => ({ decision_id: p.decision_id, source_id: p.source_id, slug: p.slug, reason: p.reason })),
    revision: decisionsRevision(rows),
  };
}

/** The members whose page names readers, sits under a folder rule or carries a private label: not every reader may read them. */
export async function listRestrictedIdentityMembers(exec: LegacyUnscopedRead, members: ReadonlyArray<IdentityMemberRef>): Promise<IdentityMemberRef[]> {
  if (!members.length) return [];
  const { rows } = await exec.run<IdentityMemberRef>(sqlFragment`
    SELECT p.source_id, p.slug FROM pages p
      JOIN unnest(${members.map(m => m.source_id)}::text[], ${members.map(m => m.slug)}::text[]) AS t(source_id, slug) ON p.source_id = t.source_id AND p.slug = t.slug
     WHERE NOT ${trustedSql(privatePagesFilterFragment('p'))}`);
  return rows;
}

/** Writes and removes decisions, then reconciles the 'dedupe:confirm' identity rows; the engine runs it in one transaction. */
export async function applyIdentityDecisions(exec: SqlExecutor, input: ApplyIdentityDecisionsInput): Promise<ApplyIdentityDecisionsResult> {
  if (exec.capabilities.transactionAdvisoryLocks) await exec.run(sqlFragment`SELECT pg_advisory_xact_lock(hashtextextended('gbrain:identity-decisions', 0))`);
  if (input.expectRevision !== undefined) {
    const { rows } = await exec.run<Pick<IdentityDecision, 'decision_id' | 'verdict' | 'entity_id' | 'origin' | 'git_blob'>>(sqlFragment`
      SELECT decision_id, verdict, entity_id, origin, git_blob FROM entity_identity_reviews`);
    if (decisionsRevision(rows) !== input.expectRevision) return { upserted: 0, removed: 0, linked: 0, unlinked: 0, stale: true };
  }
  let removed = 0;
  if (input.remove?.length) {
    removed = (await exec.run(sqlFragment`DELETE FROM entity_identity_reviews WHERE decision_id = ANY(${input.remove}::text[]) RETURNING 1`)).rows.length;
  }
  for (const d of input.upsert ?? []) {
    await exec.run(sqlFragment`
      INSERT INTO entity_identity_reviews (decision_id, verdict, members, group_id, entity_id, canonical_source_id, canonical_slug,
                                           decided_by, decided_at, origin, home_source_id, git_blob, evidence)
      VALUES (${d.decision_id}, ${d.verdict}, ${jsonbParam(d.members)}, ${d.group_id}, ${d.entity_id}, ${d.canonical?.source_id ?? null},
              ${d.canonical?.slug ?? null}, ${d.decided_by}, COALESCE(${d.decided_at ?? null}::timestamptz, now()), ${d.origin},
              ${d.home_source_id}, ${d.git_blob}, ${d.evidence?.length ? jsonbParam(d.evidence) : null})
      ON CONFLICT (decision_id) DO UPDATE SET
        verdict = EXCLUDED.verdict, members = EXCLUDED.members, group_id = EXCLUDED.group_id, entity_id = EXCLUDED.entity_id,
        canonical_source_id = EXCLUDED.canonical_source_id, canonical_slug = EXCLUDED.canonical_slug,
        decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at, origin = EXCLUDED.origin,
        home_source_id = EXCLUDED.home_source_id, git_blob = EXCLUDED.git_blob, evidence = EXCLUDED.evidence`);
  }
  let autoUnlinked = input.auto?.unlink.length
    ? Number((await exec.run<{ n: number | string }>(sqlFragment`
        WITH gone AS (DELETE FROM entity_identities WHERE established_by = 'dedupe:auto' AND entity_id = ANY(${input.auto.unlink}::text[]) RETURNING entity_id)
        SELECT count(DISTINCT entity_id) AS n FROM gone`)).rows[0]?.n ?? 0) : 0;
  autoUnlinked += Number((await exec.query<{ n: number | string }>(`
    WITH gone AS (DELETE FROM entity_identities ei
     WHERE ei.established_by = 'dedupe:auto'
       AND ei.entity_id IN (
         SELECT a.entity_id FROM entity_identities a JOIN pages p ON p.id = a.page_id
           JOIN entity_identity_reviews r ON r.verdict = 'same'
            AND r.members @> jsonb_build_array(jsonb_build_object('source_id', p.source_id, 'slug', p.slug))
          WHERE a.established_by = 'dedupe:auto'
         UNION
         SELECT a.entity_id FROM entity_identities a JOIN pages p ON p.id = a.page_id
           JOIN entity_identities b ON b.entity_id = a.entity_id AND b.page_id <> a.page_id
           JOIN pages pb ON pb.id = b.page_id
           JOIN entity_identity_reviews r ON r.verdict = 'different'
            AND r.members @> jsonb_build_array(jsonb_build_object('source_id', p.source_id, 'slug', p.slug))
            AND r.members @> jsonb_build_array(jsonb_build_object('source_id', pb.source_id, 'slug', pb.slug))
          WHERE a.established_by = 'dedupe:auto')
     RETURNING ei.entity_id)
    SELECT count(DISTINCT entity_id) AS n FROM gone`)).rows[0]?.n ?? 0);
  const plan = input.auto?.link.flatMap(g => g.members.map(m => ({ ...m, entity_id: g.entity_id, canonical_page_id: g.canonical_page_id }))) ?? [];
  let autoLinked = 0, autoSkipped = 0;
  if (plan.length) {
    const { rows: counts } = await exec.run<{ planned: number | string; ok: number | string; linked: number | string }>(sqlFragment`
      WITH plan AS (
        SELECT * FROM unnest(${plan.map(m => m.entity_id)}::text[], ${plan.map(m => m.source_id)}::text[], ${plan.map(m => m.page_id)}::int[],
                             ${plan.map(m => m.generation)}::bigint[], ${plan.map(m => m.canonical_page_id)}::int[]) AS m(entity_id, source_id, page_id, generation, canonical_page_id)),
      ok AS (
        SELECT pl.entity_id FROM plan pl
          LEFT JOIN pages p ON p.id = pl.page_id AND p.source_id = pl.source_id AND p.generation = pl.generation AND p.deleted_at IS NULL
          LEFT JOIN entity_identities x ON x.source_id = pl.source_id AND x.page_id = pl.page_id AND x.entity_id <> pl.entity_id
         GROUP BY pl.entity_id
        HAVING count(p.id) = count(*) AND count(x.id) = 0),
      ins AS (
        INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
        SELECT pl.entity_id, pl.source_id, pl.page_id, 1.0, 'dedupe:auto', pl.page_id = pl.canonical_page_id FROM plan pl JOIN ok ON ok.entity_id = pl.entity_id
        ON CONFLICT (source_id, page_id) DO NOTHING
        RETURNING entity_id)
      SELECT (SELECT count(DISTINCT entity_id) FROM plan) AS planned, (SELECT count(*) FROM ok) AS ok, (SELECT count(DISTINCT entity_id) FROM ins) AS linked`);
    autoLinked = Number(counts[0]?.linked ?? 0);
    autoSkipped = Number(counts[0]?.planned ?? 0) - Number(counts[0]?.ok ?? 0);
  }
  autoUnlinked += Number((await exec.query<{ n: number | string }>(`
    WITH gone AS (DELETE FROM entity_identities ei
     WHERE ei.established_by = 'dedupe:auto'
       AND ei.entity_id IN (
         SELECT o.entity_id FROM entity_identities o LEFT JOIN pages p ON p.id = o.page_id
          WHERE o.established_by = 'dedupe:auto'
          GROUP BY o.entity_id
         HAVING count(*) < 2 OR NOT bool_or(o.canonical) OR bool_or(p.id IS NULL OR p.deleted_at IS NOT NULL))
     RETURNING ei.entity_id)
    SELECT count(DISTINCT entity_id) AS n FROM gone`)).rows[0]?.n ?? 0);
  const unlinked = (await exec.query(`
    DELETE FROM entity_identities ei
     WHERE ei.established_by = 'dedupe:confirm'
       AND NOT EXISTS (
         SELECT 1 FROM ${MEMBER_PAGES}
          WHERE r.verdict = 'same' AND r.entity_id = ei.entity_id AND p.id = ei.page_id AND p.source_id = ei.source_id)
    RETURNING 1`)).rows.length;
  const linked = (await exec.query(`
    INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
    SELECT m.entity_id, m.source_id, m.page_id, 1.0, 'dedupe:confirm',
           m.is_canonical AND m.rn = 1 AND NOT EXISTS (SELECT 1 FROM entity_identities c WHERE c.entity_id = m.entity_id AND c.canonical)
      FROM (SELECT r.entity_id, p.source_id, p.id AS page_id,
                   COALESCE(p.source_id = r.canonical_source_id AND p.slug = r.canonical_slug, false) AS is_canonical,
                   row_number() OVER (PARTITION BY r.entity_id
                     ORDER BY COALESCE(p.source_id = r.canonical_source_id AND p.slug = r.canonical_slug, false) DESC,
                              r.decision_id, p.source_id, p.id) AS rn
              FROM ${MEMBER_PAGES}
             WHERE r.verdict = 'same' AND r.entity_id IS NOT NULL AND p.id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM entity_identities x WHERE x.source_id = p.source_id AND x.page_id = p.id)) m
    ON CONFLICT (source_id, page_id) DO NOTHING
    RETURNING 1`)).rows.length;
  await exec.query(`
    UPDATE entity_identities ei SET canonical = true
      FROM (SELECT DISTINCT ON (r.entity_id) r.entity_id, p.source_id, p.id AS page_id
              FROM ${MEMBER_PAGES}
             WHERE r.verdict = 'same' AND r.entity_id IS NOT NULL AND p.id IS NOT NULL
               AND p.source_id = r.canonical_source_id AND p.slug = r.canonical_slug
             ORDER BY r.entity_id, r.decision_id) c
     WHERE ei.entity_id = c.entity_id AND ei.source_id = c.source_id AND ei.page_id = c.page_id
       AND NOT EXISTS (SELECT 1 FROM entity_identities x WHERE x.entity_id = c.entity_id AND x.canonical)`);
  return { upserted: input.upsert?.length ?? 0, removed, linked, unlinked, ...(input.auto ? { auto: { linked: autoLinked, unlinked: autoUnlinked, skipped: autoSkipped } } : {}) };
}
