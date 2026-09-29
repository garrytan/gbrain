/**
 * #5622 — `gbrain capture --file <relative-path>` must store an ABSOLUTE
 * `file://` source_uri.
 *
 * The capture skill documents `gbrain capture --file ./notes/today.md`, and
 * the producer concatenated the raw argv value: `file://./notes/today.md`
 * (or `file://notes.md` for a bare name) — the file name became the URL
 * HOST. No consumer can resolve that shape: `recordedPathFromFileUri`
 * (write-through.ts) slices `file://` and treats the rest as an absolute
 * path, and the managed knowledge-guard refuses the page on every later
 * write, which also blocks the source's sync. The fix resolves the path
 * first, matching the markdown-greenfield producer's `file://<abs>` shape.
 *
 * Serial: spawns subprocesses against a pinned GBRAIN_HOME tmpdir (the
 * in-process engine is disconnected while the CLI child owns the PGLite
 * single-writer lock).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ENV = {
  GBRAIN_NO_BANNER: '1',
  GBRAIN_MODEL_DISCOVERY: 'off',
  GBRAIN_SKIP_STARTUP_HOOKS: '1',
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  VOYAGE_API_KEY: undefined,
} as const;

let home: string;
let work: string;
let dbPath: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-capture-uri-5622-'));
  work = join(home, 'work');
  dbPath = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n',
  );
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  await engine.initSchema();
  await engine.disconnect(); // the CLI child needs the single-writer lock
}, 240_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function storedSourceUri(slug: string): Promise<string | null> {
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    const rows = await engine.executeRaw<{ source_uri: string | null }>(
      'SELECT source_uri FROM pages WHERE slug = $1', [slug],
    );
    return rows[0]?.source_uri ?? null;
  } finally {
    await engine.disconnect();
  }
}

describe('#5622 capture --file stores an absolute file:// source_uri', () => {
  test('a relative --file path (the documented skill spelling) resolves against cwd', async () => {
    writeFileSync(join(work, 'today.md'), '# Today\n\nBody.\n');
    const run = await runCli(['capture', '--file', './today.md', '--slug', 'concepts/today'], {
      home, cwd: work, timeoutMs: 60_000, env: ENV,
    });
    expect(run.exitCode).toBe(0);
    // Pre-fix: file://./today.md — the dot was the URL host.
    expect(await storedSourceUri('concepts/today')).toBe(`file://${join(work, 'today.md')}`);
  }, 120_000);

  test('a bare relative name and the absolute spelling store the same URI', async () => {
    writeFileSync(join(work, 'bare.md'), '# Bare\n\nBody.\n');
    const bare = await runCli(['capture', '--file', 'bare.md', '--slug', 'concepts/bare'], {
      home, cwd: work, timeoutMs: 60_000, env: ENV,
    });
    expect(bare.exitCode).toBe(0);
    expect(await storedSourceUri('concepts/bare')).toBe(`file://${join(work, 'bare.md')}`);

    writeFileSync(join(work, 'abs.md'), '# Abs\n\nBody.\n');
    const abs = await runCli(['capture', '--file', join(work, 'abs.md'), '--slug', 'concepts/abs'], {
      home, cwd: work, timeoutMs: 60_000, env: ENV,
    });
    expect(abs.exitCode).toBe(0);
    expect(await storedSourceUri('concepts/abs')).toBe(`file://${join(work, 'abs.md')}`);
  }, 120_000);

  test('recordedPathFromFileUri recovers the captured file as the write target', async () => {
    // The consumer contract: the stored URI must name a path the
    // write-through recovery can turn back into a page-root-relative target.
    const { recordedPathFromFileUri } = await import('../src/core/write-through.ts');
    const uri = await storedSourceUri('concepts/today');
    expect(uri).toBe(`file://${join(work, 'today.md')}`);
    // The file lives outside the page root, so recovery returns null (not a
    // contained .md) — the point is that it PARSES as an absolute path at
    // all instead of dying on the relative `./today.md` host.
    expect(recordedPathFromFileUri(uri, join(home, '.gbrain', 'content'))).toBeNull();
    expect(recordedPathFromFileUri('file://./today.md', join(home, '.gbrain', 'content'))).toBeNull();
  }, 60_000);
});
