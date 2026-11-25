/**
 * write_gate_holds_stranded: a held write (a fact or take the write gate quarantined) is held for a page, and the hold
 * remembers that page by id (`write_gate_holds.page_id`; see write-gate-binding.ts). A rename (sync Git renames,
 * `gbrain repair rename-identity`) leaves a bound hold on its page, and an unbound hold (one recorded before any page had
 * its name) is matched through the same source's rename record, so neither is lifted by a rename. This check finds the
 * holds that no live page matches under the readers' own rule (`holdAppliesToPageSql`), and it ignores every hold that
 * does. Read-only: the one next action is the read-only `gbrain trust review`, which lists the held writes.
 *
 * What is counted: held rows (`status = 'held'`, non-empty slug) in the selected sources that no live page matches.
 * Each hold is counted once, in the first class that fits:
 *   - page_deleted: a page the hold applies to (its bound page, a candidate page, or a page its slug leads to) exists but
 *     is soft-deleted;
 *   - no_page: no page at all for it (for example a write held before its page exists). Informational.
 * Neither class means held text is leaking: the hold is simply not holding anything a reader can reach.
 *
 * Bounded: held rows are read in `(source_id, id)` keyset batches on the `(status, source_id, id)` index, projecting
 * only id, kind, source and slug. The row budget counts held rows before any slug, page or rename filtering. When
 * the scan stops at the budget (an extra-row probe tells a full read from a cut one) or at its deadline, the check
 * warns that the count is unknown. An evidence table that cannot be read is unknown too, never an empty answer, and
 * so is any relation with row security active for the role (it would read as zero rows, and policies are not judged),
 * checked before anything is read. The page lookup reaches `pages` by its primary key (a bound or candidate page) or by
 * its `(source_id, slug)` key for the slugs the hold's own slug leads to, resolved first.
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
import { holdAppliesToPageSql, holdReachCte } from '../../../core/write-gate-binding.ts';
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

type HoldClass = 'page_deleted' | 'no_page';
type Counts = Record<HoldClass, number>;
interface Item { hold_ref: string; kind: string; source_id: string; slug: string; class: HoldClass }
interface Scan { scanned: number; stopped: 'row_limit' | 'deadline' | null; items: Item[]; hidden: string[] }

interface HoldRow { hold_id: string; kind: string; source_id: string; slug: string }
interface Verdict { id: string; page_deleted: boolean }

const zero = (): Counts => ({ page_deleted: 0, no_page: 0 });

function readHolds(engine: BrainEngine, scope: string[] | undefined, after: { source: string; id: string }, limit: number): Promise<HoldRow[]> {
  return engine.executeRaw<HoldRow>(
    `SELECT id::text AS hold_id, kind, source_id, slug FROM write_gate_holds
      WHERE status = 'held' AND ($1::text[] IS NULL OR source_id = ANY($1::text[])) AND (source_id, id) > ($2::text, $3::bigint)
      ORDER BY source_id, id LIMIT $4`,
    [scope ?? null, after.source, after.id, limit]);
}

/**
 * The holds of one batch that no live page matches, and whether a soft-deleted page is among the pages they apply to.
 * A hold's pages are resolved first: its bound page by id, its candidate pages by id, and for an unbound hold the pages
 * at the slugs its own slug leads to (the rename record, chains followed, probed by the `(source_id, slug)` key). Each is
 * then judged by the readers' own rule, so this check and the readers cannot disagree about what a hold protects.
 */
