/**
 * GBRA-574 F (part B): the slot-history arm of the query facts block. A question that asks for history (hasHistoryCue,
 * "oldest first", "held", or a dimension named in the plural) about exactly one slot dimension (facts/slots.ts:
 * role, employer, location), and not for the current value, gets every readable active slot value of the one entity it
 * names in that dimension, oldest first, each with its read-time window, inside the block's own row count and token
 * share. No model call, no writes.
 *
 * The entity is the one page the question names (entity-anchor.ts namedEntity, under the caller's page read policy)
 * or, when none, the one unbacked name key (D1): a bare slug of two or more words with an active fact in the
 * authorized pool and no live page at it, whose words the question holds as a contiguous run; a key inside a longer
 * matched key is the same mention, and two candidates (two names, or one name in two sources) match none. Its fact
 * keys are the page's (mentions/siblings.ts factEntitySlugs: the page, its siblings, its title subject and its
 * unclaimed basename) or, for a key the one readable live <dir>/<key> page claims, that page's; the read-time windows
 * (deriveSlotEnds) group every key of one entity as that entity. Rows are read under the pool's read policy
 * (fact-relevance.ts readSlotRows): withdrawn, superseded and expired rows never show.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import { deriveSlotEnds, SLOT_DIMENSIONS } from '../facts/slots.ts';
import { factEntitySlugs } from '../mentions/siblings.ts';
import { BASENAME_DIRS, fallbackSlugify } from '../entities/resolve.ts';
import { namedEntity } from './entity-anchor.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { poolUnbackedKeys, readSlotRows, type FactCandidate, type FactPoolScope } from './fact-relevance.ts';
import { hasHistoryCue } from './facts-arm.ts';

/** Words of a name key the question may hold, at most. */
const MAX_KEY_WORDS = 5;
/** Question words read for name keys, at most (the last ones). */
const MAX_KEY_SCAN_WORDS = 64;
/** Unbacked keys read per question, at most; past one the match is ambiguous anyway. */
const MAX_KEY_MATCHES = 8;

const LIST_CUE = /\b(oldest first|newest first|held)\b/i;
const CURRENT_CUE = /\b(now|nowadays|currently|current|today|these days|at the moment|at present|presently)\b/i;
const DIMENSION_CUES: ReadonlyArray<readonly [string, RegExp, RegExp]> = [
  ['role', /\b(roles?|titles?|jobs?|positions?)\b/i, /\b(roles|titles|jobs|positions)\b/i],
  ['employer', /\b(employers?|compan(?:y|ies)|work(?:s|ed|ing)? (?:at|for))\b/i, /\b(employers|companies)\b/i],
  ['location', /\b(cit(?:y|ies)|lived|lives?|living|based in|moved)\b/i, /\b(cities)\b/i],
];

/**
 * The one slot dimension a history question asks about, or null: no history cue (hasHistoryCue, "oldest first",
 * "held", or the dimension named in the plural), a present-tense cue ("now", "currently", "these days"), or no or
 * several dimensions.
 */
export function slotHistoryDimension(query: string, asOf?: string): string | null {
  if (CURRENT_CUE.test(query)) return null;
  const named = DIMENSION_CUES.filter(([, cue]) => cue.test(query));
  if (named.length !== 1) return null;
  const [dimension, , plural] = named[0]!;
  if (!SLOT_DIMENSIONS.has(dimension)) return null;
  return plural.test(query) || LIST_CUE.test(query) || hasHistoryCue(query, asOf) ? dimension : null;
}

/** The slugs a run of two to MAX_KEY_WORDS question words would carry as a name key. */
function keyCandidates(query: string): string[] {
  const words = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(-MAX_KEY_SCAN_WORDS);
  const keys = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 2; n <= MAX_KEY_WORDS && i + n <= words.length; n++) {
      const key = fallbackSlugify(words.slice(i, i + n).join(' ')) ?? '';
      if (key.includes('-')) keys.add(key);
    }
  }
  return [...keys];
}

/** D1: the one unbacked name key the question names in the authorized pool, or null for none or several. */
export async function matchUnbackedKey(engine: BrainEngine, query: string, scope: FactPoolScope): Promise<{ source_id: string; entity_slug: string } | null> {
  const matches = await poolUnbackedKeys(engine, scope, keyCandidates(query), MAX_KEY_MATCHES);
  const inside = (short: string, long: string) => short.length < long.length && ('-' + long + '-').includes('-' + short + '-');
  const outer = matches.filter(m => !matches.some(o => inside(m.entity_slug, o.entity_slug)));
  return outer.length === 1 ? outer[0]! : null;
}

