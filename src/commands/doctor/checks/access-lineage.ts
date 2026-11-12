/**
 * GBRA-108 access designs doctor checks (all operator settings, off by default):
 *
 *  - access_raw_only_rules: every folder or page rule stored with covers_derived false. Such a rule keeps the pages it
 *    covers to its readers, but the pages and facts derived from them are read by whoever reads those derivatives, so a
 *    summary of a raw-only transcript is not kept to the transcript's readers. Listed so a raw-only rule over a folder
 *    whose content is itself the secret is caught.
 *  - access_audience_members: every enabled member of kind audience (a group chat, a shared assistant). The brain owner
 *    reads each one's own member page, older versions, derived pages and facts as if they named the owner.
 *  - access_members_read_lineage: config access.members_read_lineage is on, so a member's credential reads derived pages
 *    and facts whose origins it reads (summaries of a page reach everyone that page lists).
 *
 * Each is informational: not applicable when its setting is unused, and an ok with the list when it is in use.
 */
import type { Check } from '../../doctor.ts';
import { checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { membersReadLineageOn } from '../../../core/access/lineage.ts';

async function rawOnlyRules(ctx: DoctorContext): Promise<Omit<Check, 'name'>> {
  const name = 'access_raw_only_rules';
  try {
    const rows = await connectedEngine(ctx).executeRaw<{ source_id: string; rule_id: string; prefix: string }>(
      'SELECT source_id, rule_id, prefix FROM access_rules WHERE NOT covers_derived ORDER BY source_id, rule_id');
    if (!rows.length) return infoCheck(name, 'Not applicable: every folder and page rule also keeps the pages and facts derived from its pages to its readers (no rule has covers_derived: false).', 'not_applicable');
    const rules = rows.map(r => `${r.source_id}:${r.rule_id} (${r.prefix})`);
    return infoCheck(name, `${rows.length} raw-only rule(s) keep their pages to their readers, but not the pages and facts derived from them: whoever reads a summary of such a page reads it. Use raw-only rules for transcripts and similar raw material, never for a folder whose content is itself the secret: ${rules.slice(0, 10).join(', ')}${rows.length > 10 ? ', ...' : ''}. Turn one back: gbrain access rule add --id <rule> --prefix <folder/> --readers <list> (without --raw-only).`, 'ok', undefined, { rules: rows });
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function audienceMembers(ctx: DoctorContext): Promise<Omit<Check, 'name'>> {
  const name = 'access_audience_members';
  try {
    const ids = (await connectedEngine(ctx).executeRaw<{ id: string }>(
      "SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id")).map(r => r.id);
    if (!ids.length) return infoCheck(name, 'Not applicable: no member is marked as an audience (gbrain access member kind <id> audience).', 'not_applicable');
    return infoCheck(name, `${ids.length} audience member(s) (a group chat or shared assistant): the brain owner reads each one's own member page, older versions, derived pages and facts as if they named the owner: ${ids.join(', ')}. Undo with gbrain access member kind <id> person.`, 'ok', undefined, { members: ids });
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function membersReadLineage(ctx: DoctorContext): Promise<Omit<Check, 'name'>> {
  const name = 'access_members_read_lineage';
  try {
    if (!(await membersReadLineageOn(connectedEngine(ctx)))) {
      return infoCheck(name, 'Not applicable: access.members_read_lineage is off; derived pages and facts of a page that names readers or sits under a rule are hidden from every member but the owner.', 'not_applicable');
    }
    return infoCheck(name, 'access.members_read_lineage is on: a member\'s credential speaking for itself reads derived pages and facts whose origins it reads, so summaries of a page reach everyone that page lists. Every remote caller\'s whoami reports it. Turn it off with gbrain access members-read-lineage off.', 'ok');
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function runAccessLineage(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _raw, ...raw } = await rawOnlyRules(ctx) as Check;
  checks.push({ name: 'access_raw_only_rules', ...raw });
  const { name: _audience, ...audience } = await audienceMembers(ctx) as Check;
  checks.push({ name: 'access_audience_members', ...audience });
  const { name: _lineage, ...lineage } = await membersReadLineage(ctx) as Check;
  checks.push({ name: 'access_members_read_lineage', ...lineage });
  return checks;
}

export const accessLineageEntry: DoctorEntry = {
  name: 'access_raw_only_rules',
  emits: ['access_raw_only_rules', 'access_audience_members', 'access_members_read_lineage'],
  run: runAccessLineage,
};
