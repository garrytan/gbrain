/**
 * The generation ledger statements of generations/repair.ts (`gbrain repair generations`) as typed engine members: the
 * items of a generation and its predecessor (`planRestore`), the three selected lists (live generations with unmatched
 * predecessors, live generations with a superseded predecessor, held rows), the held proposal an apply rereads, and the
 * source incarnations the preview hash binds. One SQL implementation for both engines; each statement is the text
 * repair.ts sent through `executeRaw`, with the same parameters and a total row order that sorts text by bytes (`COLLATE "C"`, as PGLite and the Rust engine sort it), on the engine's own `executeRaw`.
 *
 * The selector of a list is a typed filter, not SQL. Each optional filter is its own literal fragment, composed in the
 * order repair.ts's `selectorSql` used (run, since, owner key, id), so `renderFragment` numbers the placeholders as
 * `selectorSql` did. These are ledger reads, not page reads, so they take no page read policy. The Rust engine applies
 * the same filter to its `derived_generations` rows (rust/crates/gbrain-store/src/generations/repair.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';

/** What `gbrain repair generations` selects: `--run`, `--since` (an ISO instant), `--key`, `--generation` (or one entry's id). */
export interface GenerationRepairFilter { runId?: string; since?: string; ownerKey?: string; id?: number }

/** One ledger item of a generation (`planRestore`). `generation_id` is BIGINT (text on Postgres). */
export interface GenerationRepairItemRow {
  generation_id: number | string; item_key: string; identity_hash: string; action: string; preimage: Record<string, unknown> | null;
}

/** A live generation whose completeness lists the earlier outputs it left live unmatched. */
export interface UnmatchedGenerationRow {
  id: number | string; source_id: string; owner_key: string; activation_id: string | null;
  unmatched: Array<{ slug: string; why: string; missing: { claims: number; quotes: number; citations: number } | null }>;
}

/** A live generation and the superseded generation it replaced. */
export interface RestorableGenerationRow {
  id: number | string; source_id: string; owner_key: string; generation: number; prev_id: number | string; prev_generation: number;
}

/** A held row with the length of its retained proposal (`items`, null without one). */
export interface HeldGenerationListRow {
  id: number | string; source_id: string; owner_key: string; held_reason: string; hold_id: string; input_pin: string | null;
  attempts: number; proposal_bytes: number | null; items: number | null;
}

/** The retained proposal of a held row and its hold id. */
export interface HeldGenerationProposalRow { proposal: unknown[] | null; hold_id: string }

/** A source id and its incarnation as text. */
export interface SourceIncarnationListRow { id: string; incarnation: string }

const GENERATION_ITEMS_SQL = 'SELECT generation_id, item_key, identity_hash, action, preimage FROM derived_generation_items WHERE generation_id = ANY($1::bigint[]) ORDER BY generation_id, item_key COLLATE "C"';

const HELD_PROPOSAL_SQL = `SELECT proposal, hold_id FROM derived_generations WHERE id=$1 AND state='held'`;

const SOURCE_INCARNATIONS_SQL = 'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"';


const NO_FILTER = sqlFragment``;
const RUN_FILTER = (runId: string) => sqlFragment` AND g.run_id = ${runId}`;
const SINCE_FILTER = (since: string) => sqlFragment` AND g.created_at >= ${since}::timestamptz`;
const OWNER_FILTER = (ownerKey: string) => sqlFragment` AND g.owner_key = ${ownerKey}`;
const ID_FILTER = (id: number) => sqlFragment` AND g.id = ${id}`;

/** `YYYY-MM-DD`, `T` or a space, `HH:MM:SS`, up to 6 fractional digits, then `Z` or an offset (`+HH`, `+HH:MM`, `+HHMM`). */
const ZONED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

const daysIn = (year: number, month: number) =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/**
 * The repair `since` as `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microseconds). Every engine reads the same instant from
 * it: Postgres and PGLite cast it, the Rust engine parses it. Any other spelling refuses on every engine, because
 * Postgres reads a bare date, a time with no zone or a word (`yesterday`) in the session time zone and the Rust engine
 * does not parse them; `gbrain repair generations --since` always sends an instant (core/since.ts).
 */
export function repairSinceInstant(since: string): string {
  const refuse = () => new Error(`since must be an ISO 8601 instant with a zone, for example 2026-10-01T00:00:00Z: ${JSON.stringify(since)}`);
  const m = ZONED_INSTANT.exec(since);
  if (!m) throw refuse();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const offsetHours = Number(m[9] ?? 0);
  const offsetMinutes = Number(m[10] ?? 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59
    || offsetHours > 15 || offsetMinutes > 59) throw refuse();
  const offset = (m[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute - offset, second, 0);
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) throw refuse();
  return `${utc.toISOString().slice(0, 19)}.${(m[7] ?? '').padEnd(6, '0')}Z`;
}

