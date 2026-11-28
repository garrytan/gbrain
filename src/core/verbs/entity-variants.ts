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
import { rethrowCapabilityMissing } from '../rust-engine/errors.ts';
import { isQuarantined } from '../quarantine.ts';
import { pageSnapshotKey } from '../page-snapshot-batch.ts';
import { followRetirement, isIdentityEntity } from '../entities/resolve.ts';
import { ENTITY_CARD_COLUMNS_SQL, type RetirementPrivacy } from '../engine-sql/entity-reads.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { NAME_MATCH_RANK, NAME_TITLE_TOKENS, WEAK_NAME_MATCHES, hasLeadingTitle, matchNameVariant, parsePersonName, probeWords, stripLeadingTitles, type NameMatchKind } from '../entities/name-variants.ts';

/** Candidate rows read per source; a full read means another page may have matched, so nothing resolves. */
export const VARIANT_CANDIDATE_CAP = 200;
/** Names longer than this many words are not person or organization names. */
const MAX_NAME_WORDS = 5;

export interface VariantRow { slug: string; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null }

/** The plain VariantRow projection; with no private-page predicate or the caller's, it reads through typed engine members. */
export const VARIANT_ROW_COLUMNS = 'slug, title, type, frontmatter';

/**
 * How the variant reads run, all through typed engine members: the plain projection ('all', 'caller') and the entity
 * card's ('card-all', 'card-caller', ENTITY_CARD_COLUMNS_SQL), the 'caller' modes with `excludePrivate`. Any other
 * projection or predicate is a caller bug and throws before a read, so it never reads as "no variants".
 */
type VariantReadMode = 'all' | 'caller' | 'card-all' | 'card-caller';
function variantReadMode(opts: { selectColumns: string; privatePredicate: string }): VariantReadMode {
  const card = opts.selectColumns === ENTITY_CARD_COLUMNS_SQL;
  if (!card && opts.selectColumns !== VARIANT_ROW_COLUMNS) throw new TypeError('name variants: selectColumns must be VARIANT_ROW_COLUMNS or ENTITY_CARD_COLUMNS_SQL');
  if (opts.privatePredicate === '') return card ? 'card-all' : 'all';
  // The caller's page policy as a predicate (rank_entities and the entity card for a remote caller); its text depends on the current caller, so it is built per read.
  if (opts.privatePredicate !== ` AND ${privatePagesFilterForCaller('pages')}`) throw new TypeError("name variants: privatePredicate must be empty or the caller's page policy");
  return card ? 'card-caller' : 'caller';
}

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
 * absent). The Rust engine's typed capability refusal is not a database failure and ends the call; the raw error text is
 * printed nowhere: stderr names the failure class only, and the wire carries the same class.
 */
export function lookupReadFailed(err: unknown, degraded: DegradedStageEntry[] | undefined): void {
  rethrowCapabilityRefusal(err);
  rethrowCapabilityMissing(err); // the Rust engine's typed refusal of a member it does not serve
  if (!degraded) return; // a caller that only shapes suggestions (possible duplicates, the doctor pair scan) reports nothing
  // The warning names the failure class only: a database error's message or code can carry a connection string or password.
  const reason = isTimeoutError(err) ? 'timeout' : 'provider_error';
  warnOncePerProcess('entity-lookup-failed', `[gbrain] entity lookup read failed (reported as degraded): ${reason}`);
  pushDegraded(degraded, 'entity_lookup_failed', reason);
}

/**
 * Variant candidates for `name` in one source. `selectColumns` is the
 * caller's row projection over `pages`; `privatePredicate` its read
 * predicate (` AND ...` or empty) on `pages`, `retirementPrivacy` the page
 * policy followRetirement applies to each hop; `entityTypes` the pack's linkable types.
 */