function readVerdicts(engine: BrainEngine, rows: HoldRow[]): Promise<Verdict[]> {
  return engine.executeRaw<Verdict>(
    `WITH h AS (SELECT w.id, w.source_id, w.slug, w.page_id, w.page_candidates FROM write_gate_holds w WHERE w.id = ANY($1::text[]::bigint[])),
          hp AS (
            SELECT h.id AS hid, p.id AS pid, p.slug AS pslug, p.deleted_at FROM h JOIN pages p ON p.id = h.page_id
            UNION
            SELECT h.id, p.id, p.slug, p.deleted_at FROM h CROSS JOIN LATERAL unnest(h.page_candidates) AS c(id) JOIN pages p ON p.id = c.id WHERE h.page_id IS NULL
            UNION
            SELECT h.id, p.id, p.slug, p.deleted_at FROM h
              CROSS JOIN LATERAL (${holdReachCte('h')} SELECT reach.s FROM reach) r
              CROSS JOIN LATERAL (SELECT q.id, q.slug, q.deleted_at FROM pages q WHERE q.source_id = h.source_id AND q.slug = r.s OFFSET 0) p
             WHERE h.page_id IS NULL),
          m AS (SELECT hp.hid, hp.deleted_at, (hp.deleted_at IS NULL AND ${holdAppliesToPageSql('h', 'hp.pid', 'hp.pslug')}) AS applies
                  FROM hp JOIN h ON h.id = hp.hid)
     SELECT h.id::text AS id, COALESCE(bool_or(m.deleted_at IS NOT NULL), false) AS page_deleted
       FROM h LEFT JOIN m ON m.hid = h.id
      GROUP BY h.id
     HAVING NOT COALESCE(bool_or(m.applies), false)`,
    [rows.map(r => r.hold_id)]);
}

/**
 * The evidence relations whose rows this role may not see in full. Row-level security gives a role without a policy
 * zero rows, not an error, and a policy can hide any subset, so a clean read proves nothing. This fails closed and
 * judges no policy: a relation counts as hidden whenever row security is active for the running role on it (the table
 * has row security on and the role is not its owner, not a superuser and has no BYPASSRLS). Only an exempt role, or a
 * table without row security, is fully visible.
 */
async function hiddenEvidence(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ rel: string }>(
    `SELECT t.rel FROM unnest(ARRAY['write_gate_holds', 'slug_aliases', 'slug_rename_history', 'pages']) WITH ORDINALITY AS t(rel, n)
      WHERE pg_catalog.to_regclass(t.rel) IS NOT NULL AND pg_catalog.row_security_active(pg_catalog.to_regclass(t.rel))
      ORDER BY t.n`);
  return rows.map(r => r.rel);
}

async function scanHolds(engine: BrainEngine, scope: string[] | undefined, deadlineAt: number): Promise<Scan> {
  const items: Item[] = [];
  const hidden = await hiddenEvidence(engine);
  if (hidden.length) return { scanned: 0, stopped: null, items, hidden };
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
        const cls: HoldClass = v.page_deleted ? 'page_deleted' : 'no_page';
        items.push({ hold_ref: `h${hold.hold_id}`, kind: hold.kind, source_id: hold.source_id, slug: hold.slug, class: cls });
      }
    }
    if (rows.length < want) break;
    const last = rows[rows.length - 1]!;
    after = { source: last.source_id, id: last.hold_id };
  }
  return { scanned, stopped, items, hidden };
}

const NEXT_STEP = 'This check only detects and changes nothing. The one next step is the read-only gbrain trust review, which lists the held writes.';

const reviewFix = () => agentFix(['gbrain', 'trust', 'review'],
  'Lists the held writes with their pages, read-only; it releases and drops nothing.', NAME);

function describeItem(i: Item): string {
  return `${i.hold_ref} (${i.source_id}/${i.slug})`;
}

function examples(items: Item[], cls: HoldClass): string {
  const of = items.filter(i => i.class === cls);
  return `${of.slice(0, MESSAGE_CAP).map(describeItem).join('; ')}${of.length > MESSAGE_CAP ? `; and ${of.length - MESSAGE_CAP} more` : ''}`;
}

function tally(items: Item[]): { counts: Counts; bySource: Record<string, Counts> } {
  const counts = zero();
  // A Map: a source id such as `constructor` must not meet an inherited property.
  const sources = new Map<string, Counts>();
  for (const i of items) {
    counts[i.class]++;
    if (!sources.has(i.source_id)) sources.set(i.source_id, zero());
    sources.get(i.source_id)![i.class]++;
  }
  return { counts, bySource: Object.fromEntries(sources) };
}

