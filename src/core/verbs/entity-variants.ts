/**
 * #7160: the entity card's name-variant arm. Runs only after the precision
 * arms (alias, exact title or slug, slug suffix) found nothing. One indexed
 * candidate read per source (title and slug trigram indexes), then the pure
 * matcher in entities/name-variants.ts scores every candidate. A variant
 * resolves only when exactly one live entity page holds the strongest match
 * and the candidate read was not capped (a full read may hide an equal
 * match), and a weak match (surname alone, one-letter typo) only when it is
 * the one page that matched at all. Anything else is
 * ambiguous: nothing resolves and the matches come back as suggestions, so a
 * near-name never lands on a different person.
 *
 * `entity.name_variants=false` turns the arm off.
 */

import type { BrainEngine } from '../engine.ts';
import type { DegradedStageEntry } from '../types.ts';
import { isTimeoutError, pushDegraded } from '../search/hybrid/degraded.ts';
import { warnOncePerProcess } from '../utils.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { isQuarantined } from '../quarantine.ts';
import { followRetirement, isIdentityEntity } from '../entities/resolve.ts';
import { NAME_MATCH_RANK, NAME_TITLE_TOKENS, WEAK_NAME_MATCHES, hasLeadingTitle, matchNameVariant, parsePersonName, probeWords, stripLeadingTitles, type NameMatchKind } from '../entities/name-variants.ts';

/** Candidate rows read per source; a full read means another page may have matched, so nothing resolves. */
export const VARIANT_CANDIDATE_CAP = 200;
/** Names longer than this many words are not person or organization names. */
const MAX_NAME_WORDS = 5;

export interface VariantRow { slug: string; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null }

export interface VariantMatch<R extends VariantRow> { row: R; kind: NameMatchKind }

export interface VariantResult<R extends VariantRow> {
  /** The one page the name resolves to, with how it matched. */
  hit?: VariantMatch<R>;
  /** Every entity page that matched, strongest first (the hit included). */
  matches: Array<VariantMatch<R>>;
}

export async function nameVariantsEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const v = await engine.getConfig('entity.name_variants').catch(() => null);
  return !(typeof v === 'string' && /^(false|off|0|no)$/i.test(v.trim()));
}

const likeWord = (w: string) => `%${w.replace(/[\\%_]/g, m => `\\${m}`)}%`;
const basenameName = (slug: string) => (slug.split('/').pop() ?? '').replace(/[-_]+/g, ' ');

/** The strongest variant under which `name` names this page (by title or slug basename). */
function bestKind(name: string, row: VariantRow): NameMatchKind | null {
  if (isTitleStub(row.title || basenameName(row.slug))) return null;
  const kinds = [row.title ?? '', basenameName(row.slug)]
    .filter(candidate => !isTitleStub(candidate))
    .map(candidate => matchNameVariant(name, candidate))
    .filter((k): k is NameMatchKind => k !== null);
  return kinds.length ? kinds.reduce((a, b) => (NAME_MATCH_RANK[b] < NAME_MATCH_RANK[a] ? b : a)) : null;
}

/** "Mayor Example": a title in front of one name word. It names someone only through the page it duplicates, never as a variant target. */
export function isTitleStub(name: string): boolean {
  const parsed = parsePersonName(name);
  return parsed.titles.length > 0 && parsed.core.length === 1;
}

/**
 * A lookup read failed: the arm contributes nothing, and `degraded` says so (a miss is then not proof the entity is
 * absent). The Rust engine's typed capability refusal is not a database failure and ends the call; the raw error text goes
 * to stderr only, never onto the wire.
 */
