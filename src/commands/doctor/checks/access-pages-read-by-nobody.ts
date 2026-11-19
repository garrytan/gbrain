/**
 * GBRA-582 item 9 (leaver handover, PR 2) doctor check (audit cases 9a, 9b, 9c).
 *
 *  - access_pages_read_by_nobody: live pages no enabled member reads remotely. A page counts when its readable_by
 *    names no enabled member and no group with an enabled member (a leaver's pages after disable or rm), or when a folder
 *    rule covering it admits no enabled member its readers also admit (a page written before its folder's rule). The
 *    owner still reads them on the brain host. Member pages (memory/members/<id>) and pages closed on purpose
 *    (readable_by naming the nobody marker) are left out. Warns with the handover command when the pages name a
 *    disabled or removed member, else with the label write that gives one page back.
 *
 * Set-based: one query for labelled pages and one per folder rule, under a 5-second budget; past it the check reports
 * what it counted so far as partial. With no members, the check is not applicable.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { appliedRules } from '../../../core/access/policy.ts';
import { ruleCoversSql } from '../../../core/access/folder-rules.ts';
import { MEMBER_PAGE_PREFIX, NOBODY } from '../../../core/access/principals.ts';
import { ownerMemberId } from '../../../core/access/owner.ts';

const name = 'access_pages_read_by_nobody';
const BUDGET_MS = 5_000;
const SAMPLES = 5;

interface Row { source_id: string; slug: string; readers: string[] | null }

async function verdict(ctx: DoctorContext): Promise<Check> {
  const engine = connectedEngine(ctx);
  const started = Date.now();
  try {
    const members = await engine.executeRaw<{ id: string; status: string }>("SELECT id, CASE WHEN tombstoned_at IS NOT NULL THEN 'removed' WHEN disabled_at IS NOT NULL THEN 'disabled' ELSE 'enabled' END AS status FROM access_members ORDER BY id");
    if (!members.length) return infoCheck(name, 'Not applicable: this brain has no members (gbrain access member add <id>).', 'not_applicable');
    const enabled = members.filter(m => m.status === 'enabled');
    const groups = await engine.executeRaw<{ group_id: string; member_id: string }>('SELECT group_id, member_id FROM access_group_members');
    const identityOf = (ids: string[]) => [...ids.map(id => 'member:' + id), ...new Set(groups.filter(g => ids.includes(g.member_id)).map(g => 'group:' + g.group_id))];
    const live = identityOf(enabled.map(m => m.id));
    const found = new Map<string, Row>();
    const add = (rows: Row[]) => { for (const r of rows) found.set(r.source_id + ':' + r.slug, r); };
    let partial = false;
    const timeLeft = () => BUDGET_MS - (Date.now() - started);
    add(await engine.executeRaw<Row>(
      'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND page_readers IS NOT NULL AND NOT (page_readers && $1::text[]) AND NOT ($2 = ANY(page_readers)) AND NOT starts_with(slug, $3)',
      [live, NOBODY, MEMBER_PAGE_PREFIX], { timeoutMs: Math.max(timeLeft(), 1) }));
    const sources = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(r => r.id);
    rules: for (const source of sources) {
      for (const rule of await appliedRules(engine, source)) {
        if (timeLeft() <= 0) { partial = true; break rules; }
        const admitted = enabled.filter(m => identityOf([m.id]).some(p => rule.readable_by.includes(p))).map(m => m.id);
        add(await engine.executeRaw<Row>(
          'SELECT source_id, slug, page_readers AS readers FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND ' + ruleCoversSql('slug', '$2') +
          ' AND NOT starts_with(slug, $5) AND (page_readers IS NULL OR NOT ($4 = ANY(page_readers))) AND ($3::int = 0 OR (page_readers IS NOT NULL AND NOT (page_readers && $6::text[])))',
          [source, rule.prefix, admitted.length, NOBODY, MEMBER_PAGE_PREFIX, identityOf(admitted)], { timeoutMs: Math.max(timeLeft(), 1) }));
      }
    }
    const pages = [...found.values()].sort((a, b) => (a.source_id + a.slug).localeCompare(b.source_id + b.slug));
    const details = { count: pages.length, partial, sample: pages.slice(0, SAMPLES).map(p => p.source_id + ':' + p.slug) };
    if (!pages.length) return infoCheck(name, partial ? 'No page read by no member found within the ' + BUDGET_MS / 1000 + ' s budget (partial: not every folder rule was checked).' : 'Every labelled page is read by at least one enabled member.', 'ok', undefined, details);
    const down = members.filter(m => m.status !== 'enabled').map(m => m.id);
    const leaver = down.find(id => pages.some(p => p.readers?.includes('member:' + id)));
    const owner = await ownerMemberId(engine);
    const fix = leaver
      ? agentFix(['gbrain', 'access', 'member', 'handover', leaver], 'Previews giving the pages ' + leaver + ' kept to itself to the owner; writes nothing without --yes --expect.', name)
      : agentFix(['gbrain', 'repair', 'visibility', '--slug', pages[0]!.slug, '--source', pages[0]!.source_id, '--readers', ['<member>', ...(owner ? [owner] : [])].join(',')], 'Previews giving the page to a member; writes nothing without --yes --expect.', name, { ask_user: true });
    return { name, status: 'warn', details,
      message: pages.length + (partial ? '+' : '') + ' page(s) no enabled member reads remotely: ' + details.sample.join(', ') + (pages.length > SAMPLES ? ', ...' : '') + '. The owner still reads them on the brain host. '
        + (leaver ? 'They name ' + leaver + ', which is ' + members.find(m => m.id === leaver)!.status + '; hand them over with gbrain access member handover ' + leaver + '.' : 'Give one to a member with gbrain repair visibility --slug <slug> --readers <member>' + (owner ? ',' + owner : '') + '.'),
      fix };
  } catch (error) {
    if (/timeout|canceling statement/i.test(error instanceof Error ? error.message : String(error))) {
      return infoCheck(name, 'Partial: the check did not finish within ' + BUDGET_MS / 1000 + ' s; run gbrain doctor --only ' + name + ' on a quieter moment.', 'ok', undefined, { partial: true });
    }
    return checkError(name, 'run ' + name, error);
  }
}

async function runAccessPagesReadByNobody(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _name, ...check } = await verdict(ctx);
  checks.push({ name: 'access_pages_read_by_nobody', ...check });
  return checks;
}

export const accessPagesReadByNobodyEntry: DoctorEntry = {
  name: 'access_pages_read_by_nobody',
  emits: ['access_pages_read_by_nobody'],
  run: runAccessPagesReadByNobody,
};
