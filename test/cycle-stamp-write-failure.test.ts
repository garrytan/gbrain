/**
 * #3504 — a cycle that cannot persist its freshness stamp must stop reporting
 * success.
 *
 * Before this, `updateSourceConfig` throwing was a `console.warn` and nothing
 * else. `gbrain dream --json` reported `status: 'ok'`, doctor separately
 * reported `cycle_freshness` stale, and no signal connected them — so the fix
 * doctor recommends (re-run the cycle) could never work, because the cycle was
 * already succeeding. That is the loop #2251 sat in while every stamp write
 * failed on a corrupted `sources.config`.
 *
 * Contract pinned here:
 *   - a stamp-write error sets `stamp_write_failed: {source_id, error}`
 *   - it degrades 'ok' / 'clean' to 'partial' and sets reason 'stamp_write_failed'
 *   - it NEVER throws out of runCycle (the phases already did their work)
 *   - a pack that merely omits optional phases is NOT affected: those phases come
 *     back 'skipped', `deriveStatus` ignores them by design, and the status stays
 *     a success status. This is the conflation the maintainer flagged on #3504.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let brainDir: string;
// Per-test GBRAIN_HOME isolation: the PGLite cycle path takes a file lock at
// `~/.gbrain/cycle.lock`, unscoped by source. Without isolation, a sibling
// worktree running its own tests makes runCycle return 'skipped' and the stamp
// hook silently no-ops. Same rationale as cycle-last-full-cycle-at.test.ts.
let gbrainHome: string;

const SOURCE = 'stamp-fail-src';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-stamp-brain-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-stamp-home-'));
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::text::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE, 'Stamp Fail Source', '{}'],
  );
});

/** Run a per-source cycle with updateSourceConfig forced to throw. */
async function runWithFailingStamp(message: string) {
  const original = engine.updateSourceConfig.bind(engine);
  let calls = 0;
  (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = async () => {
    calls += 1;
    throw new Error(message);
  };
  try {
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir, sourceId: SOURCE, phases: ['lint'] }),
    );
    return { report, calls };
  } finally {
    (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = original;
  }
}

describe('#3504 stamp-write failure is surfaced on the report', () => {
  test('sets stamp_write_failed with the source id and the error message', async () => {
    const { report, calls } = await runWithFailingStamp('jsonb_each on a non-object');
    expect(calls).toBeGreaterThan(0);
    expect(report.stamp_write_failed).toBeDefined();
    expect(report.stamp_write_failed!.source_id).toBe(SOURCE);
    expect(report.stamp_write_failed!.error).toContain('jsonb_each on a non-object');
  });

  test('degrades a successful status to partial with reason stamp_write_failed', async () => {
    const { report } = await runWithFailingStamp('write blew up');
    expect(report.status).toBe('partial');
    expect(report.reason).toBe('stamp_write_failed');
  });

  test('does NOT throw out of runCycle — the phases already ran', async () => {
    const { report } = await runWithFailingStamp('write blew up');
    // The run still produced a report with its phase results intact.
    expect(report.schema_version).toBe('1');
    expect(report.phases.length).toBeGreaterThan(0);
  });
});

describe('#3504 no false positives', () => {
  test('a healthy per-source cycle has no stamp_write_failed and keeps a success status', async () => {
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir, sourceId: SOURCE, phases: ['lint'] }),
    );
    expect(report.stamp_write_failed).toBeUndefined();
    expect(report.reason).toBeUndefined();
    expect(['ok', 'clean']).toContain(report.status);
  });

  test('a pack that omits optional phases is not conflated with a stamp failure', async () => {
    // The distinction the maintainer called out on #3504: `deriveStatus`
    // deliberately ignores 'skipped' phases, so omitting optional phases is not
    // a failure. Only a real write error may degrade the status.
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir, sourceId: SOURCE, phases: ['lint'] }),
    );
    const skipped = report.phases.filter((p) => p.status === 'skipped');
    // Whether or not any phase skipped in this environment, the invariant holds:
    // a success status must not carry a stamp-failure marker.
    expect(report.stamp_write_failed).toBeUndefined();
    if (skipped.length > 0) {
      expect(['ok', 'clean']).toContain(report.status);
    }
  });

  test('dryRun does not attempt the write and cannot report a stamp failure', async () => {
    const original = engine.updateSourceConfig.bind(engine);
    let called = false;
    (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = async () => {
      called = true;
      throw new Error('should never run under dryRun');
    };
    try {
      const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        runCycle(engine, { brainDir, sourceId: SOURCE, phases: ['lint'], dryRun: true }),
      );
      expect(called).toBe(false);
      expect(report.stamp_write_failed).toBeUndefined();
    } finally {
      (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = original;
    }
  });

  test('a legacy caller with no sourceId cannot report a stamp failure', async () => {
    const original = engine.updateSourceConfig.bind(engine);
    (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = async () => {
      throw new Error('should never run without sourceId');
    };
    try {
      const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        runCycle(engine, { brainDir, phases: ['lint'] }),
      );
      expect(report.stamp_write_failed).toBeUndefined();
    } finally {
      (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = original;
    }
  });
});