export function lookupReadFailed(err: unknown, degraded: DegradedStageEntry[] | undefined): void {
  rethrowCapabilityRefusal(err);
  if (!degraded) return; // a caller that only shapes suggestions (possible duplicates, the doctor pair scan) reports nothing
  warnOncePerProcess('entity-lookup-failed', `[gbrain] entity lookup read failed (reported as degraded): ${err instanceof Error ? err.message : String(err)}`);
  pushDegraded(degraded, 'entity_lookup_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
}

/**
 * Variant candidates for `name` in one source. `selectColumns` is the
 * caller's row projection over `pages`; `privatePredicate` its read
 * predicate (` AND ...` or empty) on `pages`, `retirementPrivacy` the same on
 * alias `p` (followRetirement); `entityTypes` the pack's linkable types.
 */
export async function resolveNameVariant<R extends VariantRow>(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: { selectColumns: string; privatePredicate: string; retirementPrivacy: string; entityTypes: ReadonlySet<string>; omitQuarantined?: boolean; exclude?: readonly string[]; degraded?: DegradedStageEntry[] },
): Promise<VariantResult<R>> {
  const words = probeWords(name);
  if (!words.length || parsePersonName(name).core.length > MAX_NAME_WORDS || name.includes('/')) return { matches: [] };
  let rows: Array<R & { probe_hits: number }>;
  try {
    rows = await engine.executeRaw<R & { probe_hits: number }>(
      `SELECT ${opts.selectColumns},
              (SELECT count(*)::int FROM unnest($4::text[]) w WHERE pages.title ILIKE w OR pages.slug ILIKE w) AS probe_hits
         FROM pages
        WHERE deleted_at IS NULL AND source_id = $1
          AND (type = ANY($2::text[]) OR slug LIKE ANY($3::text[]))
          AND (title ILIKE ANY($4::text[]) OR slug ILIKE ANY($4::text[]))${opts.privatePredicate}
        ORDER BY probe_hits DESC, length(title), slug
        LIMIT ${VARIANT_CANDIDATE_CAP + 1}`,
      [sourceId, [...opts.entityTypes, 'person', 'company', 'fund', 'organization'],
        ['people/%', 'companies/%', 'funds/%', 'orgs/%', 'organizations/%'], words.map(likeWord)],
    );
  } catch (err) {
    // The candidate read failed: no variant can be offered, and a miss is then not proof the entity is absent.
    lookupReadFailed(err, opts.degraded);
    return { matches: [] };
  }
  const capped = rows.length > VARIANT_CANDIDATE_CAP;
  const exclude = new Set(opts.exclude ?? []);
  const best = new Map<string, VariantMatch<R>>();
  for (const row of rows.slice(0, VARIANT_CANDIDATE_CAP)) {
    if (exclude.has(row.slug) || !isIdentityEntity(row.slug, row.type) && !opts.entityTypes.has(row.type ?? '')) continue;
    if (opts.omitQuarantined && isQuarantined(row.frontmatter)) continue;
    const kind = bestKind(name, row);
    if (!kind) continue;
    // A failed follow-up read drops a real candidate, so it is a failed lookup too (the capability refusal still ends the call).
    const live = await followRetirement(engine, sourceId, row.slug, opts.retirementPrivacy).catch(err => { lookupReadFailed(err, opts.degraded); return null; });
    if (!live || exclude.has(live.slug)) continue;
    let target: R | undefined = live.slug === row.slug ? row : rows.find(r => r.slug === live.slug);
    if (!target) {
      const [fetched] = await engine.executeRaw<R>(
        `SELECT ${opts.selectColumns} FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = $2${opts.privatePredicate}`,
        [sourceId, live.slug]).catch(err => { lookupReadFailed(err, opts.degraded); return [] as R[]; });
      if (!fetched || (opts.omitQuarantined && isQuarantined(fetched.frontmatter))) continue;
      target = fetched;
    }
    const prev = best.get(target.slug);
    if (!prev || NAME_MATCH_RANK[kind] < NAME_MATCH_RANK[prev.kind]) best.set(target.slug, { row: target, kind });
  }
  const matches = [...best.values()].sort((a, b) => NAME_MATCH_RANK[a.kind] - NAME_MATCH_RANK[b.kind] || a.row.slug.localeCompare(b.row.slug));
  if (!matches.length) return { matches };
  const top = matches.filter(m => m.kind === matches[0]!.kind);
  const weak = WEAK_NAME_MATCHES.has(matches[0]!.kind);
  const unique = !capped && top.length === 1 && (!weak || matches.length === 1);
  return unique ? { hit: matches[0], matches } : { matches };
}

export interface PossibleDuplicate { slug: string; title: string; reason: 'title_prefix' }

/**
 * #7160: title-prefixed person pages that likely name the same person as
 * `row` ("people/mayor-example" next to "people/alice-example"). Reported,
 * never merged or substituted: a pair qualifies only when the prefixed
 * page's remaining name resolves by the variant rules to exactly one other
 * person page. For a prefixed page that is the unprefixed page it
 * duplicates; for an unprefixed page, every prefixed page whose remainder
 * resolves to it. Fail-soft: a read error reports nothing.
 */
export async function readPossibleDuplicates<R extends VariantRow>(
  engine: BrainEngine,
  sourceId: string,
  row: VariantRow,
  opts: { selectColumns: string; privatePredicate: string; retirementPrivacy: string; entityTypes: ReadonlySet<string>; omitQuarantined?: boolean },
): Promise<PossibleDuplicate[]> {
  if (!row.slug.startsWith('people/') && row.type !== 'person') return [];
  const basename = basenameName(row.slug);
  const resolveRemainder = async (stub: VariantRow): Promise<string | null> => {
    const name = [stub.title ?? '', basenameName(stub.slug)].find(hasLeadingTitle);
    if (!name) return null;
    const res = await resolveNameVariant<R>(engine, sourceId, stripLeadingTitles(name), { ...opts, exclude: [stub.slug] });
    return res.hit?.row.slug ?? null;
  };
  try {
    if (hasLeadingTitle(row.title ?? '') || hasLeadingTitle(basename)) {
      const target = await resolveRemainder(row);
      if (!target) return [];
      const [t] = await engine.executeRaw<{ slug: string; title: string | null }>('SELECT slug, title FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, target]);
      return t ? [{ slug: t.slug, title: t.title ?? t.slug, reason: 'title_prefix' }] : [];
    }
    const core = parsePersonName(row.title || basename).core;
    if (core.length < 2) return [];
    const last = core[core.length - 1]!;
    const slugs = [...NAME_TITLE_TOKENS].flatMap(t => [`people/${t}-${last}`, `people/${t}-${core.join('-')}`]);
    const stubs = await engine.executeRaw<R>(
      `SELECT ${opts.selectColumns} FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[]) AND slug <> $3${opts.privatePredicate}`,
      [sourceId, slugs, row.slug]);
    const out: PossibleDuplicate[] = [];
    for (const stub of stubs) {
      if (opts.omitQuarantined && isQuarantined(stub.frontmatter)) continue;
      if (await resolveRemainder(stub) === row.slug) out.push({ slug: stub.slug, title: stub.title ?? stub.slug, reason: 'title_prefix' });
    }
    return out;
  } catch {
    return [];
  }
}
