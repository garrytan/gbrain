/**
 * Operator pause marker for the facts.fence reconciliation path.
 *
 * While `<gbrain home>/operator-pauses/facts-fence.pause` exists,
 * runExtractFacts must return before touching the engine, with a single
 * operator_pause warning and zero page scans, inserts or deletes. The engine
 * is a stub that throws on any access, which proves the early return.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { withEnv } from './helpers/with-env.ts';

const throwingEngine = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`engine touched while paused: ${String(prop)}`);
  },
}) as any;

describe('extract_facts operator pause marker', () => {
  test('marker present: returns early with operator_pause warning and no engine access', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-pause-'));
    try {
      mkdirSync(join(home, '.gbrain', 'operator-pauses'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'operator-pauses', 'facts-fence.pause'), 'paused by test\n');
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const result = await runExtractFacts(throwingEngine, { sourceId: 'default' });
        expect(result.pagesScanned).toBe(0);
        expect(result.factsInserted).toBe(0);
        expect(result.factsDeleted).toBe(0);
        expect(result.warnings.length).toBe(1);
        expect(result.warnings[0]).toStartWith('operator_pause: extract_facts skipped while ');
        expect(result.warnings[0]).toContain('facts-fence.pause');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('marker absent: the guard does not short-circuit (engine is reached)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-nopause-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(runExtractFacts(throwingEngine, { sourceId: 'default' }))
          .rejects.toThrow(/engine touched while paused/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