/** `filter` with its `since` as `repairSinceInstant` writes it; refuses a `since` that is not an instant with a zone. */
export function checkedRepairFilter(filter: GenerationRepairFilter): GenerationRepairFilter {
  return filter.since === undefined ? filter : { ...filter, since: repairSinceInstant(filter.since) };
}

/** The filter's fragments in `selectorSql` order; an absent filter adds nothing. */
function filterFragment(unchecked: GenerationRepairFilter): SqlFragment {
  const filter = checkedRepairFilter(unchecked);
  return sqlFragment`${filter.runId !== undefined ? RUN_FILTER(filter.runId) : NO_FILTER}${filter.since !== undefined ? SINCE_FILTER(filter.since) : NO_FILTER}${
    filter.ownerKey !== undefined ? OWNER_FILTER(filter.ownerKey) : NO_FILTER}${filter.id !== undefined ? ID_FILTER(filter.id) : NO_FILTER}`;
}

const unmatchedList = (sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter) =>
  sqlFragment`SELECT g.id, g.source_id, g.owner_key, g.activation_id, g.completeness->'unmatched' AS unmatched FROM derived_generations g
      WHERE g.source_id = ANY(${sourceIds}::text[]) AND g.kind = ${kind} AND g.state = 'live' AND jsonb_typeof(g.completeness->'unmatched') = 'array'${filterFragment(filter)} ORDER BY g.id`;

const restorableList = (sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter) =>
  sqlFragment`SELECT g.id, g.source_id, g.owner_key, g.generation, p.id AS prev_id, p.generation AS prev_generation
         FROM derived_generations g JOIN derived_generations p ON p.superseded_by = g.id AND p.state = 'superseded'
        WHERE g.source_id = ANY(${sourceIds}::text[]) AND g.kind = ${kind} AND g.state = 'live'${filterFragment(filter)} ORDER BY g.id`;

const heldList = (sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter) =>
  sqlFragment`SELECT g.id, g.source_id, g.owner_key, g.held_reason, g.hold_id, g.input_pin, g.attempts, g.proposal_bytes, jsonb_array_length(g.proposal) AS items
       FROM derived_generations g WHERE g.source_id = ANY(${sourceIds}::text[]) AND g.kind = ${kind} AND g.state = 'held'${filterFragment(filter)} ORDER BY g.id`;

async function run<R>(raw: EngineRawRead, fragment: SqlFragment): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return raw<R>(text, params);
}

/** The ledger items of the generations `generationIds`. */
export async function readGenerationItemsByIds(raw: EngineRawRead, generationIds: readonly number[]): Promise<GenerationRepairItemRow[]> {
  return raw<GenerationRepairItemRow>(GENERATION_ITEMS_SQL, [generationIds]);
}

/** The live generations of `kind` in `sourceIds` whose completeness lists unmatched predecessors, in id order. */
export async function listUnmatchedGenerationRows(raw: EngineRawRead, sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<UnmatchedGenerationRow[]> {
  return run<UnmatchedGenerationRow>(raw, unmatchedList(sourceIds, kind, filter));
}

/** The live generations of `kind` in `sourceIds` with the superseded generation each replaced, in id order. */
export async function listRestorableGenerationRows(raw: EngineRawRead, sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<RestorableGenerationRow[]> {
  return run<RestorableGenerationRow>(raw, restorableList(sourceIds, kind, filter));
}

/** The held rows of `kind` in `sourceIds`, in id order. */
export async function listHeldGenerationRows(raw: EngineRawRead, sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<HeldGenerationListRow[]> {
  return run<HeldGenerationListRow>(raw, heldList(sourceIds, kind, filter));
}

/** The proposal and hold id of the held row `id`, or null when the row is gone or no longer held. */
export async function readHeldGenerationProposal(raw: EngineRawRead, id: number): Promise<HeldGenerationProposalRow | null> {
  const [row] = await raw<HeldGenerationProposalRow>(HELD_PROPOSAL_SQL, [id]);
  return row ?? null;
}

/** The incarnation of each known source of `sourceIds`, in id order. */
export async function listGenerationSourceIncarnations(raw: EngineRawRead, sourceIds: readonly string[]): Promise<SourceIncarnationListRow[]> {
  return raw<SourceIncarnationListRow>(SOURCE_INCARNATIONS_SQL, [sourceIds]);
}
