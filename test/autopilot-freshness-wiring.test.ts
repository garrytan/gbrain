/**
 * v0.42.x — autopilot freshness sync wiring guards.
 *
 * The per-source sync dispatch lives inline in runAutopilot(), so use the same
 * source-shape test pattern as the other autopilot wiring guards. The load-
 * bearing regression is maxWaiting: if it comes back, every source-specific
 * sync submit can collapse into one waiting job.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'), 'utf8');

describe('autopilot freshness sync wiring', () => {
  test('uses a per-source idempotency key', () => {
    expect(SRC).toContain('autopilot-sync:${src.id}:${slot}');
  });

  test('threads each source local_path into the sync job payload', () => {
    expect(SRC).toMatch(/sourceId:\s*src\.id[\s\S]{0,200}repoPath:\s*src\.local_path/);
  });

  test('does not pass maxWaiting on freshness sync submits', () => {
    const start = SRC.indexOf("'sync'");
    expect(start).toBeGreaterThan(-1);
    const freshnessBlock = SRC.slice(start, start + 900);
    expect(freshnessBlock).not.toMatch(/\bmaxWaiting\s*:/);
  });
});
