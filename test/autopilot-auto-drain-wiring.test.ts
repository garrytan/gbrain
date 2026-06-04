/**
 * #1685 GAP D — autopilot auto-drain wiring regression guards.
 *
 * The submission is inline in the autopilot tick body, so these are
 * source-shape assertions (the proven `autopilot-*-wiring.test.ts` pattern).
 * The load-bearing one is CODEX #2: the idempotency key MUST carry a time slot,
 * else queue.add returns the first completed job forever and the source never
 * drains again.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

describe('autopilot auto-drain wiring', () => {
  test('CODEX #2: idempotency key includes a UTC-day time slot (not static)', () => {
    expect(SRC).toContain('autopilot-extract-atoms-drain:${src.id}:${utcDay}');
    // A static key would be the regression — guard against the bare form.
    expect(SRC).not.toContain('`autopilot-extract-atoms-drain:${src.id}`');
  });

  test('CODEX #1: submits with allowProtectedSubmit', () => {
    expect(SRC).toMatch(/extract-atoms-drain[\s\S]{0,800}allowProtectedSubmit: true/);
  });

  test('CODEX #3: enumerates sources and counts backlog per source', () => {
    expect(SRC).toContain('loadAllSources(engine)');
    expect(SRC).toContain('countExtractAtomsBacklog(engine, src.id)');
  });

  test('gates on pack NOT declaring extract_atoms (the silent-backlog condition)', () => {
    expect(SRC).toContain("packDeclaresPhase(engine, 'extract_atoms')");
  });

  test('gates on the enabled flag and a daily spend cap (DECISION 3C)', () => {
    expect(SRC).toContain('autopilot.auto_drain.enabled');
    expect(SRC).toContain('autopilot.auto_drain.max_usd_per_day');
    expect(SRC).toContain('maxJobsToday');
  });

  test('is Postgres-gated (PGLite has no worker surface)', () => {
    expect(SRC).toMatch(/engine\.kind === 'postgres'[\s\S]{0,400}auto_drain/);
  });

  test('CODEX impl #4: no maxWaiting (it coalesces by name+queue, not source)', () => {
    // maxWaiting would return source A's waiting job for source B's submit,
    // never queuing B and over-counting the cap. The per-source idempotency key
    // is the dedup; a pre-check on it avoids counting idempotency-hit re-submits.
    const drainBlock = SRC.slice(SRC.indexOf("'extract-atoms-drain'"));
    expect(drainBlock.slice(0, 900)).not.toContain('maxWaiting');
    expect(SRC).toContain('WHERE idempotency_key = $1 LIMIT 1');
  });
});
