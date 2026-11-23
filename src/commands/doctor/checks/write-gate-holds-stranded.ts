/**
 * write_gate_holds_stranded: a held write (a fact or take the write gate quarantined) remembers its page only by
 * slug. A rename (sync Git renames, `gbrain repair rename-identity`) or a delete leaves the hold naming a slug that no
 * live page has, and when the old slug now leads to a live page, that page's held text is no longer hidden by the
 * hold. This check only finds such holds. It does not fix the leak, and neither releasing nor dropping a hold
 * restores the quarantine on the renamed page or takes back text already delivered; the real fix (holds that
 * follow a page id) is a separate change. Read-only: the one next action is the read-only `gbrain trust review`.
 *
 * What is counted: held rows (`status = 'held'`, non-empty slug) in the selected sources whose `(source_id, slug)`
 * has no live page. Each hold is counted once, in the first class that fits:
 *   - renamed: the alias table or the rename history leads from the slug to a live page in the same source
 *     (a suspected strand: history can name more than one destination);
 *   - page_deleted: a page with that slug, or the rename destination, exists but is soft-deleted;
 *   - no_page: no current page and no rename evidence (for example a write held before its page exists). Informational.
 *
 * Bounded: held rows are read in `(source_id, id)` keyset batches on the `(status, source_id, id)` index, projecting
 * only id, kind, source and slug. The row budget counts held rows before any slug, page or rename filtering. When
 * the scan stops at the budget (an extra-row probe tells a full read from a cut one) or at its deadline, the check
 * warns that the count is unknown. An evidence table that cannot be read is unknown too, never an empty answer.
 *
 * A refusal from an engine without raw SQL (`engine_capability_missing`, the optional Rust engine) is reported
 * as a named unknown. The scan itself does not catch anything; this entry classifies what the scan throws.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { boundUnknownDetails } from '../bounded-unknown.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { isEngineCapabilityRefusal } from '../../../core/engine-capability-refusal.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';

const NAME = 'write_gate_holds_stranded';
/** Held rows one scan reads at most, counted before any filtering. */
const ROW_BUDGET = 5000;
/** Held rows per keyset batch. */
const BATCH = 500;
/** How long a scan may run when the doctor run gives the entry no deadline. */
const DEFAULT_SCAN_MS = 10_000;
/** Holds named in `details.items`. */
const ITEM_CAP = 50;
/** Holds named in the message. */
const MESSAGE_CAP = 5;

type HoldClass = 'renamed' | 'page_deleted' | 'no_page';
type Counts = Record<HoldClass, number>;
interface Item { hold_ref: string; kind: string; source_id: string; slug: string; class: HoldClass; current_slug?: string; destination_count?: number }
interface Scan { scanned: number; stopped: 'row_limit' | 'deadline' | null; items: Item[] }

interface HoldRow { hold_id: string; kind: string; source_id: string; slug: string }
interface Verdict { id: string; live_n: number; deleted_n: number; page_deleted: boolean; current_slug: string | null }

const zero = (): Counts => ({ renamed: 0, page_deleted: 0, no_page: 0 });

function readHolds(engine: BrainEngine, scope: string[] | undefined, after: { source: string; id: string }, limit: number): Promise<HoldRow[]> {
  return engine.executeRaw<HoldRow>(
    `SELECT id::text AS hold_id, kind, source_id, slug FROM write_gate_holds
      WHERE status = 'held' AND ($1::text[] IS NULL OR source_id = ANY($1::text[])) AND (source_id, id) > ($2::text, $3::bigint)
      ORDER BY source_id, id LIMIT $4`,
    [scope ?? null, after.source, after.id, limit]);
}