export interface EntityKeys { source_id: string; canonical: string; slugs: string[] }

/**
 * One entity's fact keys: a bare key the one readable live <dir>/<key> page claims (its unclaimed basename) reads as
 * that page; any other slug as factEntitySlugs gives it ([slug] when no page sits there).
 */
export async function entityKeys(engine: BrainEngine, sourceId: string, slug: string, readScope: PageReadScope): Promise<EntityKeys> {
  const excludePrivate = readScope.excludePrivate ?? false;
  if (!slug.includes('/')) {
    const params: unknown[] = [sourceId, BASENAME_DIRS.map(dir => dir + '/' + slug)];
    const filter = pageReadFilter('p', { ...readScope, sourceId: undefined, sourceIds: undefined }, params, true);
    const pages = await engine.executeRaw<{ slug: string }>('SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND ' + filter + ' LIMIT 2', params);
    if (pages.length === 1) {
      const slugs = await factEntitySlugs(engine, sourceId, pages[0]!.slug, { excludePrivate });
      if (slugs.includes(slug)) return { source_id: sourceId, canonical: pages[0]!.slug, slugs };
    }
  }
  return { source_id: sourceId, canonical: slug, slugs: await factEntitySlugs(engine, sourceId, slug, { excludePrivate }) };
}

export interface SlotHistory { keys: EntityKeys; rows: FactCandidate[] }

/**
 * The arm's rows for a history question about one slot dimension of one named entity, or null when it does not fire:
 * the first row of each value's stint newest first, then the restatements newest first, so a tight budget keeps the
 * latest values (the block shows what it keeps oldest first).
 * Throws on a read error (the block reports facts_history_unavailable).
 */
export async function readSlotHistory(engine: BrainEngine, query: string, scope: FactPoolScope, readScope: PageReadScope): Promise<SlotHistory | null> {
  const dimension = slotHistoryDimension(query);
  if (!dimension) return null;
  const sourceIds = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
  const page = await namedEntity(engine, query, { ...readScope, sourceId: undefined, sourceIds });
  const named = page ? { source_id: page.source_id, entity_slug: page.slug } : await matchUnbackedKey(engine, query, scope);
  if (!named) return null;
  const keys = await entityKeys(engine, named.source_id, named.entity_slug, readScope);
  const rows = await readSlotRows(engine, scope, keys.slugs.map(entity_slug => ({ source_id: keys.source_id, entity_slug, dimension })));
  const values = rows.map(r => ({ ...r, id: Number(r.id), entity: true }));
  const heads = values.filter((r, i) => i === 0 || values[i - 1]!.value_hash !== r.value_hash);
  return { keys, rows: [...heads.reverse(), ...values.filter(r => !heads.includes(r)).reverse()] };
}

/**
 * Read-time windows (deriveSlotEnds) for the slot facts shown, by fact id: each fact's slot is read across its entity's
 * keys (entityKeys; `known` skips the lookup for an entity already resolved), grouped as that one entity.
 */
export async function slotWindows(engine: BrainEngine, scope: FactPoolScope, readScope: PageReadScope, facts: readonly FactCandidate[], known: EntityKeys | null): Promise<Map<number, Date>> {
  const slotted = facts.filter(f => f.entity_slug && f.dimension && f.value_hash);
  if (!slotted.length) return new Map();
  const entities = [...new Map(slotted.map(f => [f.source_id + '\u0000' + f.entity_slug, f])).values()];
  const resolved = await Promise.all(entities.map(f => known && known.source_id === f.source_id && known.slugs.includes(f.entity_slug!)
    ? known : entityKeys(engine, f.source_id, f.entity_slug!, readScope).catch(() => ({ source_id: f.source_id, canonical: f.entity_slug!, slugs: [f.entity_slug!] }))));
  const canonical = new Map(resolved.flatMap(k => k.slugs.map(s => [k.source_id + '\u0000' + s, k.canonical] as const)));
  const slots = new Map(slotted.flatMap(f => {
    const keys = resolved[entities.findIndex(e => e.source_id === f.source_id && e.entity_slug === f.entity_slug)]!;
    return keys.slugs.map(entity_slug => [[f.source_id, entity_slug, f.dimension].join('\u0000'), { source_id: f.source_id, entity_slug, dimension: f.dimension! }] as const);
  }));
  const rows = await readSlotRows(engine, scope, [...slots.values()]);
  return deriveSlotEnds(rows.map(r => ({ ...r, entity_slug: canonical.get(r.source_id + '\u0000' + r.entity_slug) ?? r.entity_slug })));
}