function otherClasses(counts: Counts): string {
  const parts = [
    counts.page_deleted ? `${counts.page_deleted} are held for a soft-deleted page` : '',
    counts.no_page ? `${counts.no_page} are held for no page that exists (for example a write held before its page exists)` : '',
  ].filter(Boolean);
  return parts.length ? ` Informational: ${parts.join('; ')}.` : '';
}

function report(scan: Scan): Omit<Check, 'name'> {
  if (scan.hidden.length) {
    return { status: 'warn', details: { health: 'unknown', reason: 'row_level_security', count: 'unknown', complete: false, hidden_tables: scan.hidden },
      fix_unavailable_reason: 'operator_judgement',
      message: `gbrain could not check whether a live page holds each held write: row-level security hides ${scan.hidden.join(', ')} from this database role, so what it would read is incomplete and the count is unknown, not zero. `
        + 'Row security is active for this role on them, and gbrain does not judge policies. Run gbrain as the table owner, or as a role that bypasses row security. Nothing was read and nothing was changed.' };
  }
  const ordered = scan.items;
  const { counts, bySource } = tally(ordered);
  const base = { scanned: scan.scanned, stranded: counts, by_source: bySource, items: ordered.slice(0, ITEM_CAP), items_truncated: ordered.length > ITEM_CAP,
    row_budget: ROW_BUDGET };
  const found = counts.page_deleted + counts.no_page;
  if (scan.stopped) {
    const why = scan.stopped === 'row_limit' ? `the row limit of ${ROW_BUDGET} held writes` : 'its time limit';
    return { status: 'warn', details: { ...boundUnknownDetails(scan.stopped), complete: false, scanned: scan.scanned, found_so_far: counts, by_source: bySource,
        items: ordered.slice(0, ITEM_CAP), items_truncated: ordered.length > ITEM_CAP, row_budget: ROW_BUDGET },
      message: `gbrain could not count the held writes that no live page holds: the scan stopped at ${why} after reading ${scan.scanned} held write(s). `
        + `${found ? `Found so far: at least ${found} that no live page holds.${otherClasses(counts)}` : 'None were found in the part it read.'} `
        + `The total is unknown, not zero. ${NEXT_STEP}`,
      fix: reviewFix() };
  }
  if (found > 0) {
    return { status: 'ok', severity: 'info', readiness_state: 'degraded', details: { complete: true, ...base },
      message: `No held write is lifted by a rename: holds follow their page.${otherClasses(counts)} Held: ${[examples(ordered, 'page_deleted'), examples(ordered, 'no_page')].filter(Boolean).join('; ')}. `
        + 'Nothing is leaking through these, and the check does not change them; gbrain trust review lists them.',
      fix: reviewFix() };
  }
  return { status: 'ok', details: { complete: true, ...base },
    message: `No held write is without a live page (${scan.scanned} held write(s) read).` };
}

/** What a throw from the scan means: a named result, never an empty one and never ok (except a schema that predates holds). */
function failure(error: unknown): Omit<Check, 'name'> {
  const unknown = { health: 'unknown', count: 'unknown' };
  if (isMissingSchemaObject(error, 'table', 'write_gate_holds')) {
    return { status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates the write gate, so there are no held writes.' };
  }
  if (isEngineCapabilityRefusal(error)) {
    return { status: 'warn', details: { ...unknown, reason: 'engine_capability_missing' }, fix_unavailable_reason: 'check_errored',
      message: 'gbrain could not check whether a live page holds each held write: this engine refused the raw SQL read (engine_capability_missing), so the count is unknown, not zero.' };
  }
  const { name: _name, ...rest } = checkError(NAME, 'check whether a live page holds each held write (the count is unknown, not zero)', error, { details: unknown });
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
