/**
 * v0.42.x — autopilot freshness sync wiring guards.
 *
 * The per-source sync dispatch lives inline in runAutopilot(), so use the same
 * source-shape test pattern as the other autopilot wiring guards. The
 * load-bearing regression is source-scoped backpressure: freshness syncs must
 * coalesce per source, not across every source that shares name='sync'.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'), 'utf8');
const CONTEXT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'remediation', 'context.ts'), 'utf8');

describe('autopilot freshness sync wiring', () => {
  test('uses a per-source idempotency key', () => {
    expect(SRC).toContain('autopilot-sync:${src.id}:${slot}');
  });

  test('threads each source local_path into the sync job payload', () => {
    expect(SRC).toMatch(/sourceId:\s*src\.id[\s\S]{0,200}repoPath:\s*src\.local_path/);
  });

  test('uses per-source backpressure (maxWaiting + stagger_key)', () => {
    expect(SRC).toMatch(
      /idempotency_key:\s*`autopilot-sync:\$\{src\.id\}:\$\{slot\}`[\s\S]{0,250}maxWaiting\s*:\s*1[\s\S]{0,250}stagger_key:\s*`autopilot-freshness:\$\{src\.id\}`/,
    );
  });

  test('uses the long handler timeout for full autopilot-cycle dispatch', () => {
    expect(SRC).toContain("defaultTimeoutMsFor('autopilot-cycle')");
    expect(SRC).toMatch(/const cycleTimeoutMs = Math\.max\([\s\S]{0,160}defaultTimeoutMsFor\('autopilot-cycle'\)/);
    expect(SRC).toMatch(/dispatchPerSource\(engine, queue, \{[\s\S]{0,180}timeoutMs:\s*cycleTimeoutMs/);
  });

  test('keeps freshness sync on the routine timeout', () => {
    expect(SRC).toMatch(/idempotency_key:\s*`autopilot-sync:\$\{src\.id\}:\$\{slot\}`[\s\S]{0,300}timeout_ms:\s*routineTimeoutMs/);
  });

  test('uses shared recommendation context for targeted remediation planning', () => {
    expect(SRC).toContain("import('../core/remediation/context.ts')");
    expect(SRC).toMatch(/const ctx = await loadRecommendationContext\(engine,\s*\{\s*repoPath\s*\}\)/);
    expect(SRC).toMatch(/computeRecommendations\(health,\s*ctx,\s*extraRemediations\)/);
    expect(CONTEXT_SRC).toContain('sourceScoped?: boolean');
    expect(CONTEXT_SRC).toContain('if (opts.sourceScoped === true) sourceId = source.id;');
  });
});
