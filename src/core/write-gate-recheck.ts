/**
 * The maintenance sweep for held writes a purge kept for another page (`write_gate_hold_rechecks`, written by the purge
 * statements through `noteKeptHoldsCte` in write-gate-binding.ts). Two pages an unbound held write reaches, purged side
 * by side, each keep it for the other; this sweep, run by the `bookkeeping_gc` maintenance phase, checks the noted held
 * writes again and deletes the ones no page row is left for, with their receipts.
 *
 * Safety rules:
 *  - Only noted held writes are checked. A held write saved before its page exists is never noted, so it is never
 *    removed here.
 *  - The notes are read once, bounded and oldest first, and only those exact note ids are consumed, so a note another
 *    purge appends during the run stays for the next run.
 *  - Each held write is checked in its own short transaction that locks only that held row (`FOR UPDATE`) and no page
 *    key (`gbrain trust release` locks the held row before page keys, so taking page keys first here could deadlock with
 *    it). It is deleted only while it is still unbound, has no candidate list, still has the version a selected note
 *    recorded (a held write re-opened after the purge is a later write and stays), no page row at all, live or
 *    soft-deleted, is at a slug it reaches, and no page a note recorded as kept for still exists (a purge's scrub of the
 *    rename record can cut the route to it). A soft-deleted page keeps it, so tombstone expiry still owns it.
 *  - Known limits: a rename onto a name the held write reaches that commits between the page check and the delete (no
 *    page-key lock is held) does not stop the delete; that removes stale over-hiding from the arriving page and shows no
 *    held text. A note's surviving page ids go with the note once the sweep keeps the held write, so on rename history
 *    that is not flat a later purge of that page can leave the held write, as before this sweep existed.
 *  - Nothing is deleted when row security is active for the running role on any evidence table (it would read hidden
 *    rows as absent): the run reports a named unknown instead, and each transaction sets `row_security = off`, so a
 *    read row security would filter fails instead. A failed read aborts the run with no change.
 *  - Hold ids stay text end to end (a bigint past 2^53 is never rounded).
 *  - An engine without raw SQL (the optional Rust engine) reports skipped with `engine_capability_missing`.
 */
import type { BrainEngine } from './engine.ts';
import { isEngineCapabilityRefusal } from './engine-capability-refusal.ts';
import { holdReachCte, holdVersionSql } from './write-gate-binding.ts';

/** Notes one run reads at most. */
export const HOLD_RECHECK_LIMIT = 500;
/** Off switch (default on): only an explicit falsy value skips the sweep. */
export const ORPHAN_SWEEP_KEY = 'write_gate.orphan_sweep';
/** The relations the sweep's absence check reads or writes; row security on any of them stops it. */
const EVIDENCE = ['write_gate_holds', 'write_gate_receipts', 'write_gate_hold_rechecks', 'pages', 'slug_aliases', 'slug_rename_history'] as const;

export interface HoldRecheckResult {
  status: 'ok' | 'skipped' | 'unknown';
  reason?: 'disabled' | 'pre_schema' | 'engine_capability_missing' | 'row_level_security';
  /** Held writes checked (distinct held rows the selected notes name). */
  checked: number;
  /** Held writes deleted, and their receipts. */
  deleted: number;
  receipts: number;
  /** Held writes kept: a page row is left for them, they are bound or marked, or they changed after the note. */
  kept: number;
  notes_consumed: number;
  /** Dry run: the held writes a run would check. */
  would_check?: number;
  /** Row security: the evidence relations hidden from this role. */
  hidden?: string[];
}

export interface HoldRecheckOptions {
  dryRun?: boolean;
  limit?: number;
  /** Only notes of these sources (tests; maintenance passes none). */
  sourceIds?: readonly string[];
  /** Test hooks: at the start of a held write's transaction, and after its page check, before its delete. */
  beforeHold?: (holdId: string) => Promise<void>;
  afterCheck?: (holdId: string) => Promise<void>;
}

const empty = (): HoldRecheckResult => ({ status: 'ok', checked: 0, deleted: 0, receipts: 0, kept: 0, notes_consumed: 0 });

interface Group { sourceId: string; holdId: string; ids: string[]; versions: Set<string>; survivors: Set<string> }

/** The slugs held write `holdId` reaches (its own slug and the rename record's chain from it), sorted. */
async function reachedSlugs(tx: BrainEngine, g: Group): Promise<string[]> {
  return (await tx.executeRaw<{ s: string }>(
    `SELECT DISTINCT r.s FROM write_gate_holds h CROSS JOIN LATERAL (${holdReachCte('h')} SELECT reach.s FROM reach) r
      WHERE h.id = $1::bigint AND h.source_id = $2 ORDER BY r.s`, [g.holdId, g.sourceId])).map(r => r.s);
}

/**
 * The off switch: unset or a truthy value keeps the sweep on. A failed read throws, so the sweep never runs against an
 * opt-out it could not read (the maintenance phase reports the failure).
 */
