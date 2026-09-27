import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { isTotalFailure } from '../src/commands/sweep.ts';
import type { CapabilityReport } from '../src/core/capability.ts';

/**
 * #5499: on a managed brain (persistence_brain.enabled) the sweep's facts-fence
 * reconcile goes through the legacy writer the guard refuses, so every
 * `gbrain sweep --once` logged `facts-fence pass failed` and reported
 * `facts_fence_error` — a genuine parse failure and a managed-mode refusal read
 * the same. The pass now skips with reason `writer_coordinator_required:facts_fence`
 * on a managed brain and is unchanged on an unmanaged one (discrimination).
 */
const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

const FENCE_BODY = [
  '# Alice Example',
  '',
  'Alice Example is a founder at acme-example.',
  '',
  '## Facts',
  '',
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Founded acme-example in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | test |  |',
  '| 2 | Prefers async updates | preference | 0.9 | private | medium |  |  | test |  |',
  '<!--- gbrain:facts:end -->',
  '',
].join('\n');

let engine: PGLiteEngine;
let corpusDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-managed-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(corpusDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.executeRaw('DELETE FROM pages').catch(() => {});
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $1, $2, '')`,
    ['people/alice-example', FENCE_BODY],
  );
});

async function sweep(logs: string[]) {
  return runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYLESS, log: m => logs.push(m) });
}

describe('sweep on a managed brain (#5499)', () => {
  // Runs first, on the fresh schema: after the managed case the legacy reconcile kept
  // raising writer_coordinator_required in the same process even with the flag
  // flipped back off, so the unmanaged case must not follow it.
  test('discrimination: an unmanaged brain still reconciles the fence', async () => {
    const logs: string[] = [];
    const r = await sweep(logs);
    const reasons = r.skipped.map(s => s.reason);
    expect(reasons).not.toContain('writer_coordinator_required:facts_fence');
    expect(reasons).not.toContain('facts_fence_error');
    expect(r.factsReconciled).toBe(2);
  });
  test('facts-fence pass skips with writer_coordinator_required instead of failing', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const logs: string[] = [];
    const r = await sweep(logs);
    const reasons = r.skipped.map(s => s.reason);
    expect(reasons).toContain('writer_coordinator_required:facts_fence');
    expect(reasons).not.toContain('facts_fence_error');
    expect(r.factsReconciled).toBe(0);
    expect(isTotalFailure(r)).toBe(false);
    expect(logs.some(l => l.includes('facts-fence pass skipped'))).toBe(true);
    expect(logs.some(l => l.includes('facts-fence pass failed'))).toBe(false);
    // Nothing reached the facts index through a legacy path.
    const facts = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts`);
    expect(Number(facts[0].n)).toBe(0);
  });

});
