/**
 * End-to-end integration tests for the `extract-links` command.
 *
 * Uses Option A (injected engine) to avoid GBRAIN_HOME manipulation.
 * The PGLiteEngine is spun up in-memory, seeded with fixture pages, and
 * `runExtractLinks` is called with `{ engine, repoPath }` opts so the
 * config/createEngine path is bypassed entirely.
 *
 * Covers plan Task 2.3 test cases 1–4:
 *   1. --path creates edges; idempotent on second run (upsert).
 *   2. --path outside brain dir returns exit 2.
 *   3. --dry-run --path emits would_create_edge diagnostics; engine unchanged.
 *   4. Non-canonical filenames work end-to-end (Phase 0 bugfix regression).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractLinks } from '../src/commands/extract-links.ts';
import type { PageInput } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Shared fixture brain
// ---------------------------------------------------------------------------

describe('extract-links integration', () => {
  let tmpDir: string;
  let engine: PGLiteEngine;

  beforeAll(async () => {
    // Create tmpDir with fixture markdown files
    tmpDir = mkdtempSync(join(tmpdir(), 'extract-links-integration-'));
    mkdirSync(join(tmpDir, 'briefings'));
    mkdirSync(join(tmpDir, 'people'));

    // Non-canonical filename: slug is briefings/webex-digest-foo but filename
    // has mixed case and spaces — the Phase 0 bugfix ensures this works.
    writeFileSync(
      join(tmpDir, 'briefings', 'Webex Digest - foo.md'),
      '---\nslug: briefings/webex-digest-foo\ntype: meeting\n---\n\nLink to [[people/jbryan-aseva]] inside.\n',
    );
    writeFileSync(
      join(tmpDir, 'people', 'jbryan-aseva.md'),
      '---\nslug: people/jbryan-aseva\ntype: person\nname: Jessie Bryan\n---\n',
    );

    // Seed pages so FK constraints on addLink succeed.
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    const meetingPage: PageInput = {
      type: 'meeting',
      title: 'Webex Digest - foo',
      compiled_truth: 'Link to [[people/jbryan-aseva]] inside.',
    };
    const personPage: PageInput = {
      type: 'person',
      title: 'Jessie Bryan',
      compiled_truth: '',
    };
    await engine.putPage('briefings/webex-digest-foo', meetingPage);
    await engine.putPage('people/jbryan-aseva', personPage);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test 1: creates edges; idempotent on second run
  // -------------------------------------------------------------------------

  test('--path creates edges; idempotent on second run', async () => {
    const file = join(tmpDir, 'briefings', 'Webex Digest - foo.md');

    const code1 = await runExtractLinks(['--path', file], { engine, repoPath: tmpDir });
    expect(code1).toBe(0);

    const links1 = await engine.getLinks('briefings/webex-digest-foo');
    expect(links1.length).toBeGreaterThanOrEqual(1);

    // Second run: upsert semantics must not inflate the count
    const code2 = await runExtractLinks(['--path', file], { engine, repoPath: tmpDir });
    expect(code2).toBe(0);

    const links2 = await engine.getLinks('briefings/webex-digest-foo');
    expect(links2.length).toBe(links1.length);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 2: --path outside brain dir returns exit 2
  // -------------------------------------------------------------------------

  test('--path outside brain dir returns exit 2', async () => {
    // /tmp/some-outside-file.md is not under tmpDir
    const outsidePath = join(tmpdir(), 'some-outside-file.md');
    const code = await runExtractLinks(['--path', outsidePath], { engine, repoPath: tmpDir });
    expect(code).toBe(2);
  }, 10_000);

  // -------------------------------------------------------------------------
  // Test 3: --dry-run emits would_create_edge; engine state unchanged
  // -------------------------------------------------------------------------

  test('--dry-run --path emits would_create_edge; engine unchanged', async () => {
    // Use an isolated page so we can observe a clean before/after state
    mkdirSync(join(tmpDir, 'isolated'), { recursive: true });
    const isoFile = join(tmpDir, 'isolated', 'webex-digest-bar.md');
    writeFileSync(
      isoFile,
      '---\nslug: isolated/webex-digest-bar\ntype: meeting\n---\n\nMentions [[people/jbryan-aseva]].\n',
    );
    await engine.putPage('isolated/webex-digest-bar', {
      type: 'meeting',
      title: 'webex-digest-bar',
      compiled_truth: 'Mentions [[people/jbryan-aseva]].',
    });

    const before = await engine.getLinks('isolated/webex-digest-bar');

    // Capture stderr to assert would_create_edge is emitted
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // @ts-ignore — monkey-patching for test capture
    process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string') stderrLines.push(chunk);
      return origWrite(chunk, ...(rest as []));
    };

    let code: number;
    try {
      code = await runExtractLinks(
        ['--dry-run', '--verbose-diagnostics', '--path', isoFile],
        { engine, repoPath: tmpDir },
      );
    } finally {
      // Restore stderr
      // @ts-ignore
      process.stderr.write = origWrite;
    }

    expect(code).toBe(0);

    const after = await engine.getLinks('isolated/webex-digest-bar');
    // Dry-run must not write any edges
    expect(after.length).toBe(before.length);

    // stderr must contain at least one would_create_edge diagnostic
    const allStderr = stderrLines.join('');
    expect(allStderr).toContain('would_create_edge');
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 4: non-canonical filename regression guard (Phase 0 bugfix)
  // -------------------------------------------------------------------------

  test('non-canonical filename: Phase 0 bugfix regression', async () => {
    // 'briefings/Webex Digest - foo.md' has mixed case and spaces; its slug is
    // 'briefings/webex-digest-foo'. Pre-fix, extractLinksForSlugs would do
    // join(repoPath, slug + '.md') → existsSync fails → 0 edges.
    // Post-fix, the slug→filepath map is used and edges are found.
    const file = join(tmpDir, 'briefings', 'Webex Digest - foo.md');

    const code = await runExtractLinks(['--path', file], { engine, repoPath: tmpDir });
    expect(code).toBe(0);

    // The edge briefings/webex-digest-foo → people/jbryan-aseva must exist
    const links = await engine.getLinks('briefings/webex-digest-foo');
    expect(links.length).toBeGreaterThanOrEqual(1);
    const targets = links.map(l => l.to_slug);
    expect(targets).toContain('people/jbryan-aseva');
  }, 30_000);
});
