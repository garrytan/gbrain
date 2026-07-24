/**
 * #1284 — sync auto-embed must not be handed slugs deleted in the same run.
 *
 * The delete loop pushes confirmed-deleted slugs into pagesAffected (the
 * full manifest for extract/report paths), but the end-of-run auto-embed
 * used to pass that same list to runEmbedCore. embedPage throws
 * 'Page not found: <slug>' for each deleted slug and the per-slug loop
 * serr-logs 'Error embedding <slug>: Page not found' — pure noise on every
 * rename/delete sync. The embed call now filters against the run's
 * deleted-slug set (a slug re-imported later in the run stays embeddable).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  resetGateway(); // preload beforeEach restores legacy defaults for later files
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-del-embed-'));
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'people'), { recursive: true });
  writeFileSync(join(repoPath, 'people/alice-example.md'), [
    '---',
    'type: person',
    'title: Alice Example',
    '---',
    '',
    'Alice is a person page that will be deleted.',
  ].join('\n'));
  execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
});

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
});

describe('sync auto-embed vs deleted slugs (#1284)', () => {
  test('delete-only incremental sync does not log Page not found from embed', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Seed: first sync with --no-embed imports alice and sets the bookmark.
    const first = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(first.status).toBe('first_sync');
    expect(await engine.getPage('people/alice-example')).not.toBeNull();

    // Delete the file and commit.
    execSync('git rm -q people/alice-example.md && git commit -qm "delete alice"', {
      cwd: repoPath, stdio: 'pipe', shell: '/bin/bash',
    });

    // Configure the gateway to MATCH the schema width with creds present,
    // so runEmbedCore's preflights (assertEmbeddingEnabled, creds check,
    // dim-mismatch check) all pass and the per-slug embed loop actually
    // runs. Pre-fix, that loop received the deleted slug and serr-logged
    // 'Error embedding people/alice-example: Page not found'.
    const rows = await engine.executeRaw<{ format_type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS format_type
         FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass
          AND attname = 'embedding'
          AND NOT attisdropped`,
    );
    const dims = parseInt(rows[0].format_type.match(/vector\((\d+)\)/i)![1], 10);
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: dims,
      env: { ...process.env, OPENAI_API_KEY: 'sk-test-not-real' },
    });

    // Capture both stderr channels serr() can write to.
    const captured: string[] = [];
    const origErr = console.error;
    const origWrite = process.stderr.write.bind(process.stderr);
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    (process.stderr as { write: unknown }).write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;

    let result: Awaited<ReturnType<typeof performSync>>;
    try {
      // NOTE: no noEmbed — the auto-embed path must run to pin the bug.
      result = await performSync(engine, { repoPath, noPull: true });
    } finally {
      console.error = origErr;
      (process.stderr as { write: unknown }).write = origWrite;
    }

    expect(result.status).toBe('synced');
    expect(result.deleted).toBe(1);
    // pagesAffected stays the full manifest for extract/report consumers.
    expect(result.pagesAffected).toContain('people/alice-example');
    // The regression: deleted slug handed to the embedder.
    const all = captured.join('\n');
    expect(all).not.toContain('Page not found');
  });
});