export async function resolveNameVariant<R extends VariantRow>(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: { selectColumns: string; privatePredicate: string; retirementPrivacy: RetirementPrivacy; entityTypes: ReadonlySet<string>; omitQuarantined?: boolean; exclude?: readonly string[]; degraded?: DegradedStageEntry[] },
): Promise<VariantResult<R>> {
  const words = probeWords(name);
  if (!words.length || parsePersonName(name).core.length > MAX_NAME_WORDS || name.includes('/')) return { matches: [] };
  const mode = variantReadMode(opts);
  const types = [...opts.entityTypes, 'person', 'company', 'fund', 'organization'];
  const slugPatterns = ['people/%', 'companies/%', 'funds/%', 'orgs/%', 'organizations/%'];
  let rows: Array<R & { probe_hits: number }>;
  try {
    // The plain projection reads through the typed members (engine-sql/entity-reads.ts).
    const q = { types, slugPatterns, probes: words.map(likeWord), limit: VARIANT_CANDIDATE_CAP + 1 };
    rows = mode === 'all'
      ? await engine.listNameVariantCandidates(sourceId, q) as Array<R & { probe_hits: number }>
      : mode === 'caller'
      ? await engine.listVisibleNameVariantCandidates(sourceId, q, { excludePrivate: true }) as Array<R & { probe_hits: number }>
      : await engine.listNameVariantCardCandidates(sourceId, q, { excludePrivate: mode === 'card-caller' }) as unknown as Array<R & { probe_hits: number }>;
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
      const [fetched] = await readVariantTarget<R>(engine, sourceId, live.slug, mode).catch((err: unknown) => {
        lookupReadFailed(err, opts.degraded);
        return [] as R[];
      });
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

/** The live page at `slug` that a retired candidate names, in the caller's projection and under its read predicate. */
async function readVariantTarget<R extends VariantRow>(engine: BrainEngine, sourceId: string, slug: string, mode: VariantReadMode): Promise<R[]> {
  switch (mode) {
    case 'all': return await liveStubs(engine, sourceId, [slug]) as R[];
    case 'caller': return await engine.readVisibleVariantPages(sourceId, [slug], { excludePrivate: true }) as R[];
    case 'card-all':
    case 'card-caller':
      return await engine.readEntityCardRows(sourceId, { slugs: [slug] }, { excludePrivate: mode === 'card-caller' }) as unknown as R[];
  }
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
  opts: { selectColumns: string; privatePredicate: string; retirementPrivacy: RetirementPrivacy; entityTypes: ReadonlySet<string>; omitQuarantined?: boolean },
): Promise<PossibleDuplicate[]> {
  if (!row.slug.startsWith('people/') && row.type !== 'person') return [];
  const mode = variantReadMode(opts);
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
      // The variant arm returns only a live page the caller may read, so the title read applies no page policy.
      const [t] = await engine.readVisibleVariantPages(sourceId, [target]);
      return t ? [{ slug: t.slug, title: t.title ?? t.slug, reason: 'title_prefix' }] : [];
    }
    const core = parsePersonName(row.title || basename).core;
    if (core.length < 2) return [];
    const last = core[core.length - 1]!;
    const slugs = [...NAME_TITLE_TOKENS].flatMap(t => [`people/${t}-${last}`, `people/${t}-${core.join('-')}`]);
    const wanted = [...new Set(slugs)].filter(slug => slug !== row.slug);
    const stubs: VariantRow[] = mode === 'all' || mode === 'card-all'
      ? await liveStubs(engine, sourceId, wanted)
      : await engine.readVisibleVariantPages(sourceId, wanted, { excludePrivate: true });
    const out: PossibleDuplicate[] = [];
    for (const stub of stubs) {
      if (opts.omitQuarantined && isQuarantined(stub.frontmatter)) continue;
      if (await resolveRemainder(stub) === row.slug) out.push({ slug: stub.slug, title: stub.title ?? stub.slug, reason: 'title_prefix' });
    }
    return out;
  } catch (err) {
    rethrowCapabilityRefusal(err);
    return [];
  }
}

/**
 * The live pages at `slugs` in the source, in `slugs` order, as the stub rows readPossibleDuplicates needs (slug,
 * title, type, frontmatter). Read through the typed page snapshots when no private-page predicate applies.
 */
async function liveStubs(engine: BrainEngine, sourceId: string, slugs: readonly string[]): Promise<VariantRow[]> {
  const refs = slugs.map(slug => ({ slug, sourceId }));
  const out: VariantRow[] = [];
  for (let start = 0; start < refs.length;) {
    const { snapshots, covered } = await engine.readPageSnapshotsBatch(refs.slice(start), { absentIsNull: true });
    if (covered < 1) throw new Error('readPageSnapshotsBatch covered no ref');
    for (const ref of refs.slice(start, start + covered)) {
      const page = snapshots.get(pageSnapshotKey(sourceId, ref.slug))?.page;
      if (page) out.push({ slug: page.slug, title: page.title, type: page.type, frontmatter: page.frontmatter });
    }
    start += covered;
  }
  return out;
}
