/**
 * The owner's identity decisions (`BrainEngine.listIdentityDecisions` / `applyIdentityDecisions`, migration v323): "same
 * person" and "different people" verdicts on a group of pages, kept by (source_id, slug), and the entity_identities rows
 * a "same" decision materializes (established_by 'dedupe:confirm'). One implementation for both engines; the write runs
 * inside the engine's transaction, so the decision rows and the identity rows change together or not at all.
 *
 * Materializing: every member page that exists (live) and belongs to no identity group gets a row in the decision's
 * entity_id; the decision's canonical member is the group's canonical unless the group already has one. A
 * 'dedupe:confirm' row with no "same" decision behind it (the decision was removed or turned into "different") is
 * deleted. Rows any other actor wrote (a hand link) are never touched. A member whose page is missing, or sits in
 * another group, is pending: listIdentityDecisions names it, and the next apply retries it.
 */
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment } from './fragment.ts';

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
}

export interface PendingIdentityMember extends IdentityMemberRef { decision_id: string; reason: 'page_missing' | 'other_group' }

export interface IdentityDecisionsRead { decisions: IdentityDecision[]; pending: PendingIdentityMember[] }

export interface ApplyIdentityDecisionsInput {
  /** Decisions written as given (decided_at defaults to now). */
  upsert?: Array<Omit<IdentityDecision, 'decided_at'> & { decided_at?: string }>;
  /** Decision ids removed. */
  remove?: string[];
}

export interface ApplyIdentityDecisionsResult { upserted: number; removed: number; linked: number; unlinked: number }

interface DecisionRow {
  decision_id: string; verdict: IdentityVerdict; members: unknown; group_id: string | null; entity_id: string | null;
  canonical_source_id: string | null; canonical_slug: string | null; decided_by: string; decided_at: string | Date;
  origin: 'database' | 'git'; home_source_id: string | null; git_blob: string | null;
}

const MEMBER_PAGES = `entity_identity_reviews r
  CROSS JOIN LATERAL jsonb_array_elements(r.members) m(member)
  LEFT JOIN pages p ON p.source_id = m.member->>'source_id' AND p.slug = m.member->>'slug' AND p.deleted_at IS NULL`;

export async function listIdentityDecisions(exec: LegacyUnscopedRead): Promise<IdentityDecisionsRead> {
  const { rows } = await exec.run<DecisionRow>(sqlFragment`
    SELECT decision_id, verdict, members, group_id, entity_id, canonical_source_id, canonical_slug, decided_by,
           decided_at::text AS decided_at, origin, home_source_id, git_blob
      FROM entity_identity_reviews
     ORDER BY decision_id`);
  const { rows: pending } = await exec.query<PendingIdentityMember>(`
    SELECT r.decision_id, m.member->>'source_id' AS source_id, m.member->>'slug' AS slug,
           CASE WHEN p.id IS NULL THEN 'page_missing' ELSE 'other_group' END AS reason
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
    })),
    pending: pending.map(p => ({ decision_id: p.decision_id, source_id: p.source_id, slug: p.slug, reason: p.reason })),
  };
}

/** Writes and removes decisions, then reconciles the 'dedupe:confirm' identity rows; the engine runs it in one transaction. */
export async function applyIdentityDecisions(exec: SqlExecutor, input: ApplyIdentityDecisionsInput): Promise<ApplyIdentityDecisionsResult> {
  let removed = 0;
  if (input.remove?.length) {
    removed = (await exec.run(sqlFragment`DELETE FROM entity_identity_reviews WHERE decision_id = ANY(${input.remove}::text[]) RETURNING 1`)).rows.length;
  }
  for (const d of input.upsert ?? []) {
    await exec.run(sqlFragment`
      INSERT INTO entity_identity_reviews (decision_id, verdict, members, group_id, entity_id, canonical_source_id, canonical_slug,
                                           decided_by, decided_at, origin, home_source_id, git_blob)
      VALUES (${d.decision_id}, ${d.verdict}, ${jsonbParam(d.members)}, ${d.group_id}, ${d.entity_id}, ${d.canonical?.source_id ?? null},
              ${d.canonical?.slug ?? null}, ${d.decided_by}, COALESCE(${d.decided_at ?? null}::timestamptz, now()), ${d.origin},
              ${d.home_source_id}, ${d.git_blob})
      ON CONFLICT (decision_id) DO UPDATE SET
        verdict = EXCLUDED.verdict, members = EXCLUDED.members, group_id = EXCLUDED.group_id, entity_id = EXCLUDED.entity_id,
        canonical_source_id = EXCLUDED.canonical_source_id, canonical_slug = EXCLUDED.canonical_slug,
        decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at, origin = EXCLUDED.origin,
        home_source_id = EXCLUDED.home_source_id, git_blob = EXCLUDED.git_blob`);
  }
  const unlinked = (await exec.query(`
    DELETE FROM entity_identities ei
     WHERE ei.established_by = 'dedupe:confirm'
       AND NOT EXISTS (
         SELECT 1 FROM ${MEMBER_PAGES}
          WHERE r.verdict = 'same' AND r.entity_id = ei.entity_id AND p.id = ei.page_id AND p.source_id = ei.source_id)
    RETURNING 1`)).rows.length;
  const linked = (await exec.query(`
    INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
    SELECT r.entity_id, p.source_id, p.id, 1.0, 'dedupe:confirm',
           p.source_id = r.canonical_source_id AND p.slug = r.canonical_slug
             AND NOT EXISTS (SELECT 1 FROM entity_identities c WHERE c.entity_id = r.entity_id AND c.canonical)
      FROM ${MEMBER_PAGES}
     WHERE r.verdict = 'same' AND r.entity_id IS NOT NULL AND p.id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM entity_identities x WHERE x.source_id = p.source_id AND x.page_id = p.id)
    ON CONFLICT (source_id, page_id) DO NOTHING
    RETURNING 1`)).rows.length;
  return { upserted: input.upsert?.length ?? 0, removed, linked, unlinked };
}
