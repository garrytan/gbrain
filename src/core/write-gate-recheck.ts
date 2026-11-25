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
 *  - Each held write is checked in its own short transaction that locks only that held row (`FOR UPDATE`) and no page.
 *    It is deleted only while it is still unbound, has no candidate list, still has the version a selected note
 *    recorded (a held write re-opened after the purge is a later write and stays), and no page row at all, live or
 *    soft-deleted, is at its slug or at a slug its rename record leads to. A soft-deleted page keeps it, so tombstone
 *    expiry still owns it.
 *  - Nothing is deleted when row security is active for the running role on any evidence table (it would read hidden
 *    rows as absent); the run reports a named unknown instead. A failed read aborts the run with no change.
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
  /** Test hook: runs after a held write's page check, before its delete, inside its transaction. */
  afterCheck?: (holdId: number) => Promise<void>;
}

const empty = (): HoldRecheckResult => ({ status: 'ok', checked: 0, deleted: 0, receipts: 0, kept: 0, notes_consumed: 0 });

/**
 * The off switch: unset or a truthy value keeps the sweep on. A failed read throws, so the sweep never runs against an
 * opt-out it could not read (the maintenance phase reports the failure).
 */
export async function orphanSweepEnabled(engine: BrainEngine): Promise<boolean> {
  return !/^\s*(false|0|off|no)\s*$/i.test(await engine.getConfig(ORPHAN_SWEEP_KEY) ?? '');
}

interface Note { id: string; source_id: string; hold_id: string; observed_version: string }

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
    `SELECT id::text AS id, source_id, hold_id::text AS hold_id, observed_version FROM write_gate_hold_rechecks
      WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY queued_at, id LIMIT $2`,
    [opts.sourceIds ? [...opts.sourceIds] : null, opts.limit ?? HOLD_RECHECK_LIMIT]);
  const byHold = new Map<string, { sourceId: string; holdId: number; ids: string[]; versions: Set<string> }>();
  for (const n of notes) {
    const key = `${n.source_id}\u0000${n.hold_id}`;
    if (!byHold.has(key)) byHold.set(key, { sourceId: n.source_id, holdId: Number(n.hold_id), ids: [], versions: new Set() });
    const g = byHold.get(key)!;
    g.ids.push(n.id);
    g.versions.add(n.observed_version);
  }
  if (opts.dryRun) return { ...out, would_check: byHold.size };

  for (const g of byHold.values()) {
    out.checked++;
    await engine.transaction(async (tx: BrainEngine) => {
      const [row] = await tx.executeRaw<{ page_id: string | null; marked: boolean; version: string }>(
        `SELECT h.page_id::text AS page_id, h.page_candidates IS NOT NULL AS marked, ${holdVersionSql('h')} AS version
           FROM write_gate_holds h WHERE h.id = $1 AND h.source_id = $2 FOR UPDATE`, [g.holdId, g.sourceId]);
      let orphan = false;
      if (row && row.page_id === null && !row.marked && g.versions.has(row.version)) {
        const [reach] = await tx.executeRaw<{ any: boolean }>(
          `SELECT EXISTS (${holdReachCte('h')} SELECT 1 FROM reach JOIN pages q ON q.source_id = h.source_id AND q.slug = reach.s) AS any
             FROM write_gate_holds h WHERE h.id = $1`, [g.holdId]);
        orphan = reach?.any === false;
      }
      await opts.afterCheck?.(g.holdId);
      if (orphan) {
        out.receipts += (await tx.executeRaw("DELETE FROM write_gate_receipts WHERE target_table = 'write_gate_holds' AND target_id = $1 RETURNING 1", [String(g.holdId)])).length;
        out.deleted += (await tx.executeRaw('DELETE FROM write_gate_holds WHERE id = $1 RETURNING 1', [g.holdId])).length;
      } else if (row) {
        out.kept++;
      }
      out.notes_consumed += (await tx.executeRaw('DELETE FROM write_gate_hold_rechecks WHERE id = ANY($1::bigint[]) RETURNING 1', [g.ids])).length;
    });
  }
  return out;
}