/** The holds of one batch whose slug has no live page, with what the aliases and rename history say about each. */
function readVerdicts(engine: BrainEngine, rows: HoldRow[]): Promise<Verdict[]> {
  return engine.executeRaw<Verdict>(
    `SELECT h.id, d.live_n, d.deleted_n, d.page_deleted, d.current_slug
       FROM unnest($1::text[], $2::text[], $3::text[]) AS h(source_id, slug, id)
       CROSS JOIN LATERAL (
         SELECT count(*) FILTER (WHERE p.deleted_at IS NULL AND p.slug <> h.slug)::int AS live_n,
                count(*) FILTER (WHERE p.deleted_at IS NOT NULL AND p.slug <> h.slug)::int AS deleted_n,
                COALESCE(bool_or(p.deleted_at IS NOT NULL AND p.slug = h.slug), false) AS page_deleted,
                min(p.slug) FILTER (WHERE p.deleted_at IS NULL AND p.slug <> h.slug) AS current_slug
           FROM pages p
          WHERE p.source_id = h.source_id
            AND (p.slug = h.slug OR p.slug IN (
                  SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = h.source_id AND a.alias_slug = h.slug
                  UNION
                  SELECT r.new_slug FROM slug_rename_history r WHERE r.source_id = h.source_id AND r.old_slug = h.slug))) d
      WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = h.source_id AND p.slug = h.slug AND p.deleted_at IS NULL)`,
    [rows.map(r => r.source_id), rows.map(r => r.slug), rows.map(r => r.hold_id)]);
}

async function scanHolds(engine: BrainEngine, scope: string[] | undefined, deadlineAt: number): Promise<Scan> {
  const items: Item[] = [];
  let scanned = 0;
  let stopped: Scan['stopped'] = null;
  let after = { source: '', id: '0' };
  for (;;) {
    if (Date.now() >= deadlineAt) { stopped = 'deadline'; break; }
    const want = Math.min(BATCH, ROW_BUDGET - scanned);
    if (want <= 0) {
      // The budget is spent: one more row, if any, tells a complete read from a cut one.
      if ((await readHolds(engine, scope, after, 1)).length > 0) stopped = 'row_limit';
      break;
    }
    const rows = await readHolds(engine, scope, after, want);
    scanned += rows.length;
    const named = rows.filter(r => r.slug !== '');
    if (named.length) {
      const byId = new Map(named.map(r => [r.hold_id, r]));
      for (const v of await readVerdicts(engine, named)) {
        const hold = byId.get(v.id)!;
        const cls: HoldClass = v.live_n > 0 ? 'renamed' : v.page_deleted || v.deleted_n > 0 ? 'page_deleted' : 'no_page';
        items.push({ hold_ref: `h${hold.hold_id}`, kind: hold.kind, source_id: hold.source_id, slug: hold.slug, class: cls,
          ...(cls === 'renamed' ? { current_slug: v.current_slug!, destination_count: v.live_n } : {}) });
      }
    }
    if (rows.length < want) break;
    const last = rows[rows.length - 1]!;
    after = { source: last.source_id, id: last.hold_id };
  }
  return { scanned, stopped, items };
}

const NOT_A_FIX = 'This check only detects: it does not fix the leak, and neither release nor drop restores the quarantine on the renamed page or takes back text already delivered '
  + '(drop only disposes of the hold; release publishes the held text at the hold\'s old name and payload, and a held take cannot be released). '
  + 'Read the current page (gbrain get <slug>) and edit it if it shows text that should stay hidden. The real fix, holds following a page id, is pending. '
  + 'The one next step is the read-only gbrain trust review, which lists the held writes and changes nothing.';

const reviewFix = () => agentFix(['gbrain', 'trust', 'review'],
  'Lists the held writes with their pages, read-only; it releases and drops nothing and does not restore any quarantine.', NAME);

function describeItem(i: Item): string {
  return `${i.hold_ref} (${i.source_id}/${i.slug}${i.current_slug ? ` -> ${i.current_slug}` : ''})`;
}

function examples(items: Item[], cls: HoldClass): string {
  const of = items.filter(i => i.class === cls);
  return `${of.slice(0, MESSAGE_CAP).map(describeItem).join('; ')}${of.length > MESSAGE_CAP ? `; and ${of.length - MESSAGE_CAP} more` : ''}`;
}

function tally(items: Item[]): { counts: Counts; bySource: Record<string, Counts> } {
  const counts = zero();
  const bySource: Record<string, Counts> = {};
  for (const i of items) {
    counts[i.class]++;
    (bySource[i.source_id] ??= zero())[i.class]++;
  }
  return { counts, bySource };
}

function otherClasses(counts: Counts): string {
  const parts = [
    counts.page_deleted ? `${counts.page_deleted} name a soft-deleted page or a soft-deleted rename destination` : '',
    counts.no_page ? `${counts.no_page} name a slug with no page and no rename record (for example a write held before its page exists)` : '',
  ].filter(Boolean);
  return parts.length ? ` Informational: ${parts.join('; ')}.` : '';
}

