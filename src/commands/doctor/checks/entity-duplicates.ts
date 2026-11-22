/**
 * person_title_duplicates (#7160): person pages whose slug starts with a title
 * or role ("people/mayor-example", "people/dr-alice-example") next to the
 * unprefixed page of the same person. Links and facts split across the two
 * pages, and a lookup of the titled form lands on the stub.
 *
 * Read-only and preview-first: it lists likely pairs and never merges. A pair
 * qualifies only when the prefixed page's remaining name resolves by the
 * entity card's variant rules (verbs/entity-variants.ts) to exactly one other
 * person page in the same source; a surname two people share pairs with
 * nobody. The owner decides each pair; marking the stub `merged_into:
 * <canonical slug>` makes entity lookup and link resolution follow it.
 *
 * A stub already marked retired (merged_into, superseded_by, canonical:
 * false) is settled and not listed.
 *
 * Bounded: titled candidates come from exact slug-prefix reads
 * (PAIR_SCAN_CAP per brain), one variant read each, one batched link count.
 *
 * entity_duplicates (plan autoplan-20261117192252, PR 1): the duplicate finder's groups (core/entities/duplicates.ts)
 * counted by kind and class, the first few listed by slug; never a key value, never a write.
 */
import type { Check } from '../../doctor.ts';
import { NAME_TITLE_TOKENS, hasLeadingTitle, stripLeadingTitles } from '../../../core/entities/name-variants.ts';
import { resolveNameVariant } from '../../../core/verbs/entity-variants.ts';
import { retiredPageSql } from '../../../core/entities/resolve.ts';
import { doctorVerify } from '../check-fix.ts';
import { DUPLICATE_KINDS, findDuplicateGroups } from '../../../core/entities/duplicates.ts';
import { decidedSets, identityDrift, type IdentityDrift } from '../../../core/entities/identity-decisions.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import type { IdentityDecisionsRead, PendingIdentityMember } from '../../../core/engine-sql/identity-decisions.ts';

export const NAME = 'person_title_duplicates';
/** Titled person pages examined per run; more are reported as not examined. */
export const PAIR_SCAN_CAP = 200;
/** Pairs printed in the message (all are in details, up to the scan cap). */
const SHOWN = 10;

export interface TitleDuplicatePair { source_id: string; stub: string; canonical: string; stub_links: number; canonical_links: number }

const PREFIXES = [...NAME_TITLE_TOKENS].map(t => `people/${t}-%`);

