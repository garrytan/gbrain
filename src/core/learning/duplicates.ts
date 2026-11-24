/**
 * Nightly learning PR 3: the duplicate-people questions. learning_derive reads the dedupe preview (scan, the read
 * `gbrain dedupe --preview` runs: read-only and keyless), ranks its person groups by the best owner-contact score
 * among their members (engine-sql/salience.ts, anchored on resolveOwnerContactAnchor) and records the top five as
 * duplicate_to_confirm items. With no resolved owner the preview's own order stands. Nothing here links, merges,
 * confirms or rejects anything: the owner answers with gbrain dedupe confirm or reject, which stay trusted-local.
 *
 * A group id is a hash with no bigint row, so an item points at the group's anchor page (its member with the lowest
 * page id, target_table 'pages'). learned recomputes the preview and renders the group anchored there; a group that
 * was confirmed, rejected or re-anchored is gone from the preview, so its item shows nothing.
 */
import type { BrainEngine } from '../engine.ts';
import type { DuplicateGroup } from '../entities/duplicates.ts';
import { confirmable, scan, type Scan } from '../../commands/dedupe.ts';
import { resolveOwnerContactAnchor } from '../enrich/owner-contact.ts';
import { notRecordedSql } from './kinds.ts';

export const MAX_DUPLICATE_QUESTIONS = 5;
/** owner-contact scores read per pass; a member past them counts as no contact. */
const SCORED_PAGES_MAX = 5000;
/** The owner-contact order ranks thin pages only; a duplicate member is ranked whatever its length. */
const ANY_LENGTH = 1_000_000_000;

const keyOf = (m: { source_id: string; slug: string }) => `${m.source_id}\t${m.slug}`;

export interface DuplicateMemberPage { source_id: string; slug: string; title: string; page_id: number }
export interface AnchoredGroup { group: DuplicateGroup; anchor: number; members: DuplicateMemberPage[] }

/** The preview's person groups the owner can answer (conflicts are not duplicates), in preview order, with their anchors. */
function personGroups(s: Scan): AnchoredGroup[] {
  const out: AnchoredGroup[] = [];
  for (const group of s.result.groups) {
    if (s.kindOf.get(group.id) !== 'person' || group.class === 'conflict') continue;
    const members = group.members.map(m => s.pages.get(keyOf(m))).filter(p => p !== undefined)
      .map(p => ({ source_id: p.source_id, slug: p.slug, title: p.title, page_id: p.page_id }));
    if (members.length !== group.members.length) continue;
    out.push({ group, anchor: Math.min(...members.map(m => m.page_id)), members });
  }
  return out;
}

/** The person groups, best owner contact first; the preview's order when the owner does not resolve. */
export async function rankDuplicateGroups(engine: BrainEngine): Promise<{ ranked_by: 'owner-contact' | 'preview'; owner_reason?: string; groups: AnchoredGroup[] }> {
  const groups = personGroups(await scan(engine));
  if (!groups.length) return { ranked_by: 'preview', groups };
  const resolved = await resolveOwnerContactAnchor(engine);
  if (!resolved.owner) return { ranked_by: 'preview', owner_reason: resolved.reason, groups };
  const scored = await engine.listEnrichCandidates({
    order: 'owner-contact', types: ['person'], thinThreshold: ANY_LENGTH, limit: SCORED_PAGES_MAX,
    ownerSlug: resolved.owner.slug, ownerSourceId: resolved.owner.source_id,
    sourceIds: [...new Set(groups.flatMap(g => g.members.map(m => m.source_id)))],
  });
  const score = new Map(scored.map(c => [keyOf(c), c.contact_score ?? 0]));
  const best = (g: AnchoredGroup) => Math.max(0, ...g.members.map(m => score.get(keyOf(m)) ?? 0));
  return { ranked_by: 'owner-contact', groups: groups.map(g => ({ g, s: best(g) })).sort((a, b) => b.s - a.s).map(x => x.g) };
}

/**
 * The learning_derive step: keeps at most five duplicate questions open. A recorded anchor whose group the preview still
 * lists is open until it is confirmed or rejected; the free slots go to the best-ranked live anchors not asked yet, each once.
 */
export async function recordDuplicateQuestions(engine: BrainEngine, opts: { runId: string; dryRun: boolean }):
  Promise<{ recorded: number; groups: number; ranked_by: 'owner-contact' | 'preview'; owner_reason?: string }> {
  const { groups, ...ranking } = await rankDuplicateGroups(engine);
  const anchors = [...new Set(groups.map(g => g.anchor))];
  if (!anchors.length) return { recorded: 0, groups: 0, ...ranking };
  const asked = (id: string) => `NOT ${notRecordedSql("'duplicate_to_confirm'", 'pages', id)}`;
  const fresh = `SELECT f.id, f.ord FROM (
       SELECT u.id, u.ord, x.asked, row_number() OVER (PARTITION BY x.asked ORDER BY u.ord) AS rn,
              count(*) FILTER (WHERE x.asked) OVER () AS open
         FROM unnest($1::bigint[]) WITH ORDINALITY AS u(id, ord) JOIN pages p ON p.id = u.id AND p.deleted_at IS NULL
        CROSS JOIN LATERAL (SELECT ${asked('u.id')} AS asked) x) f
     WHERE NOT f.asked AND f.rn <= ${MAX_DUPLICATE_QUESTIONS} - f.open ORDER BY f.ord`;
  const rows = opts.dryRun
    ? await engine.executeRaw(fresh, [anchors])
    : await engine.executeRaw(`INSERT INTO learning_items (run_id, source_id, kind, target_table, target_id, subject_slug, subject_source_id)
        SELECT $2::uuid, p.source_id, 'duplicate_to_confirm', 'pages', p.id, p.slug, p.source_id
          FROM (${fresh}) AS u JOIN pages p ON p.id = u.id
         ORDER BY u.ord
        ON CONFLICT (kind, target_table, target_id) DO NOTHING RETURNING id`, [anchors, opts.runId]);
  return { recorded: rows.length, groups: groups.length, ...ranking };
}

export interface LiveDuplicate { group: DuplicateGroup; members: DuplicateMemberPage[]; commands: { confirm?: string[]; reject: string[] } }

/** The current group anchored at each page id, from the preview as it stands now. */
export async function liveDuplicateGroups(engine: BrainEngine, anchors: number[]): Promise<Map<number, LiveDuplicate>> {
  const want = new Set(anchors);
  const out = new Map<number, LiveDuplicate>();
  for (const g of personGroups(await scan(engine))) {
    if (!want.has(g.anchor) || out.has(g.anchor)) continue;
    out.set(g.anchor, { group: g.group, members: g.members,
      commands: { ...(confirmable(g.group) ? { confirm: ['gbrain', 'dedupe', 'confirm', g.group.id] } : {}), reject: ['gbrain', 'dedupe', 'reject', g.group.id] } });
  }
  return out;
}
