/**
 * #6712 PR 4b lane M (design v3.2 §3.4, eng-outside F9): the checkpoint GC keeps the managed-sync pass row, the
 * deletion markers, the withheld mass-delete record and the cost reservations of a live source incarnation past the
 * TTL, and collects the same rows of a retired incarnation. Real PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { SYNC_PASS_ROW_OPS } from '../src/core/persistence/sync-pass-row.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('GC keeps live-incarnation pass, marker, withheld and cost rows past the TTL and drops a retired incarnation\'s', async () => {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  const live = source!.incarnation, retired = randomUUID();
  const fingerprint = (op: string, incarnation: string) => op === 'sync-origin-deleted' ? `default:${incarnation}:notes/a.md`
    : op === 'sync-pass-cost' ? `default:${incarnation}:episode:group` : `default:${incarnation}`;
  for (const incarnation of [live, retired]) for (const op of SYNC_PASS_ROW_OPS) {
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now() - interval '30 days')`,
      [op, fingerprint(op, incarnation), JSON.stringify({ source_id: 'default', incarnation })]);
  }
  expect(SYNC_PASS_ROW_OPS).toEqual(['managed-sync-pass', 'sync-origin-deleted', 'sync-deletes-withheld', 'sync-pass-cost']);
  await purgeStaleCheckpoints(engine, 7);
  const rows = await engine.executeRaw<{ op: string; incarnation: string }>(`SELECT op, completed_keys->0->>'incarnation' AS incarnation FROM op_checkpoints
    WHERE op = ANY($1::text[]) ORDER BY op`, [[...SYNC_PASS_ROW_OPS]]);
  expect(rows.filter(row => row.incarnation === live).map(row => row.op).sort()).toEqual([...SYNC_PASS_ROW_OPS].sort());
  expect(rows.filter(row => row.incarnation === retired)).toEqual([]);
}, 60_000);

test('GC keeps the sync.admission set_at row past the TTL (lane S: doctor age and effective read it)', async () => {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('sync-admission','brain',jsonb_build_array('{"value":"imports_only","set_at":"2026-01-01T00:00:00Z"}'::jsonb),now() - interval '30 days')`);
  await purgeStaleCheckpoints(engine, 7);
  const rows = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='sync-admission' AND fingerprint='brain'");
  expect(rows.length).toBe(1);
}, 60_000);