async function runPersonTitleDuplicates(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat(NAME);
  try {
    const sources = ctx.orphanRatioSourceId
      ? [ctx.orphanRatioSourceId]
      : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(r => r.id);
    const pairs: TitleDuplicatePair[] = [];
    let scanned = 0;
    let capped = false;
    for (const sourceId of sources) {
      if (scanned >= PAIR_SCAN_CAP) { capped = true; break; }
      const stubs = await engine.executeRaw<{ slug: string; title: string | null }>(
        `SELECT slug, title FROM pages
          WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE ANY($2::text[]) AND NOT ${retiredPageSql('pages')}
          ORDER BY slug LIMIT ${PAIR_SCAN_CAP - scanned + 1}`, [sourceId, PREFIXES]);
      if (stubs.length > PAIR_SCAN_CAP - scanned) capped = true;
      for (const stub of stubs.slice(0, PAIR_SCAN_CAP - scanned)) {
        scanned++;
        const named = [stub.title ?? '', (stub.slug.split('/').pop() ?? '').replace(/-/g, ' ')].find(hasLeadingTitle);
        const remainder = named ? stripLeadingTitles(named) : '';
        if (!remainder) continue;
        const res = await resolveNameVariant(engine, sourceId, remainder, {
          selectColumns: 'slug, title, type, frontmatter', privatePredicate: '', retirementPrivacy: '', entityTypes: new Set(['person']), exclude: [stub.slug],
        });
        if (res.hit && res.hit.row.slug.startsWith('people/')) pairs.push({ source_id: sourceId, stub: stub.slug, canonical: res.hit.row.slug, stub_links: 0, canonical_links: 0 });
      }
    }
    if (pairs.length) {
      const counts = await engine.executeRaw<{ source_id: string; slug: string; n: number }>(
        `SELECT p.source_id, p.slug, count(DISTINCT l.from_page_id)::int AS n
           FROM pages p JOIN links l ON l.to_page_id = p.id
          WHERE (p.source_id, p.slug) IN (SELECT * FROM unnest($1::text[], $2::text[]))
          GROUP BY p.source_id, p.slug`,
        [pairs.flatMap(p => [p.source_id, p.source_id]), pairs.flatMap(p => [p.stub, p.canonical])]);
      const n = new Map(counts.map(c => [`${c.source_id}:${c.slug}`, Number(c.n)]));
      for (const p of pairs) {
        p.stub_links = n.get(`${p.source_id}:${p.stub}`) ?? 0;
        p.canonical_links = n.get(`${p.source_id}:${p.canonical}`) ?? 0;
      }
    }
    const scope = capped ? ` Examined the first ${PAIR_SCAN_CAP} titled person pages only; rerun with --source <id> to cover the rest.` : '';
    if (!pairs.length) {
      checks.push({ name: 'person_title_duplicates', status: 'ok', message: `No title-prefixed person page pairs with an unprefixed page (${scanned} titled page(s) examined).${scope}`, details: { scanned, capped, pairs: [] } });
      return checks;
    }
    const shown = pairs.slice(0, SHOWN).map(p => `${p.source_id}:${p.stub} (${p.stub_links} inbound) -> ${p.canonical} (${p.canonical_links} inbound)`).join('; ');
    const first = pairs[0]!;
    checks.push({
      name: 'person_title_duplicates',
      status: 'warn',
      message: `${pairs.length} title-prefixed person page(s) likely duplicate an unprefixed page of the same person, so links and lookups split between them. Nothing was changed. ${shown}${pairs.length > SHOWN ? `; ${pairs.length - SHOWN} more in details` : ''}.${scope}`,
      details: { scanned, capped, pairs },
      fix: {
        ask_user: true, actor: 'user', consent: [], requires_exclusive: false, verify: doctorVerify(NAME),
        argv: ['gbrain', 'get', first.stub, '--source', first.source_id],
        why: 'Each pair is a guess from names alone; only the owner can say whether the two pages are one person.',
        user_message: `Review each pair (for example ${first.stub} and ${first.canonical}). Where both pages are the same person, add \`merged_into: ${first.canonical}\` to the titled page's frontmatter (move anything worth keeping first); entity lookup and link resolution then follow it. Leave pairs that are different people as they are.`,
      },
    });
  } catch (err) {
    checks.push({ name: 'person_title_duplicates', status: 'warn', message: `Title-prefixed person pages could not be checked: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const personTitleDuplicatesEntry: DoctorEntry = { name: 'person_title_duplicates', emits: ['person_title_duplicates'], run: runPersonTitleDuplicates };

const DUP_NAME = 'entity_duplicates';

async function runEntityDuplicates(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat(DUP_NAME);
  try {
    const read = await engine.listIdentityDecisions();
    const { groups, counts } = await findDuplicateGroups(engine, { ...(ctx.orphanRatioSourceId ? { sourceId: ctx.orphanRatioSourceId } : {}), decided: decidedSets(read) });
    const shown = groups.slice(0, SHOWN).map(g => ({ id: g.id, kind: g.kind, class: g.class, members: g.members }));
    const drift = await identityDrift(engine, read);
    const driftText = driftLine(drift);
    const reconcilable = drift.store_mismatch || drift.database_only > 0 || drift.unsynced_files > 0 || drift.rows_without_file > 0
      || drift.pending.some(p => p.reason === 'unlinked');
    if (driftText && !reconcilable) {
      checks.push({
        name: 'entity_duplicates', status: 'warn', message: `${driftText} ${groups.length} duplicate group(s) are undecided.`,
        details: { counts, groups: shown, drift },
        fix: { ask_user: true, actor: 'user', consent: [], requires_exclusive: false, verify: doctorVerify(DUP_NAME), argv: ['gbrain', 'entity-identity-list', '--json'],
          why: 'gbrain dedupe reconcile cannot clear these: a missing page has to come back, a page in another identity group has to leave it, and a decision file that does not validate has to be edited.',
          user_message: remedies(drift, read) },
      });
      return checks;
    }
    if (driftText) {
      checks.push({
        name: 'entity_duplicates', status: 'warn', message: `${driftText} ${groups.length} duplicate group(s) are undecided.`,
        details: { counts, groups: shown, drift },
        fix: drift.store_mismatch
          ? { ask_user: true, actor: 'user', consent: [], requires_exclusive: false, verify: doctorVerify(DUP_NAME), argv: ['gbrain', 'sources', 'list', '--json'],
            why: 'The decisions live in git on another host; only the host that holds the checkout can change them.',
            user_message: 'Run gbrain dedupe reconcile on the host that holds the brain repository.' }
          : { actor: 'agent', consent: [], requires_exclusive: false, verify: doctorVerify(DUP_NAME), argv: ['gbrain', 'dedupe', 'reconcile'],
            why: 'Writes decisions the database holds alone into git, re-reads the committed decisions and links pages that arrived since; it never decides anything new.' },
      });
      return checks;
    }
    if (!groups.length) {
      checks.push({ name: 'entity_duplicates', status: 'ok', message: `No likely duplicate person or company pages.${counts.crowded_key_values ? ` ${counts.crowded_key_values} key value(s) carried by more than five pages were not used as keys.` : ''}`, details: { counts, groups: [] } });
      return checks;
    }
    const byKind = DUPLICATE_KINDS.map(k => `${k} ${counts.by_kind[k]}`).join(', ');
    const list = shown.map(g => `${g.id} ${g.kind}/${g.class}: ${g.members.map(m => `${m.source_id}:${m.slug}`).join(' + ')}`).join('; ');
    checks.push({
      name: 'entity_duplicates',
      status: 'warn',
      message: `${groups.length} group(s) of pages are likely the same person or company (${byKind}; clean ${counts.by_class.clean}). Nothing was changed. ${list}${groups.length > SHOWN ? `; ${groups.length - SHOWN} more with gbrain dedupe --preview` : ''}.`,
      details: { counts, groups: shown },
      fix: {
        ask_user: true, actor: 'user', consent: [], requires_exclusive: false, verify: doctorVerify(DUP_NAME),
        argv: ['gbrain', 'dedupe', '--preview'],
        why: 'Each group is evidence, not a decision; only the owner can say whether the pages are one person or company.',
        user_message: 'Read the groups with `gbrain dedupe --preview`. Nothing is merged or linked yet; a conflict means two different names share a key and needs a look.',
      },
    });
  } catch (err) {
    checks.push({ name: 'entity_duplicates', status: 'warn', message: `Duplicate person and company pages could not be checked: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

/** What the owner does about drift reconcile cannot clear: missing pages, pages in another group, invalid decision files. */
function remedies(d: IdentityDrift, read: IdentityDecisionsRead): string {
  const groupOf = (p: PendingIdentityMember) => {
    const d = read.decisions.find(x => x.decision_id === p.decision_id);
    return d?.group_id ?? d?.entity_id ?? p.decision_id;
  };
  const rejects = (reason: PendingIdentityMember['reason']) => [...new Set(d.pending.filter(p => p.reason === reason).map(groupOf))].map(g => `\`gbrain dedupe reject ${g}\``).join(', ');
  const lines: string[] = [];
  if (d.pending.some(p => p.reason === 'page_missing')) lines.push(`A page of a confirmed group is missing: restore or import it and it links on the next sync, or undo the group with ${rejects('page_missing')}.`);
  if (d.pending.some(p => p.reason === 'other_group')) lines.push(`A page of a confirmed group is in another identity group: remove it from that group with \`gbrain entity-identity-unlink\`, or undo the group with ${rejects('other_group')}.`);
  if (d.invalid_files.length) lines.push(`Fix or delete ${d.invalid_files.join(', ')} in source ${d.home}'s repository and commit it; until then the last valid version of that decision, if one was read, stays applied, and an edit that does not validate is skipped.`);
  return lines.join(' ');
}

/** What disagrees between the recorded duplicate decisions and their projection, in one sentence, or ''. */
function driftLine(d: IdentityDrift): string {
  const parts: string[] = [];
  if (d.store_mismatch) parts.push('duplicate decisions are kept in git, but this host sees no repository for the brain');
  if (d.database_only) parts.push(`${d.database_only} duplicate decision(s) are in the database but not in git (source ${d.home})`);
  if (d.unsynced_files) parts.push(`${d.unsynced_files} committed decision file(s) are not read into the database yet`);
  if (d.invalid_files.length) parts.push(`${d.invalid_files.length} committed decision file(s) do not validate: ${d.invalid_files.slice(0, 3).join(', ')}`);
  if (d.rows_without_file) parts.push(`${d.rows_without_file} decision row(s) have no committed file`);
  if (d.pending.length) parts.push(`${d.pending.length} page(s) of confirmed groups are not linked (${d.pending.slice(0, 3).map(p => `${p.source_id}:${p.slug} ${p.reason}`).join(', ')})`);
  return parts.length ? `Duplicate decisions drift: ${parts.join('; ')}.` : '';
}

export const entityDuplicatesEntry: DoctorEntry = { name: 'entity_duplicates', emits: ['entity_duplicates'], run: runEntityDuplicates };