export async function orphanSweepEnabled(engine: BrainEngine): Promise<boolean> {
  return !/^\s*(false|0|off|no)\s*$/i.test(await engine.getConfig(ORPHAN_SWEEP_KEY) ?? '');
}

interface Note { id: string; source_id: string; hold_id: string; observed_version: string; survivor_ids: string[] | null }

export async function sweepHoldRechecks(engine: BrainEngine, opts: HoldRecheckOptions = {}): Promise<HoldRecheckResult> {
  const out = empty();
  let present: boolean;
  try {
    present = (await engine.executeRaw<{ ok: boolean }>("SELECT pg_catalog.to_regclass('write_gate_hold_rechecks') IS NOT NULL AS ok"))[0]?.ok === true;
  } catch (error) { // capability-refusal-ok: a raw-SQL refusal becomes the typed skipped result naming it, never an empty sweep.
    if (isEngineCapabilityRefusal(error)) return { ...out, status: 'skipped', reason: 'engine_capability_missing' };
    throw error;
  }
  if (!present) return { ...out, status: 'skipped', reason: 'pre_schema' };
  const hidden = (await engine.executeRaw<{ rel: string }>(
    `SELECT t.rel FROM unnest($1::text[]) WITH ORDINALITY AS t(rel, n)
      WHERE pg_catalog.to_regclass(t.rel) IS NOT NULL AND pg_catalog.row_security_active(pg_catalog.to_regclass(t.rel))
      ORDER BY t.n`, [[...EVIDENCE]])).map(r => r.rel);
  if (hidden.length) return { ...out, status: 'unknown', reason: 'row_level_security', hidden };

  const notes = await engine.executeRaw<Note>(
    `SELECT id::text AS id, source_id, hold_id::text AS hold_id, observed_version, survivor_ids::text[] AS survivor_ids FROM write_gate_hold_rechecks
      WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY queued_at, id LIMIT $2`,
    [opts.sourceIds ? [...opts.sourceIds] : null, opts.limit ?? HOLD_RECHECK_LIMIT]);
  const byHold = new Map<string, Group>();
  for (const n of notes) {
    const key = `${n.source_id}\u0000${n.hold_id}`;
    if (!byHold.has(key)) byHold.set(key, { sourceId: n.source_id, holdId: n.hold_id, ids: [], versions: new Set(), survivors: new Set() });
    const g = byHold.get(key)!;
    g.ids.push(n.id);
    g.versions.add(n.observed_version);
    for (const id of n.survivor_ids ?? []) g.survivors.add(id);
  }
  if (opts.dryRun) return { ...out, would_check: byHold.size };

  for (const g of byHold.values()) {
    out.checked++;
    // A transaction callback may run more than once (the multi-user Rust engine retries it after a write conflict): the callback returns its counts and only the committed run's are added.
    const counted = await engine.transaction(async (tx: BrainEngine) => {
      const n = { receipts: 0, deleted: 0, kept: 0, notes_consumed: 0 };
      await opts.beforeHold?.(g.holdId);
      await tx.executeRaw('SET LOCAL row_security = off');
      const [row] = await tx.executeRaw<{ page_id: string | null; marked: boolean; version: string }>(
        `SELECT h.page_id::text AS page_id, h.page_candidates IS NOT NULL AS marked, ${holdVersionSql('h')} AS version
           FROM write_gate_holds h WHERE h.id = $1::bigint AND h.source_id = $2 FOR UPDATE`, [g.holdId, g.sourceId]);
      const slugs = row ? await reachedSlugs(tx, g) : [];
      let orphan = false;
      if (row && row.page_id === null && !row.marked && g.versions.has(row.version)) {
        const [seen] = await tx.executeRaw<{ any: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pages q WHERE q.source_id = $1 AND q.slug = ANY($2::text[]))
               OR EXISTS (SELECT 1 FROM pages q WHERE q.id = ANY($3::text[]::bigint[])) AS any`, [g.sourceId, slugs, [...g.survivors]]);
        orphan = seen?.any === false;
      }
      await opts.afterCheck?.(g.holdId);
      if (orphan) {
        n.receipts += (await tx.executeRaw("DELETE FROM write_gate_receipts WHERE target_table = 'write_gate_holds' AND target_id = $1 RETURNING 1", [g.holdId])).length;
        n.deleted += (await tx.executeRaw('DELETE FROM write_gate_holds WHERE id = $1::bigint RETURNING 1', [g.holdId])).length;
      } else if (row) {
        n.kept++;
      }
      n.notes_consumed += (await tx.executeRaw('DELETE FROM write_gate_hold_rechecks WHERE id = ANY($1::text[]::bigint[]) RETURNING 1', [g.ids])).length;
      return n;
    });
    out.receipts += counted.receipts; out.deleted += counted.deleted; out.kept += counted.kept; out.notes_consumed += counted.notes_consumed;
  }
  return out;
}
