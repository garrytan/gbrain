/**
 * v0.41.30.0 — resolveScopedSourceOrThrow resolution rule (BUG 1).
 *
 * code-callers / code-callees used to call resolveDefaultSource directly,
 * which only knew "1 source → use it, else multiple_sources_ambiguous" and
 * ignored the .gbrain-source pin. The new helper runs the full 7-tier chain
 * (flag → env → dotfile → local_path → brain_default → sole_non_default →
 * seed_default) and only applies the ambiguity guard on the no-signal
 * seed_default tier.
 *
 * This drives the helper directly with an explicit cwd (hermetic). The CLI
 * end-to-end wiring (process.cwd() + chdir) lives in
 * test/code-callers-pin.serial.test.ts.
 *
 * PGLite in-memory, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveScopedSourceOrThrow, SourceResolutionError } from '../src/core/sources-ops.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

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
});

async function addSource(id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [id, localPath],
  );
}

/** A throwaway directory NOT under any registered source's local_path and
 * with no .gbrain-source, so the resolver falls through to the DB tiers. */
function cleanCwd(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-scoped-clean-'));
}

describe('resolveScopedSourceOrThrow', () => {
  test('single-source brain: returns default via seed_default tier (no throw)', async () => {
    const cwd = cleanCwd();
    try {
      const r = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
      expect(r.source_id).toBe('default');
      expect(r.tier).toBe('seed_default');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('.gbrain-source pin resolves on a multi-source brain (THE bug)', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-scoped-pin-'));
    writeFileSync(join(cwd, '.gbrain-source'), 'repo-a\n');
    try {
      const r = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
      expect(r.source_id).toBe('repo-a');
      expect(r.tier).toBe('dotfile');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no pin + no signal + multi-source → multiple_sources_ambiguous', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const cwd = cleanCwd();
    let caught: unknown = null;
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
    } catch (e) {
      caught = e;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    expect(caught).toBeInstanceOf(SourceResolutionError);
    if (caught instanceof SourceResolutionError) {
      expect(caught.code).toBe('multiple_sources_ambiguous');
      expect(caught.availableSources).toContain('repo-a');
      expect(caught.availableSources).toContain('repo-b');
    }
  });

  test('default + one non-default source with local_path → sole_non_default tier', async () => {
    await addSource('repo-a', '/fake/a');
    const cwd = cleanCwd();
    try {
      const r = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
      expect(r.source_id).toBe('repo-a');
      expect(r.tier).toBe('sole_non_default');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('GBRAIN_SOURCE env tier wins on a multi-source brain', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const cwd = cleanCwd();
    try {
      const r = await withEnv({ GBRAIN_SOURCE: 'repo-b' }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
      expect(r.source_id).toBe('repo-b');
      expect(r.tier).toBe('env');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('brain_default (sources.default config) tier wins when no pin/env/cwd-match', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    await engine.setConfig('sources.default', 'repo-a');
    const cwd = cleanCwd();
    try {
      const r = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
      expect(r.source_id).toBe('repo-a');
      expect(r.tier).toBe('brain_default');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('zero sources → no_sources throw', async () => {
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'default'`, []);
    const cwd = cleanCwd();
    let caught: unknown = null;
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
    } catch (e) {
      caught = e;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    expect(caught).toBeInstanceOf(SourceResolutionError);
    if (caught instanceof SourceResolutionError) {
      expect(caught.code).toBe('no_sources');
    }
  });

  test('bad .gbrain-source pin (nonexistent source) throws a resolver user error', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-scoped-badpin-'));
    writeFileSync(join(cwd, '.gbrain-source'), 'does-not-exist\n');
    let caught: unknown = null;
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        resolveScopedSourceOrThrow(engine, cwd));
    } catch (e) {
      caught = e;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    // Bad pin surfaces as a plain Error from assertSourceExists, NOT a
    // SourceResolutionError — the command layer maps this to a clean exit 2.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SourceResolutionError);
    expect((caught as Error).message).toContain('does-not-exist');
  });
});
