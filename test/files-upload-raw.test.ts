/**
 * #2297 — `gbrain files upload-raw` small-file (git) branch.
 *
 * The !needsCloud branch used to print `{success:true, storage:'git',
 * path:<caller's input path>}` and return WITHOUT copying anything into the
 * brain repo or inserting a files row — provenance silently lost while
 * reporting success. These tests pin the fixed behavior: the file lands in
 * the documented `<page-slug>/.raw/<filename>` sidecar (unsorted/.raw
 * without --page) and a files row records it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFiles } from '../src/commands/files.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repoDir: string;
let srcDir: string;

// resolveSourceId env tier could leak from the harness — pin it off per call.
const runFilesNoEnvSource = (engine: PGLiteEngine, args: string[]) =>
  withEnv({ GBRAIN_SOURCE: undefined }, () => runFiles(engine, args));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-raw-repo-'));
  srcDir = mkdtempSync(join(tmpdir(), 'gbrain-raw-src-'));
  // Legacy-tier brain repo resolution (getDefaultSourcePath fallback).
  await engine.setConfig('sync.repo_path', repoDir);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

describe('files upload-raw — small text file stays in git (#2297)', () => {
  test('copies into <page-slug>/.raw/ in the brain repo and records a files row', async () => {
    const input = join(srcDir, 'notes.txt');
    writeFileSync(input, 'raw provenance content');

    await runFilesNoEnvSource(engine, ['upload-raw', input, '--page', 'people/alice-example', '--type', 'notes']);

    const dest = join(repoDir, 'people/alice-example/.raw/notes.txt');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('raw provenance content');

    const rows = await engine.executeRaw<{ storage_path: string; page_slug: string | null; metadata: Record<string, unknown> }>(
      `SELECT storage_path, page_slug, metadata FROM files WHERE filename = 'notes.txt'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].storage_path).toBe('people/alice-example/.raw/notes.txt');
    expect(rows[0].page_slug).toBe('people/alice-example');
    expect(rows[0].metadata).toMatchObject({ type: 'notes', storage: 'git' });
  });

  test('without --page falls back to unsorted/.raw/', async () => {
    const input = join(srcDir, 'loose.txt');
    writeFileSync(input, 'loose content');

    await runFilesNoEnvSource(engine, ['upload-raw', input]);

    expect(existsSync(join(repoDir, 'unsorted/.raw/loose.txt'))).toBe(true);
    const rows = await engine.executeRaw<{ storage_path: string }>(
      `SELECT storage_path FROM files WHERE filename = 'loose.txt'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].storage_path).toBe('unsorted/.raw/loose.txt');
  });

  test('re-upload of the same file is idempotent (ON CONFLICT upsert)', async () => {
    const input = join(srcDir, 'notes.txt');
    writeFileSync(input, 'raw provenance content v2');

    await runFilesNoEnvSource(engine, ['upload-raw', input, '--page', 'people/alice-example']);

    const dest = join(repoDir, 'people/alice-example/.raw/notes.txt');
    expect(readFileSync(dest, 'utf8')).toBe('raw provenance content v2');
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM files WHERE storage_path = 'people/alice-example/.raw/notes.txt'`,
    );
    expect(rows.length).toBe(1);
  });
});
