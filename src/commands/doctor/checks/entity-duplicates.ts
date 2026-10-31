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
 * Also sweeps live entity identifiers and aliases within each source.
 * Titled candidates use exact slug-prefix reads (PAIR_SCAN_CAP per brain)
 * and one variant read each; all pairs share one batched link count.
 */
import type { Check } from '../../doctor.ts';
import { NAME_TITLE_TOKENS, hasLeadingTitle, stripLeadingTitles } from '../../../core/entities/name-variants.ts';
import { resolveNameVariant } from '../../../core/verbs/entity-variants.ts';
import { retiredPageSql } from '../../../core/entities/resolve.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { entityCollisionPairs } from './entity-collisions.ts';

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
      pairs.push(...await entityCollisionPairs(engine, sourceId));
      if (scanned >= PAIR_SCAN_CAP) { capped = true; continue; }
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
    // A titled pair can also share an email or alias. Keep one stable tuple.
    const seen = new Set<string>();
    for (let i = pairs.length - 1; i >= 0; i--) {
      const p = pairs[i]!;
      const key = JSON.stringify([p.source_id, ...[p.stub, p.canonical].sort()]);
      if (seen.has(key)) pairs.splice(i, 1);
      else seen.add(key);
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
      message: `${pairs.length} potential entity duplicate or name collision pair(s): shared person email (including role mailboxes), organization domain, alias naming another page, or title-prefixed person name. Review filing and identity; pair order does not select a merge target. Nothing was changed. ${shown}${pairs.length > SHOWN ? `; ${pairs.length - SHOWN} more in details` : ''}.${scope}`,
      details: { scanned, capped, pairs },
      fix: {
        ask_user: true, actor: 'user', consent: [], requires_exclusive: false, verify: doctorVerify(NAME),
        argv: ['gbrain', 'get', first.stub, '--source', first.source_id],
        why: 'Shared identifiers or names can be legitimate; only the owner can establish identity and the correct filing.',
        user_message: `Review each pair (for example ${first.stub} and ${first.canonical}). Correct shared role mailboxes and conflicting aliases where appropriate. Only after verifying both pages represent one entity, choose the surviving page and mark the other with merged_into: <surviving slug>, preserving its content first.`,
      },
    });
  } catch (err) {
    checks.push({ name: 'person_title_duplicates', status: 'warn', message: `Entity duplicate and collision checks could not complete: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const personTitleDuplicatesEntry: DoctorEntry = { name: 'person_title_duplicates', emits: ['person_title_duplicates'], run: runPersonTitleDuplicates };
