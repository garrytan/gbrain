/**
 * Guest notes (GBRA-504, decision I1): no derived row carries guest text. Every producer that derives rows from pages is
 * listed here with what it does on a guest source: `skip` names the code sites that skip guest pages (each calls a
 * helper below with its own key, so this table drives the behavior), and `none` says why the producer never takes
 * guest input. test/guest-derived-registry.test.ts fails for a cycle phase missing here and for a skip site that does
 * not call the helper with its key. A guest source is database-only and holds no facts, takes or timeline rows (the
 * trust trigger refuses them), so producers of those rows fail closed even without a skip.
 */
import type { BrainEngine } from '../engine.ts';
import type { CyclePhase } from '../cycle.ts';
import { guestSourceSql, isGuestSource, readGuestSourceIds, storedGuestNote } from './note.ts';

export type GuestDerivedProducer = CyclePhase | 'publication_projections' | 'auto_links' | 'remote_links_effect' | 'facts_backstop' | 'think_writeback';
type GuestDerivedEntry = { guest: 'skip'; sites: readonly string[] } | { guest: 'none'; reason: string };

const CYCLE = 'src/core/cycle.ts';
const FILESYSTEM = 'Reads canonical files on disk; a guest source is database-only and has none.';
const NO_ROWS = 'Reads takes, facts or typed links, which a guest source never holds (the trust trigger refuses them).';

export const GUEST_DERIVED_PRODUCERS = {
  lint: { guest: 'none', reason: FILESYSTEM },
  backlinks: { guest: 'none', reason: FILESYSTEM },
  sync: { guest: 'none', reason: FILESYSTEM },
  unindexed_files: { guest: 'none', reason: FILESYSTEM },
  fence_repair: { guest: 'none', reason: 'Its repairs publish as the local owner, which a guest source refuses (source_writer_restricted), so a guest page is never rewritten.' },
  content_repair: { guest: 'none', reason: 'Its repairs publish as the local owner, which a guest source refuses (source_writer_restricted), so a guest page is never rewritten.' },
  synthesize: { guest: 'none', reason: 'Dream synthesis reads session transcripts, not pages.' },
  extract: { guest: 'skip', sites: [CYCLE, 'src/core/engine-sql/pages.ts', 'src/commands/extract.ts', 'src/commands/extract-timeline-db.ts'] },
  extract_facts: { guest: 'skip', sites: [CYCLE, 'src/core/cycle/extract-facts.ts'] },
  extract_atoms: { guest: 'skip', sites: [CYCLE, 'src/core/cycle/extract-atoms.ts'] },
  resolve_symbol_edges: { guest: 'none', reason: "Writes code-edge metadata on a page's own chunks; no row outside the page." },
  patterns: { guest: 'none', reason: 'A mixed phase: it runs only in the default lane and reads reflections in its own source.' },
  synthesize_concepts: { guest: 'none', reason: 'Aggregates atom pages, which extract_atoms never derives from a guest page.' },
  recompute_emotional_weight: { guest: 'none', reason: "Scores a page from its own takes and tags into that page's emotional_weight column; a guest page has no takes." },
  consolidate: { guest: 'none', reason: NO_ROWS },
  propose_takes: { guest: 'skip', sites: [CYCLE, 'src/core/cycle/propose-takes.ts'] },
  grade_takes: { guest: 'none', reason: NO_ROWS },
  calibration_profile: { guest: 'none', reason: NO_ROWS },
  edge_contradictions: { guest: 'none', reason: NO_ROWS },
  claim_conflicts: { guest: 'none', reason: NO_ROWS },
  drift: { guest: 'none', reason: NO_ROWS },
  standing_questions: { guest: 'none', reason: 'Answers through search like any reader; its evidence pointers name pages and copy no text.' },
  chronicle: { guest: 'skip', sites: ['src/core/cycle/chronicle.ts'] },
  facts_drain: { guest: 'none', reason: 'Runs queued facts-absorb jobs; facts_backstop never queues one for a guest page.' },
  conversation_facts_backfill: { guest: 'skip', sites: [CYCLE, 'src/core/cycle/conversation-facts-backfill.ts'] },
  enrich_thin: { guest: 'skip', sites: [CYCLE, 'src/core/cycle/enrich-thin.ts'] },
  skillopt: { guest: 'none', reason: 'Writes skill files and proposals outside the brain database.' },
  embed: { guest: 'none', reason: "Embeds a page's own chunks, which search needs to find the note; no text reaches another row." },
  orphans: { guest: 'none', reason: 'A read-only report; it writes no row.' },
  'schema-suggest': { guest: 'none', reason: 'Writes schema suggestions outside the canonical tables; a guest page carries only allowlisted keys.' },
  purge: { guest: 'none', reason: 'Purges tombstones; the owner may delete guest pages. Its origin carry (repair/origin-carry.ts) labels only pages tied to an origin by derived_from, source_slug, event or a provenance link: a guest page carries none of those keys and a guest source holds no links and no owner page, so it never labels a guest page.' },
  bookkeeping_gc: { guest: 'none', reason: 'Never touches a page.' },
  publication_projections: { guest: 'skip', sites: ['src/core/persistence/page-prepare.ts'] },
  auto_links: { guest: 'skip', sites: ['src/core/persistence/page-prepare.ts'] },
  remote_links_effect: { guest: 'skip', sites: ['src/core/persistence/effect-links.ts'] },
  facts_backstop: { guest: 'skip', sites: ['src/core/persistence/effect-facts.ts'] },
  think_writeback: { guest: 'none', reason: 'A persisted synthesis takes the lowest tier of its inputs (deriveTrust over taint_refs), so one built on a guest note lands at external_untrusted.' },
} as const satisfies Record<GuestDerivedProducer, GuestDerivedEntry>;

