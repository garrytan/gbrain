/**
 * Life Chronicle event identity: same-day disambiguation.
 *
 * `buildChronicleEvent` slugs an event `life/events/<day>-<hash8>` with the
 * hash over who, what and the depth page. Two proposals of one depth page
 * that share who, what and day (two "Call with alice-example" on one day)
 * get the same base slug. Publication resolves each such group here:
 *
 *   - An event's discriminator is its instant (`when`, normalized), `where`
 *     and `kind`, the fields a group's members can differ in.
 *   - One member keeps the bare base slug; every other distinct member gets
 *     `<base>-<hash6>`, the hash over its discriminator. Identical copies
 *     beyond the first get `-2`, `-3`.
 *   - Assignment reads the pages already at the candidate slugs, so it
 *     survives reordering, corrections and re-runs: the member whose
 *     discriminator the base page holds keeps the base slug, a member whose
 *     suffixed slug already exists (live or retired) keeps it, and only then
 *     does the earliest remaining member (by instant, then discriminator)
 *     take a free base slug. A page extracted before disambiguation keeps
 *     its base slug.
 *
 * Ownership, operator protection and retirement stay with publish.ts: an
 * assigned slug is written only when the extractor owns it.
 */
import type { BrainEngine } from '../engine.ts';
import { computeContentHash } from '../ingestion/types.ts';
import type { BuiltChronicleEvent } from './publish.ts';

interface EventFields { when?: unknown; where?: unknown; kind?: unknown }

function normalizedWhen(when: unknown): string {
  const text = typeof when === 'string' ? when : when instanceof Date ? when.toISOString() : '';
  const at = Date.parse(text);
  return Number.isNaN(at) ? text : new Date(at).toISOString();
}

/** The fields that tell apart events sharing who, what, depth and day. */
function eventDiscriminator(event: EventFields | null | undefined): string {
  return JSON.stringify([normalizedWhen(event?.when), typeof event?.where === 'string' ? event.where : '', String(event?.kind ?? '')]);
}

function suffixedEventSlug(base: string, discriminator: string): string {
  return `${base}-${computeContentHash(discriminator).slice(0, 6)}`;
}

function discriminatorOf(ev: BuiltChronicleEvent): string {
  return eventDiscriminator(ev.frontmatter.event as EventFields);
}

/**
 * Assign final slugs to one generation. `existing` maps a slug already in the
 * brain (any state) to the discriminator of the event it holds.
 */
export function assignChronicleEventSlugs(events: BuiltChronicleEvent[], existing: Map<string, string>): BuiltChronicleEvent[] {
  const keys = events.map(discriminatorOf);
  const instants = keys.map((key) => Date.parse(JSON.parse(key)[0]) || 0);
  const order = events.map((_, i) => i).sort((a, b) => instants[a] - instants[b] || keys[a].localeCompare(keys[b]));
  const groups = new Map<string, number[]>();
  for (const i of order) groups.set(events[i].slug, [...groups.get(events[i].slug) ?? [], i]);

  const assigned: string[] = [];
  for (const [base, members] of groups) {
    const distinct = [...new Set(members.map((i) => keys[i]))];
    const slugOf = new Map<string, string>();
    const holder = distinct.find((key) => existing.get(base) === key);
    if (holder !== undefined) slugOf.set(holder, base);
    for (const key of distinct) {
      if (!slugOf.has(key) && existing.has(suffixedEventSlug(base, key))) slugOf.set(key, suffixedEventSlug(base, key));
    }
    for (const key of distinct) {
      if (slugOf.has(key)) continue;
      slugOf.set(key, [...slugOf.values()].includes(base) ? suffixedEventSlug(base, key) : base);
    }
    const copies = new Map<string, number>();
    for (const i of members) {
      const slug = slugOf.get(keys[i])!;
      const n = (copies.get(slug) ?? 0) + 1;
      copies.set(slug, n);
      assigned[i] = n === 1 ? slug : `${slug}-${n}`;
    }
  }
  return events.map((ev, i) => (assigned[i] === ev.slug ? ev : { ...ev, slug: assigned[i] }));
}

/** Read the pages at every candidate slug of the generation, then assign. */
export async function resolveChronicleEventSlugs(engine: BrainEngine, sourceId: string,
  events: BuiltChronicleEvent[]): Promise<BuiltChronicleEvent[]> {
  if (events.length === 0) return events;
  const candidates = new Set(events.flatMap((ev) => [ev.slug, suffixedEventSlug(ev.slug, discriminatorOf(ev))]));
  const rows = await engine.listChronicleEventSlotRows(sourceId, [...candidates]);
  return assignChronicleEventSlugs(events, new Map(rows.map((r) => [r.slug, eventDiscriminator(r)])));
}