function report(scan: Scan): Omit<Check, 'name'> {
  // Renamed holds first: they are the ones that may have let held text out.
  const ordered = [...scan.items].sort((a, b) => Number(b.class === 'renamed') - Number(a.class === 'renamed'));
  const { counts, bySource } = tally(ordered);
  const base = { scanned: scan.scanned, stranded: counts, by_source: bySource, items: ordered.slice(0, ITEM_CAP), items_truncated: ordered.length > ITEM_CAP,
    row_budget: ROW_BUDGET };
  const found = counts.renamed + counts.page_deleted + counts.no_page;
  if (scan.stopped) {
    const why = scan.stopped === 'row_limit' ? `the row limit of ${ROW_BUDGET} held writes` : 'its time limit';
    return { status: 'warn', details: { ...boundUnknownDetails(scan.stopped), complete: false, scanned: scan.scanned, found_so_far: counts, by_source: bySource,
        items: ordered.slice(0, ITEM_CAP), items_truncated: ordered.length > ITEM_CAP, row_budget: ROW_BUDGET },
      message: `gbrain could not count the held writes whose page was renamed or removed: the scan stopped at ${why} after reading ${scan.scanned} held write(s). `
        + `${found ? `Found so far: at least ${found} stranded, ${counts.renamed} of them by a rename${counts.renamed ? ` (${examples(ordered, 'renamed')})` : ''}.${otherClasses(counts)}` : 'None were found in the part it read.'} `
        + `The total is unknown, not zero. ${NOT_A_FIX}`,
      fix: reviewFix() };
  }
  if (counts.renamed > 0) {
    return { status: 'warn', details: { complete: true, ...base },
      message: `${counts.renamed} held write(s) name a page that was renamed (suspected: the rename record leads from the held name to a live page, and it can name more than one): `
        + `${examples(ordered, 'renamed')}. A hold remembers its page only by name, so the page now at the new name is probably no longer protected by the hold and its held text may reach readers.${otherClasses(counts)} `
        + NOT_A_FIX,
      fix: reviewFix() };
  }
  if (found > 0) {
    return { status: 'ok', severity: 'info', readiness_state: 'degraded', details: { complete: true, ...base },
      message: `No held write is stranded by a rename.${otherClasses(counts)} Held: ${[examples(ordered, 'page_deleted'), examples(ordered, 'no_page')].filter(Boolean).join('; ')}. `
        + 'Nothing is leaking through these, and the check does not change them; gbrain trust review lists them.',
      fix: reviewFix() };
  }
  return { status: 'ok', details: { complete: true, ...base },
    message: `No held write names a page that is missing (${scan.scanned} held write(s) read).` };
}

/** What a throw from the scan means: a named result, never an empty one and never ok (except a schema that predates holds). */
function failure(error: unknown): Omit<Check, 'name'> {
  const unknown = { health: 'unknown', count: 'unknown' };
  if (isMissingSchemaObject(error, 'table', 'write_gate_holds')) {
    return { status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates the write gate, so there are no held writes.' };
  }
  if (isEngineCapabilityRefusal(error)) {
    return { status: 'warn', details: { ...unknown, reason: 'engine_capability_missing' }, fix_unavailable_reason: 'check_errored',
      message: 'gbrain could not check held writes for a renamed or removed page: this engine refused the raw SQL read (engine_capability_missing), so the count is unknown, not zero.' };
  }
  const { name: _name, ...rest } = checkError(NAME, 'check held writes for a renamed or removed page (the count is unknown, not zero)', error, { details: unknown });
  return rest;
}

async function runWriteGateHoldsStranded(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const scope = doctorSourceIds(ctx);
  if (scope && scope.length === 0) {
    checks.push({ name: 'write_gate_holds_stranded', status: 'ok', details: { complete: true, scanned: 0, stranded: zero(), by_source: {}, items: [] }, message: 'No sources are selected, so no held writes were read.' });
    return checks;
  }
  try {
    const scan = await scanHolds(connectedEngine(ctx), scope, ctx.entryDeadlineAt ?? Date.now() + DEFAULT_SCAN_MS);
    checks.push({ ...report(scan), name: 'write_gate_holds_stranded' });
  } catch (error) {
    checks.push({ ...failure(error), name: 'write_gate_holds_stranded' });
  }
  return checks;
}

export const writeGateHoldsStrandedEntry: DoctorEntry = { name: 'write_gate_holds_stranded', emits: ['write_gate_holds_stranded'], run: runWriteGateHoldsStranded };