type Producers = typeof GUEST_DERIVED_PRODUCERS;
export type GuestSkipProducer = { [K in keyof Producers]: Producers[K]['guest'] extends 'skip' ? K : never }[keyof Producers];

const skips = (producer: GuestSkipProducer) => GUEST_DERIVED_PRODUCERS[producer].guest === 'skip';

/** The cycle phases a cycle scoped to a guest source skips. */
export function guestSkippedPhases(): CyclePhase[] {
  return (Object.keys(GUEST_DERIVED_PRODUCERS) as GuestDerivedProducer[])
    .filter((key): key is CyclePhase & GuestSkipProducer => GUEST_DERIVED_PRODUCERS[key].guest === 'skip' && (GUEST_DERIVED_PRODUCERS[key] as { sites: readonly string[] }).sites.includes(CYCLE));
}

// Every helper below decides "guest source" with note.ts guestSourceSql, the test reads use: the source's config says
// guest or guest_sources lists it. A lookup that fails counts as guest (the producer skips) or refuses (it throws).

/** True when `producer` skips `sourceId` because it is a guest source, or because the lookup failed. */
export async function skipsGuestSource(engine: Pick<BrainEngine, 'executeRaw'>, producer: GuestSkipProducer, sourceId: string): Promise<boolean> {
  return skips(producer) && isGuestSource(engine, sourceId);
}

/**
 * Whether a write is a guest write for the publication-time producers: its stored intent carries a guest note, or it
 * lands in a guest source. Throws when the lookup fails, so the write refuses instead of publishing derived rows.
 */
export async function isGuestWrite(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, intent: Record<string, unknown> | null | undefined): Promise<boolean> {
  return storedGuestNote(intent) !== null || (await readGuestSourceIds(engine, [sourceId])).has(sourceId);
}

/** True when `producer` skips a write isGuestWrite classified as a guest write. */
export function skipsGuestNote(producer: GuestSkipProducer, guestWrite: boolean): boolean {
  return skips(producer) && guestWrite;
}

/** `items` without those in a guest source, for a producer that walks several sources; none when the lookup fails. */
export async function withoutGuestSources<T>(engine: Pick<BrainEngine, 'executeRaw'>, producer: GuestSkipProducer, items: readonly T[], sourceOf: (item: T) => string): Promise<T[]> {
  if (!skips(producer) || items.length === 0) return [...items];
  let guests: Set<string>;
  try { guests = await readGuestSourceIds(engine, items.map(sourceOf)); } catch { return []; }
  return items.filter(item => !guests.has(sourceOf(item)));
}

/** A SQL predicate keeping rows of `alias` (a pages alias or table name) outside guest sources; it errors (the read refuses) without the guest tables. */
export function guestSourceExclusionSql(producer: GuestSkipProducer, alias: string): string {
  return skips(producer) ? `NOT EXISTS (SELECT 1 FROM sources guest_src WHERE guest_src.id = ${alias}.source_id AND ${guestSourceSql('guest_src.config', 'guest_src.id')})` : 'TRUE';
}
