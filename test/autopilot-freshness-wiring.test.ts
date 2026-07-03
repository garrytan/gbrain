/**
 * Freshness-guard wiring regression guards.
 *
 * The per-source freshness sync is submitted inline in the autopilot tick body,
 * so these are source-shape assertions (the proven `autopilot-*-wiring.test.ts`
 * pattern). The load-bearing behavior: the loop MUST NOT submit a `sync` job for
 * a source whose `local_path` doesn't exist on THIS pod (source cloned/synced
 * elsewhere → ~288 dead jobs/day in prod for source bart-allan), and the skip
 * must log once per source (not per tick), respecting a config.externally_synced
 * opt-out.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

// The freshness block runs first inside the dispatch try; slice from its marker
// to the auto-drain block so assertions can't accidentally match other code.
const FRESHNESS_BLOCK = SRC.slice(
  SRC.indexOf('per-source freshness check'),
  SRC.indexOf('per-source extract_atoms auto-drain'),
);

describe('autopilot freshness-guard wiring', () => {
  test('skips a source whose local_path is absent on this pod (existsSync guard)', () => {
    expect(FRESHNESS_BLOCK).toContain('existsSync(src.local_path)');
    // The guard must short-circuit the loop iteration.
    expect(FRESHNESS_BLOCK).toMatch(/existsSync\(src\.local_path\)[\s\S]{0,700}continue;/);
  });

  test('respects an externally_synced config flag on the source', () => {
    expect(FRESHNESS_BLOCK).toContain('externally_synced');
    expect(FRESHNESS_BLOCK).toContain('parseSourceConfig(src.config)');
  });

  test('logs the skip once per source, not once per tick', () => {
    // A module-level Set dedups; the guard checks membership before logging.
    expect(SRC).toContain('const freshnessSkipLogged = new Set<string>()');
    expect(FRESHNESS_BLOCK).toContain('freshnessSkipLogged.has(src.id)');
    expect(FRESHNESS_BLOCK).toContain('freshnessSkipLogged.add(src.id)');
  });

  test('skip happens BEFORE the sync job is queued (no dead job submitted)', () => {
    const guardIdx = FRESHNESS_BLOCK.indexOf('existsSync(src.local_path)');
    const addIdx = FRESHNESS_BLOCK.indexOf("queue.add(\n");
    // Fall back to a looser marker if formatting differs.
    const queueIdx = addIdx >= 0 ? addIdx : FRESHNESS_BLOCK.indexOf('queue.add(');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(guardIdx);
  });

  test('still guards the pre-existing pure-DB source case (!src.local_path)', () => {
    expect(FRESHNESS_BLOCK).toContain('if (!src.local_path) continue;');
  });
});
