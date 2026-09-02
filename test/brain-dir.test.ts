/**
 * src/core/brain-dir.ts — the shared checkout resolver behind `gbrain dream`
 * and the autopilot job handlers. Seven reason codes, one order (explicit →
 * the source's local_path → the global sync.repo_path), every path checked
 * on disk, and the module never exits the process: a missing explicit path
 * comes back as `explicit_missing` for the CALLER to turn into exit 1 (CLI)
 * or a failed job (handlers). Before this module the handlers read
 * sync.repo_path unchecked and threw "Directory not found" inside every
 * filesystem phase whenever the checkout lived on another machine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resolveBrainDir, GLOBAL_REPO_PATH_KEY } from '../src/core/brain-dir.ts';

const MISSING = '/nonexistent/gbrain-brain-dir-test/checkout';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gbrain-brain-dir-'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('resolveBrainDir: explicit path', () => {
  test('explicit path that exists → explicit, absolute', async () => {
    const r = await resolveBrainDir(engine, dir, undefined);
    expect(r).toEqual({ dir: resolve(dir), reason: 'explicit' });
  });

  test('explicit path that is missing → explicit_missing, dir null, no exit', async () => {
    const r = await resolveBrainDir(engine, MISSING, 'wiki');
    expect(r.dir).toBeNull();
    expect(r.reason).toBe('explicit_missing');
    expect(r.configured).toBe(MISSING);
  });

  test('explicit wins over a source and over the global key', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)`, [tmpdir()]);
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, tmpdir());
    const r = await resolveBrainDir(engine, dir, 'wiki');
    expect(r.reason).toBe('explicit');
    expect(r.dir).toBe(resolve(dir));
  });
});

describe('resolveBrainDir: named source', () => {
  test('source with an on-disk local_path → source_path', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)`, [dir]);
    const r = await resolveBrainDir(engine, null, 'wiki');
    expect(r).toEqual({ dir: resolve(dir), reason: 'source_path' });
  });

  test('source without local_path → source_no_path, NEVER the global key', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', NULL)`);
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, dir); // exists, and must be ignored
    const r = await resolveBrainDir(engine, null, 'wiki');
    expect(r).toEqual({ dir: null, reason: 'source_no_path' });
  });

  test('source whose local_path is not on disk → source_no_path with the configured path', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)`, [MISSING]);
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, dir);
    const r = await resolveBrainDir(engine, undefined, 'wiki');
    expect(r.dir).toBeNull();
    expect(r.reason).toBe('source_no_path');
    expect(r.configured).toBe(MISSING);
  });

  test('unknown source id → source_no_path (no throw, no global fallback)', async () => {
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, dir);
    const r = await resolveBrainDir(engine, null, 'ghost');
    expect(r).toEqual({ dir: null, reason: 'source_no_path' });
  });
});

describe('resolveBrainDir: global key and nothing', () => {
  test('global key on disk → global', async () => {
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, dir);
    const r = await resolveBrainDir(engine, null, undefined);
    expect(r).toEqual({ dir: resolve(dir), reason: 'global' });
  });

  test('global key configured but missing on disk → global_missing, dir null (the laptop-path-in-a-container case)', async () => {
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, MISSING);
    const r = await resolveBrainDir(engine, null, undefined);
    expect(r).toEqual({ dir: null, reason: 'global_missing', configured: MISSING });
  });

  test('nothing configured → none', async () => {
    const r = await resolveBrainDir(engine, null, undefined);
    expect(r).toEqual({ dir: null, reason: 'none' });
  });

  test('no engine: only the explicit path can resolve; a source id alone → none', async () => {
    expect(await resolveBrainDir(null, null, 'wiki')).toEqual({ dir: null, reason: 'none' });
    expect((await resolveBrainDir(null, dir, 'wiki')).reason).toBe('explicit');
  });
});

describe('resolveBrainDir: module contract', () => {
  test('the module never calls process.exit (callers own the exit-1 / failed-job decision)', () => {
    // test-reads-source-ok: the no-process.exit rule is a property of the module text, not of any call path
    const src = readFileSync(new URL('../src/core/brain-dir.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('process.exit');
  });
});
