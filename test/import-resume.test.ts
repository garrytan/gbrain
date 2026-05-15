/**
 * Integration tests for `runImport`'s checkpoint behavior.
 *
 * Predicate-level tests for `loadCheckpoint`/`saveCheckpoint`/`resumeFilter`
 * live in `test/import-checkpoint.test.ts`. This file drives the full
 * `runImport` against PGLite to verify the end-to-end resume contract:
 *
 *   - Old positional checkpoints from pre-v0.33.2 brains are discarded
 *     cleanly + the migration stderr log fires.
 *   - v0.33.2 path-based checkpoints honor the completedPaths set on resume.
 *   - Failed files do NOT enter `completedPaths`; the next run retries them
 *     (the pre-existing P1 codex caught).
 *   - Clean completion clears the checkpoint.
 *
 * Test isolation:
 *   - `GBRAIN_HOME` env override via `withEnv` so we NEVER touch the real
 *     `~/.gbrain/import-checkpoint.json`. Pre-v0.33.2 this file did exactly
 *     that — see codex finding P2 in the plan.
 *   - PGLite via the canonical block (`beforeAll` + `resetPgliteState` +
 *     `afterAll`) per CLAUDE.md test-isolation rules R3 + R4.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runImport } from '../src/commands/import.ts';

let engine: PGLiteEngine;
let workspace: string;        // GBRAIN_HOME target — `${workspace}/.gbrain/` holds the checkpoint file
let gbrainHomeDir: string;    // Resolves to `${workspace}/.gbrain` — the actual checkpoint dir
let cpPath: string;           // The checkpoint file path inside gbrainHomeDir
let brainDir: string;         // The brain content dir — fixture markdown lives here

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  workspace = mkdtempSync(join(tmpdir(), 'gbrain-import-resume-home-'));
  // GBRAIN_HOME is the parent dir; configDir() appends '.gbrain' itself.
  // The checkpoint lives at `${workspace}/.gbrain/import-checkpoint.json`.
  gbrainHomeDir = join(workspace, '.gbrain');
  mkdirSync(gbrainHomeDir, { recursive: true });
  cpPath = join(gbrainHomeDir, 'import-checkpoint.json');
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-import-resume-brain-'));
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
});

function writeBrainFile(rel: string, body: string) {
  const full = join(brainDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function validMarkdown(slug: string, title = slug) {
  return [
    '---',
    `slug: ${slug}`,
    `title: ${title}`,
    '---',
    '',
    `Body for ${slug}.`,
  ].join('\n');
}

describe('runImport checkpoint resume — v0.33.2 path-based', () => {
  test('old positional checkpoint gets discarded with stderr log', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      // Plant a pre-v0.33.2 positional checkpoint.
      writeFileSync(cpPath, JSON.stringify({
        dir: brainDir,
        totalFiles: 10,
        processedIndex: 5,
        completedFiles: 5,
        timestamp: '2026-01-01T00:00:00Z',
      }));

      // One fixture file so runImport has work to do.
      writeBrainFile('concepts/foo.md', validMarkdown('concepts/foo'));

      // Capture console.error to verify the migration log fires.
      let captured = '';
      const origErr = console.error.bind(console);
      console.error = (...args: unknown[]) => {
        captured += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
      };

      try {
        const result = await runImport(engine, [brainDir, '--no-embed']);
        expect(result.imported + result.skipped).toBeGreaterThan(0);
      } finally {
        console.error = origErr;
      }

      expect(captured).toContain('Older checkpoint format detected');
    });
  }, 30_000);

  test('v0.33.2 checkpoint with completedPaths skips already-done files', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      writeBrainFile('a.md', validMarkdown('a'));
      writeBrainFile('b.md', validMarkdown('b'));
      writeBrainFile('c.md', validMarkdown('c'));

      // Plant a v0.33.2 checkpoint that says a.md and b.md are done.
      writeFileSync(cpPath, JSON.stringify({
        dir: brainDir,
        completedPaths: ['a.md', 'b.md'],
        timestamp: '2026-05-14T00:00:00Z',
      }));

      const result = await runImport(engine, [brainDir, '--no-embed']);
      // Only c.md should have been imported this run. The other two are
      // already in `completed` and got filtered out before processFile.
      expect(result.imported).toBe(1);
    });
  }, 30_000);

  test('clean completion clears the checkpoint file', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      writeBrainFile('only.md', validMarkdown('only'));

      // No prior checkpoint.
      expect(existsSync(cpPath)).toBe(false);

      const result = await runImport(engine, [brainDir, '--no-embed']);
      expect(result.errors).toBe(0);
      expect(result.imported).toBe(1);

      // After clean completion the checkpoint is cleaned up so the next
      // run doesn't think it needs to resume.
      expect(existsSync(cpPath)).toBe(false);
    });
  }, 30_000);

  test('failed file does NOT enter completedPaths — next run retries it', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      // Two healthy files plus one with a path-vs-frontmatter slug mismatch.
      // import-file.ts rejects path-derived 'people/bob' vs declared slug
      // 'wrong-slug' with a SLUG_MISMATCH failure (test/e2e/sync.test.ts uses
      // the same fixture shape).
      writeBrainFile('people/alice.md', validMarkdown('people/alice'));
      writeBrainFile('people/carol.md', validMarkdown('people/carol'));
      writeBrainFile('people/bob.md', [
        '---', 'type: person', 'title: Bob', 'slug: wrong-slug', '---', '', 'Body.',
      ].join('\n'));

      // First run: bob fails with SLUG_MISMATCH, others succeed.
      const result1 = await runImport(engine, [brainDir, '--no-embed']);
      // `failures` includes both thrown-exception (errors++) and
      // returned-skipped-with-error paths. SLUG_MISMATCH hits the latter.
      expect(result1.failures.length).toBeGreaterThan(0);
      expect(result1.failures.some(f => f.path.includes('bob'))).toBe(true);

      // Fix the broken file.
      writeBrainFile('people/bob.md', validMarkdown('people/bob'));

      // Second run: every file should now succeed. Critically, bob.md must
      // process — not silently skipped because of a stale checkpoint
      // pointer (the pre-v0.33.2 bug class).
      const result2 = await runImport(engine, [brainDir, '--no-embed']);
      expect(result2.failures.length).toBe(0);

      // bob now exists in the DB.
      const pages = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE slug = 'people/bob'`,
      );
      expect(pages.length).toBe(1);

      // Suppress unused warning — cpPath is referenced for clarity above.
      void cpPath;
    });
  }, 60_000);

  test('checkpoint with mismatched dir is discarded silently (no migration log)', async () => {
    await withEnv({ GBRAIN_HOME: workspace }, async () => {
      writeBrainFile('one.md', validMarkdown('one'));

      // v0.33.2-shaped checkpoint pointing at a different brain dir.
      writeFileSync(cpPath, JSON.stringify({
        dir: '/some/other/brain',
        completedPaths: ['one.md'],
        timestamp: '2026-05-14T00:00:00Z',
      }));

      let captured = '';
      const origErr = console.error.bind(console);
      console.error = (...args: unknown[]) => {
        captured += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
      };

      try {
        const result = await runImport(engine, [brainDir, '--no-embed']);
        // Dir mismatch → discard → re-walk → import the file fresh.
        expect(result.imported).toBe(1);
      } finally {
        console.error = origErr;
      }

      // The "older checkpoint format" log is for the POSITIONAL legacy
      // shape, not v0.33.2-dir-mismatch. Silent discard is intentional.
      expect(captured).not.toContain('Older checkpoint format');
    });
  }, 30_000);
});
