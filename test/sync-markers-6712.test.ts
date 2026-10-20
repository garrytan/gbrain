/**
 * #6712 PR 4b lane M (design v3.2 §2.5, §2.6): the marker and withheld-record helpers. Compare-and-delete retirement
 * keeps a marker rewritten since it was read; the withheld record round-trips with its samples capped; the delete-set
 * hash is order- and duplicate-free; the `purge:marker_written` seam fires after the marker insert of a purge. Real PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { clearDeletesWithheld, deleteSetHash, DELETES_WITHHELD_SAMPLES, readDeletesWithheld, readOriginDeletedMarker, retireOriginDeletedMarker,
  writeDeletesWithheld } from '../src/core/persistence/sync-markers.ts';
import { SYNC_ORIGIN_DELETED_OP } from '../src/core/persistence/sync-pass-row.ts';
import { installFaultHook, type FaultDetail } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';

describe('sync-markers helpers', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  const incarnation = randomUUID();
  const insertMarker = (value: Record<string, unknown>) => engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,jsonb_build_array($3::text::jsonb))
    ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys`, [SYNC_ORIGIN_DELETED_OP, `default:${incarnation}:notes/a.md`, JSON.stringify(value)]);

  test('retireOriginDeletedMarker deletes only the value it read', async () => {
    const read = { source_id: 'default', incarnation, kind: 'deleted', blob_oids: ['a'.repeat(40)], page_id: 1, slug: 'notes/a', at: '2026-10-01T00:00:00.000Z' };
    await insertMarker(read);
    expect(await readOriginDeletedMarker(engine, 'default', incarnation, 'notes/a.md')).toEqual(read as never);
    const rewritten = { ...read, blob_oids: ['b'.repeat(40)], page_id: 2, at: '2026-10-02T00:00:00.000Z' };
    await insertMarker(rewritten);
    expect(await retireOriginDeletedMarker(engine, { sourceId: 'default', incarnation, origin: 'notes/a.md', expected: read })).toBe(false);
    expect(await readOriginDeletedMarker(engine, 'default', incarnation, 'notes/a.md')).toEqual(rewritten as never);
    expect(await retireOriginDeletedMarker(engine, { sourceId: 'default', incarnation, origin: 'notes/a.md', expected: { ...rewritten } })).toBe(true);
    expect(await readOriginDeletedMarker(engine, 'default', incarnation, 'notes/a.md')).toBeNull();
    expect(await retireOriginDeletedMarker(engine, { sourceId: 'default', incarnation, origin: 'notes/a.md', expected: rewritten })).toBe(false);
  });

  test('the withheld record is written, refreshed, read and cleared per incarnation, with at most 20 samples', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `notes/n${String(i).padStart(2, '0')}.md`);
    const input = { sourceId: 'default', incarnation, target: 'c'.repeat(40), count: 30, reconcilable: 40, ratio: 0.75, set_hash: deleteSetHash(paths), samples: paths };
    const written = await writeDeletesWithheld(engine, input);
    expect(written.samples).toHaveLength(DELETES_WITHHELD_SAMPLES);
    expect(await readDeletesWithheld(engine, 'default', incarnation)).toEqual(written);
    expect(await readDeletesWithheld(engine, 'default', randomUUID())).toBeNull();
    const refreshed = await writeDeletesWithheld(engine, { ...input, count: 29, samples: paths.slice(1), set_hash: deleteSetHash(paths.slice(1)) });
    expect(await readDeletesWithheld(engine, 'default', incarnation)).toEqual(refreshed);
    expect(refreshed.source_id).toBe('default');
    expect(refreshed.incarnation).toBe(incarnation);
    expect(await clearDeletesWithheld(engine, 'default', incarnation)).toBe(true);
    expect(await readDeletesWithheld(engine, 'default', incarnation)).toBeNull();
    expect(await clearDeletesWithheld(engine, 'default', incarnation)).toBe(false);
  });

  test('deleteSetHash is sha256 over the sorted, NUL-joined set', () => {
    const expected = createHash('sha256').update('a.md\0b/c.md\0z.md').digest('hex');
    expect(deleteSetHash(['z.md', 'a.md', 'b/c.md'])).toBe(expected);
    expect(deleteSetHash(['b/c.md', 'z.md', 'a.md', 'z.md'])).toBe(expected);
    expect(deleteSetHash(['a.md', 'b/c.md'])).not.toBe(expected);
  });
});

test('purge:marker_written fires after the marker insert of a managed purge, naming the origin', () => managedBrain(async ({ engine, ctx, root }) => {
  expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  await engine.setConfig('sync.write_through', 'false');
  const seen: Array<{ point: string; detail: FaultDetail }> = [];
  installFaultHook((point, detail) => { if (point === 'purge:marker_written') seen.push({ point, detail }); });
  try {
    const snapshot = await engine.readPageSnapshot('notes/alpha', { sourceId: 'default' });
    const result = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/alpha', purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }, waitMs: 30_000 });
    expect(result.state).toBe('committed');
  } finally { installFaultHook(undefined); }
  expect(seen).toEqual([{ point: 'purge:marker_written', detail: { sourceId: 'default', slug: 'notes/alpha', path: 'notes/alpha.md' } }]);
  void root;
}, { setup: ({ root }) => {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const name of ['alpha', 'beta']) writeFileSync(join(root, 'notes', name + '.md'), `---\ntitle: ${name}\n---\n\nSynthetic ${name}.\n`);
  git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
} }), 120_000);
