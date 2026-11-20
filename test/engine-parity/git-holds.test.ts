/**
 * BrainEngine parity — the Git sync hold writes (batch 3 of the repair-on-Rust plan): swapGitHold, readGitHoldRecord and
 * requestGitHoldRetry, driven through the sync-holds.ts writers every repair and sync path uses.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), a hold inserted, re-held,
 *    re-coded and cleared leaves the same record and the same summary count and counters; a swap over a record the row no
 *    longer holds changes nothing; a newer run's hold is not replaced or cleared by an older run; a read-only mirror's hold
 *    reads with `read_only_checkout` placed in jsonb key order; a retry request keeps each path once in byte order; an
 *    import provenance record reads back as written.
 *  - Regression: every hold write ran its SQL through `executeRaw`, which a Rust brain refuses, so each repair apply that
 *    touches a hold stopped there. The retry request kept paths in database-collation order, and a mirror's
 *    `read_only_checkout` key was appended last on Postgres instead of placed in jsonb order.
 *  - Why existing coverage misses it: test/sync-holds-store.test.ts and the sync hold tests run on PGLite or Postgres only.
 *  - Seam: write times and incarnations are generated, so they are compared by shape.
 */
import { describe } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from '../../src/core/engine-sql/persistence-journal.ts';
import {
  GIT_HOLD_RETRY_OP, clearGitHold, gitHoldFingerprint, readGitHold, readSyncImportProvenance, recordSyncImportProvenance,
  requestGitHoldRetry, summaryFingerprint, writeGitHold, type GitHoldRecord,
} from '../../src/core/persistence/sync-holds.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** Generated stamps and incarnations by shape. */
const stamped = (value: unknown) => value == null ? value : JSON.parse(JSON.stringify(value).replace(ISO, '<ts>').replace(UUID, '<uuid>'));

type HoldInput = Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'>;
const hold = (sourceId: string, incarnation: string, path: string, observed: string, extra: Partial<HoldInput> = {}): HoldInput => ({
  source_id: sourceId, incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null, code: 'invalid_frontmatter',
  message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', upstream_version: `sha-${observed}`, observed_at: observed,
  run_id: 'run-1', mode: 'managed', meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: 1 }, ...extra,
});

async function summary(engine: BrainEngine, sourceId: string, incarnation: string) {
  const row = await engine.readOpCheckpointRecord(GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation));
  return row ? (row.completed_keys as unknown[])[0] : null;
}

describe('engine parity: Git sync holds', () => {
  parityTest('hold insert, re-hold, re-code and clear move the record and the summary alike on every engine', {
    methods: ['readSourceIncarnation', 'readOpCheckpointRecord', 'swapGitHold', 'readGitHoldRecord'],
  }, async (engine) => {
    const inc = (await engine.readSourceIncarnation('default'))!.incarnation;
    const steps: Record<string, unknown> = {};
    const snap = async (label: string, outcome: unknown) => {
      steps[label] = { outcome, record: stamped(await readGitHold(engine, 'default', inc, 'notes/a.md')), summary: stamped(await summary(engine, 'default', inc)) };
    };
    await snap('none', null);
    await snap('insert', await writeGitHold(engine, hold('default', inc, 'notes/a.md', '2026-01-01T00:00:00.000Z', { page_id: 7 })));
    await snap('again', await writeGitHold(engine, hold('default', inc, 'notes/a.md', '2026-01-02T00:00:00.000Z', { page_id: 7 })));
    await snap('older', await writeGitHold(engine, hold('default', inc, 'notes/a.md', '2025-12-31T00:00:00.000Z')));
    await snap('recode', await writeGitHold(engine, hold('default', inc, 'notes/a.md', '2026-01-03T00:00:00.000Z', { code: 'invalid_fence', page_id: null })));
    await writeGitHold(engine, hold('default', inc, 'notes/b.md', '2026-01-03T00:00:00.000Z', { code: 'worktree_dirty' }));
    // A swap over a record the row no longer holds changes nothing.
    const stale = [{ ...hold('default', inc, 'notes/a.md', '2026-01-01T00:00:00.000Z'), version: 1 }];
    const missed = await engine.swapGitHold({ sourceId: 'default', incarnation: inc, path: 'notes/a.md', prior: stale, next: null, summary: { count: -1, stale: 0, images: 0, fences: 0, concurrent: 0, stalled: 0, dirty: 0, drift: 0 } });
    await snap('missed', missed);
    await snap('older-clear', await clearGitHold(engine, { sourceId: 'default', incarnation: inc, path: 'notes/a.md', observedAt: '2026-01-01T00:00:00.000Z' }));
    await snap('clear', await clearGitHold(engine, { sourceId: 'default', incarnation: inc, path: 'notes/a.md', observedAt: '2026-01-04T00:00:00.000Z' }));
    await snap('clear-none', await clearGitHold(engine, { sourceId: 'default', incarnation: inc, path: 'notes/a.md', observedAt: '2026-01-05T00:00:00.000Z' }));
    const row = await engine.readGitHoldRecord('default', inc, 'notes/b.md');
    return { steps, b: row && { code: (row.record as { code: string }).code, mirror_read_only: row.mirror_read_only }, gone: await engine.readGitHoldRecord('default', inc, 'notes/a.md') };
  });

  parityTest('a read-only mirror hold, retry paths in byte order and import provenance read the same on every engine', {
    methods: ['insertSource', 'readSourceIncarnation', 'readOpCheckpointRecord', 'writeOpCheckpointRecord', 'swapGitHold', 'readGitHoldRecord', 'requestGitHoldRetry'],
  }, async (engine) => {
    await engine.insertSource({ id: 'mirror-example', name: 'mirror-example', local_path: null, config: { mirror_read_only: true } });
    const inc = (await engine.readSourceIncarnation('mirror-example'))!.incarnation;
    await writeGitHold(engine, hold('mirror-example', inc, 'm.md', '2026-01-01T00:00:00.000Z', { code: 'file_drift' }));
    const mirror = await readGitHold(engine, 'mirror-example', inc, 'm.md');
    const raw = await engine.readGitHoldRecord('mirror-example', inc, 'm.md');
    await requestGitHoldRetry(engine, 'mirror-example', inc, ['b.md', 'B.md', 'b.md', 'a/z.md']);
    await engine.requestGitHoldRetry('mirror-example', inc, ['a.md', 'b.md', 'Z.md'], '2026-01-02T00:00:00.000Z');
    const retry = await engine.readOpCheckpointRecord(GIT_HOLD_RETRY_OP, summaryFingerprint('mirror-example', inc));
    await recordSyncImportProvenance(engine, { source_id: 'mirror-example', incarnation: inc, page_id: 3, origin: 'm.md', raw_sha256: 'abc', gbrain_version: '0.0.0' });
    await engine.writeOpCheckpointRecord(GIT_HOLD_OP, gitHoldFingerprint('mirror-example', inc, 'empty.md'), []);
    return {
      mirrorKeys: Object.keys(mirror ?? {}),
      mirror: stamped(mirror),
      raw: raw && { mirror_read_only: raw.mirror_read_only, marked: 'read_only_checkout' in raw.record },
      retry: stamped((retry?.completed_keys as unknown[])[0]),
      provenance: stamped(await readSyncImportProvenance(engine, 'mirror-example', inc, 3)),
      noProvenance: await readSyncImportProvenance(engine, 'mirror-example', inc, 4),
      emptyHold: await engine.readGitHoldRecord('mirror-example', inc, 'empty.md'),
    };
  });
});
