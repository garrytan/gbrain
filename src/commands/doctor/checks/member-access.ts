/**
 * GBRA-218 member-access doctor checks (plan section 5). Each reads the brain
 * once, is bounded by SAMPLE in its details, and fixes with a read-only or
 * preview-first command whose `verify` is the read-only check itself.
 *
 *  - access_readers_malformed: pages whose `readable_by` normalizes to nobody
 *    (gbrain_access_readers() = {!nobody}); remote callers cannot read them.
 *  - access_unknown_readers: readers naming no member or no group (a typo, or
 *    a member not added yet); a group with no members is reported apart.
 *  - access_recent_narrowings: pages whose live revision gained readers in the
 *    last NARROWING_DAYS days (the previous snapshot named none), with the
 *    principal that wrote the revision when recorded.
 *  - access_page_readers_backfill: pages whose derived `page_readers` differs
 *    from their frontmatter (written before the migration); they read as
 *    nobody until `gbrain repair access` derives them.
 *
 * A brain that holds no member restriction (config access.restrictions_present)
 * is not applicable for all four; nothing is read.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { agentFix, checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { accessRestrictionsPresent } from '../../../core/search/private-visibility.ts';

const SAMPLE = 20;
const NARROWING_DAYS = 7;
const DOCS = 'docs/guides/write-refusals.md#readable_by_invalid';

type PageRef = { source_id: string; slug: string };
const ref = (p: PageRef) => `${p.source_id}:${p.slug}`;
const showPage = (p: PageRef, name: string, why: string) => agentFix(['gbrain', 'get', '--source', p.source_id, '--', p.slug], why, name, { docs: DOCS });

async function malformed(engine: BrainEngine): Promise<Check> {
  const name = 'access_readers_malformed';
  const rows = await engine.executeRaw<PageRef & { total: number }>(
    `SELECT source_id, slug, count(*) OVER ()::int AS total FROM pages
      WHERE deleted_at IS NULL AND frontmatter->'readable_by' IS NOT NULL AND gbrain_access_readers(frontmatter) = ARRAY['!nobody']::text[]
      ORDER BY source_id, slug LIMIT ${SAMPLE}`);
  const total = rows[0]?.total ?? 0;
  if (!total) return { name, status: 'ok', message: 'Every page that names readers names them validly.', details: { count: 0 } };
  return { name, status: 'warn', details: { count: total, samples: rows.map(ref), truncated: total > rows.length },
    message: `${total} page(s) carry a readable_by that names no valid reader, so no remote caller can read them (e.g. ${rows.slice(0, 5).map(ref).join(', ')}). `
      + 'Write readable_by as a list of member ids and group:<id> entries, for example readable_by: [alice-example, group:team-a].',
    fix: { ...showPage(rows[0]!, name, 'Shows the first page with its readable_by; correct the field (member ids and group:<id> entries) and save the page, then re-run the check.'), actor: 'user', ask_user: true } };
}

async function unknownReaders(engine: BrainEngine): Promise<Check> {
  const name = 'access_unknown_readers';
  const rows = await engine.executeRaw<{ reader: string; kind: 'unknown' | 'retired' | 'empty_group'; pages: number; sample: PageRef }>(
    `WITH named AS (
       SELECT p.source_id, p.slug, r AS reader FROM pages p, unnest(gbrain_access_readers(p.frontmatter)) AS r
        WHERE p.deleted_at IS NULL AND p.frontmatter->'readable_by' IS NOT NULL AND r <> '!nobody'),
     classified AS (
       SELECT n.*, CASE
         WHEN n.reader LIKE 'member:%' THEN (SELECT CASE WHEN m.id IS NULL THEN 'unknown' WHEN m.tombstoned_at IS NOT NULL THEN 'retired' END
           FROM (SELECT 1) one LEFT JOIN access_members m ON m.id = substr(n.reader, 8))
         ELSE (SELECT CASE WHEN g.id IS NULL THEN 'unknown' WHEN NOT EXISTS (SELECT 1 FROM access_group_members gm WHERE gm.group_id = g.id) THEN 'empty_group' END
           FROM (SELECT 1) one LEFT JOIN access_groups g ON g.id = substr(n.reader, 7)) END AS kind
       FROM named n)
     SELECT reader, kind, count(*)::int AS pages, jsonb_build_object('source_id', min(source_id), 'slug', min(slug)) AS sample
       FROM classified WHERE kind IS NOT NULL GROUP BY reader, kind ORDER BY kind, reader LIMIT ${SAMPLE}`);
  const unknown = rows.filter(r => r.kind !== 'empty_group');
  const empty = rows.filter(r => r.kind === 'empty_group');
  const details = { unknown: unknown.map(r => ({ reader: r.reader, kind: r.kind, pages: r.pages, sample: ref(r.sample) })),
    empty_groups: empty.map(r => ({ reader: r.reader, pages: r.pages })), truncated: rows.length === SAMPLE };
  const emptyNote = empty.length ? ` ${empty.length} group(s) exist with no members, so they match nobody yet (${empty.map(r => r.reader).join(', ')}).` : '';
  if (!unknown.length) return { name, status: 'ok', details, message: `Every reader a page names is a known member or group.${emptyNote}` };
  const first = unknown[0]!;
  const id = first.reader.replace(/^(member|group):/, '');
  return { name, status: 'warn', details,
    message: `${unknown.length} reader(s) named in readable_by match no live member or group, so they let nobody in: `
      + `${unknown.slice(0, 5).map(r => `${r.reader} (${r.kind}, ${r.pages} page(s), e.g. ${ref(r.sample)})`).join('; ')}. `
      + `Fix the typo in the page, or add the member or group if it is meant to read.${emptyNote}`,
    fix: { argv: ['gbrain', 'access', first.reader.startsWith('group:') ? 'group' : 'member', 'add', id], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
      why: `Adds ${first.reader} so the pages naming it become readable by it; this widens access, so ask the user first, and fix the page instead when the name is a typo.`,
      verify: doctorVerify(name), docs: DOCS } };
}

async function recentNarrowings(engine: BrainEngine): Promise<Check> {
  const name = 'access_recent_narrowings';
  const rows = await engine.executeRaw<PageRef & { readers: string[]; writer: string | null; updated_at: string; total: number }>(
    `SELECT p.source_id, p.slug, gbrain_access_readers(p.frontmatter) AS readers, p.updated_at::text AS updated_at,
            CASE WHEN p.revision_principal_kind IS NULL THEN NULL ELSE p.revision_principal_kind || ':' || p.revision_principal_id END AS writer,
            count(*) OVER ()::int AS total
       FROM pages p
       JOIN LATERAL (SELECT v.frontmatter FROM page_versions v WHERE v.page_id = p.id ORDER BY v.snapshot_at DESC, v.id DESC LIMIT 1) prev ON true
      WHERE p.deleted_at IS NULL AND p.frontmatter->'readable_by' IS NOT NULL AND prev.frontmatter->'readable_by' IS NULL
        AND p.updated_at > now() - make_interval(days => ${NARROWING_DAYS})
      ORDER BY p.updated_at DESC LIMIT ${SAMPLE}`);
  const total = rows[0]?.total ?? 0;
  const details = { count: total, window_days: NARROWING_DAYS, narrowings: rows.map(r => ({ page: ref(r), readers: r.readers, writer: r.writer ?? 'unrecorded', at: r.updated_at })), truncated: total > rows.length };
  if (!total) return { name, status: 'ok', details, message: `No page gained readers in the last ${NARROWING_DAYS} days.` };
  return { name, status: 'warn', details,
    message: `${total} page(s) gained readers in the last ${NARROWING_DAYS} days and are now hidden from every other remote caller: `
      + `${rows.slice(0, 5).map(r => `${ref(r)} -> ${r.readers.join(', ')} (by ${r.writer ?? 'an unrecorded writer'})`).join('; ')}. `
      + 'Confirm each was intended; get_versions shows the earlier revision and revert_version restores it.',
    fix: { ...showPage(rows[0]!, name, 'Shows the most recently narrowed page and its readers, read-only; ask the user whether the narrowing was intended before reverting anything.'), actor: 'user', ask_user: true } };
}

async function backfill(engine: BrainEngine): Promise<Check> {
  const name = 'access_page_readers_backfill';
  const [row] = await engine.executeRaw<{ total: number }>(
    `SELECT count(*)::int AS total FROM pages
      WHERE (frontmatter->'readable_by' IS NOT NULL OR page_readers IS NOT NULL)
        AND page_readers IS DISTINCT FROM gbrain_access_readers(frontmatter)`);
  const total = row?.total ?? 0;
  if (!total) return { name, status: 'ok', details: { count: 0 }, message: 'Every page that names readers has its derived readers.' };
  return { name, status: 'warn', details: { count: total, repair: 'access' },
    message: `${total} page(s) name readers in frontmatter but have no derived readers yet (written before member access), so they read as nobody for every remote caller, listed members included. `
      + 'Preview with gbrain repair access, then apply the printed command after the user agrees; it never widens anything.',
    fix: agentFix(['gbrain', 'repair', 'access', '--apply'], 'Derives the missing readers; run the preview first and apply after the user agrees. It only restores reads for listed members and never widens anything.', name,
      { preview_argv: ['gbrain', 'repair', 'access', '--json'], ask_user: true, docs: DOCS }) };
}

/** One check's result, or the unknown-convention error when its read failed. */
async function guarded(name: string, run: (engine: BrainEngine) => Promise<Check>, engine: BrainEngine, applicable: boolean): Promise<Omit<Check, 'name'>> {
  const { name: _name, ...check } = applicable
    ? await run(engine).catch(error => checkError(name, `run ${name}`, error))
    : infoCheck(name, 'Not applicable: no page names readers and no member exists.', 'not_applicable');
  return check;
}

async function runMemberAccess(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const applicable = await accessRestrictionsPresent(engine).catch(() => true);
  const checks: Check[] = [];
  checks.push({ name: 'access_readers_malformed', ...await guarded('access_readers_malformed', malformed, engine, applicable) });
  checks.push({ name: 'access_unknown_readers', ...await guarded('access_unknown_readers', unknownReaders, engine, applicable) });
  checks.push({ name: 'access_recent_narrowings', ...await guarded('access_recent_narrowings', recentNarrowings, engine, applicable) });
  checks.push({ name: 'access_page_readers_backfill', ...await guarded('access_page_readers_backfill', backfill, engine, applicable) });
  return checks;
}

export const memberAccessEntry: DoctorEntry = {
  name: 'access_readers_malformed',
  emits: ['access_readers_malformed', 'access_unknown_readers', 'access_recent_narrowings', 'access_page_readers_backfill'],
  run: runMemberAccess,
};
