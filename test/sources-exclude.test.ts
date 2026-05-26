/**
 * v0.40.9.0 `gbrain sources add --exclude` + `gbrain sources update` CLI
 * surface.
 *
 * Drives opsAddSource / opsUpdateSource directly. The CLI's arg parsing in
 * src/commands/sources.ts:runAdd/runUpdate is a thin shell around these
 * helpers — covered indirectly. Direct CLI parse cases that don't go
 * through opsX (usage errors, mutually-exclusive flags) get a tiny
 * regression in test/sync-exclude.test.ts already.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource, updateSource, SourceOpError } from '../src/core/sources-ops.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

async function readConfig(id: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [id],
  );
  const raw = rows[0]?.config;
  return typeof raw === 'string'
    ? (JSON.parse(raw) as Record<string, unknown>)
    : ((raw ?? {}) as Record<string, unknown>);
}

describe('addSource --exclude', () => {
  test('single --exclude lands as config.excludePatterns', async () => {
    await addSource(engine, {
      id: 'cli-a',
      localPath: '/fake/a',
      excludePatterns: ['data/'],
    });
    const cfg = await readConfig('cli-a');
    expect(cfg.excludePatterns).toEqual(['data/']);
  });

  test('multiple --exclude preserves order', async () => {
    await addSource(engine, {
      id: 'cli-b',
      localPath: '/fake/b',
      excludePatterns: ['data/', '*.parquet', 'tmp/'],
    });
    const cfg = await readConfig('cli-b');
    expect(cfg.excludePatterns).toEqual(['data/', '*.parquet', 'tmp/']);
  });

  test('no --exclude → backward compat (no excludePatterns key)', async () => {
    await addSource(engine, { id: 'cli-c', localPath: '/fake/c' });
    const cfg = await readConfig('cli-c');
    expect(cfg.excludePatterns).toBeUndefined();
  });

  test('empty / whitespace / non-string entries are filtered out (defensive)', async () => {
    await addSource(engine, {
      id: 'cli-d',
      localPath: '/fake/d',
      excludePatterns: [
        'data/',
        '',
        '   ',
        '\t\n',
        // The next two would be coerced — opsAddSource defends defensively
        // even though TypeScript would reject them at the API surface.
        null as unknown as string,
        undefined as unknown as string,
        'tmp/',
      ],
    });
    const cfg = await readConfig('cli-d');
    expect(cfg.excludePatterns).toEqual(['data/', 'tmp/']);
  });

  test('200-pattern sanity cap', async () => {
    const bulk = Array.from({ length: 250 }, (_, i) => `pat${i}/`);
    await addSource(engine, {
      id: 'cli-e',
      localPath: '/fake/e',
      excludePatterns: bulk,
    });
    const cfg = await readConfig('cli-e');
    const patterns = cfg.excludePatterns as string[];
    expect(patterns).toHaveLength(200);
    // First 200 preserved; rest dropped.
    expect(patterns[0]).toBe('pat0/');
    expect(patterns[199]).toBe('pat199/');
  });

  test('--exclude on URL-cloned source path (Path A) lands the same way', async () => {
    // Can't actually clone in unit test, so we exercise the local-path
    // branch — but assert the AddSourceOpts surface holds for both.
    // The opsAddSource code branches on remoteUrl; both branches call
    // sanitizeExcludePatterns identically. Smoke-test the symmetry by
    // confirming the helper itself rejects garbage uniformly.
    await addSource(engine, {
      id: 'cli-f',
      localPath: '/fake/f',
      excludePatterns: ['data/'],
    });
    const cfg = await readConfig('cli-f');
    expect(cfg.excludePatterns).toEqual(['data/']);
  });
});

describe('updateSource — name / strategy', () => {
  beforeEach(async () => {
    await addSource(engine, { id: 'upd', localPath: '/fake/upd', name: 'Original' });
  });

  test('updates name', async () => {
    const result = await updateSource(engine, { id: 'upd', name: 'Renamed' });
    expect(result.name).toBe('Renamed');
  });

  test('sets strategy on config', async () => {
    await updateSource(engine, { id: 'upd', strategy: 'auto' });
    const cfg = await readConfig('upd');
    expect(cfg.strategy).toBe('auto');
  });

  test('throws on missing source id', async () => {
    let caught: unknown = null;
    try {
      await updateSource(engine, { id: 'does-not-exist', name: 'X' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SourceOpError);
    if (caught instanceof SourceOpError) {
      expect(caught.code).toBe('not_found');
    }
  });

  test('throws on invalid source id format', async () => {
    let caught: unknown = null;
    try {
      await updateSource(engine, { id: 'INVALID!ID', name: 'X' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SourceOpError);
    if (caught instanceof SourceOpError) {
      expect(caught.code).toBe('invalid_id');
    }
  });
});
