/**
 * Regression test for extractLinksForSlugs on non-canonical filenames.
 *
 * The bug: extractLinksForSlugs reconstructs a file path as
 *   join(repoPath, slug + '.md')
 * That only works when the filename matches the slug exactly. When the file
 * has mixed case or spaces (e.g. "Briefings/Webex Digest - foo.md" whose
 * pathToSlug() is "briefings/webex-digest-foo"), existsSync returns false and
 * the function silently skips the file, returning 0.
 *
 * Mirrored from test/extract-fs.test.ts (engine init + page seed pattern).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractLinksForSlugs, runExtractCore } from '../src/commands/extract.ts';
import type { PageInput } from '../src/core/types.ts';

describe('extractLinksForSlugs on non-canonical filenames', () => {
  let tmpDir: string;
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-linkify-test-'));
    mkdirSync(join(tmpDir, 'briefings'));
    mkdirSync(join(tmpDir, 'people'));

    // Non-canonical filename. Slug should resolve to briefings/webex-digest-foo.
    writeFileSync(
      join(tmpDir, 'briefings', 'Webex Digest - foo.md'),
      '---\nslug: briefings/webex-digest-foo\ntype: meeting\n---\n\nLink to [[people/jbryan-aseva]] inside.\n',
    );
    writeFileSync(
      join(tmpDir, 'people', 'jbryan-aseva.md'),
      '---\nslug: people/jbryan-aseva\ntype: person\nname: Jessie Bryan\n---\n',
    );

    // Seed both pages so FK constraints on engine.addLink don't fail.
    const meetingPage: PageInput = {
      type: 'meeting',
      title: 'Webex Digest - foo',
      compiled_truth: 'Link to [[people/jbryan-aseva]] inside.',
      timeline: '',
    };
    const personPage: PageInput = {
      type: 'person',
      title: 'Jessie Bryan',
      compiled_truth: '',
      timeline: '',
    };
    await engine.putPage('briefings/webex-digest-foo', meetingPage);
    await engine.putPage('people/jbryan-aseva', personPage);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 60_000);

  test('finds links in non-canonical-filename file (the bug case)', async () => {
    const created = await extractLinksForSlugs(engine, tmpDir, ['briefings/webex-digest-foo']);
    // PRE-FIX: returns 0 (existsSync fails on join(tmpDir, 'briefings/webex-digest-foo.md')
    //          because the actual file is 'Briefings/Webex Digest - foo.md').
    // POST-FIX: returns 1 (finds the file via slug→filepath map).
    expect(created).toBe(1);
  });

  test('canonical filename still works (regression guard)', async () => {
    const created = await extractLinksForSlugs(engine, tmpDir, ['people/jbryan-aseva']);
    expect(created).toBe(0);
  });
});

describe('extractForSlugs on non-canonical filenames', () => {
  // Uses an independent fixture brain in a separate tmpDir (the outer describe's
  // PGLiteEngine cannot be reused — extractForSlugs needs its own engine instance
  // via runExtractCore). We use a fresh PGLiteEngine per describe so FK seeds don't conflict.
  let tmpDir2: string;
  let engine2: PGLiteEngine;

  beforeAll(async () => {
    engine2 = new PGLiteEngine();
    await engine2.connect({});
    await engine2.initSchema();

    tmpDir2 = mkdtempSync(join(tmpdir(), 'gbrain-extract-for-slugs-test-'));
    mkdirSync(join(tmpDir2, 'briefings'));
    mkdirSync(join(tmpDir2, 'people'));

    // Non-canonical filename whose pathToSlug() = 'briefings/webex-digest-foo'.
    writeFileSync(
      join(tmpDir2, 'briefings', 'Webex Digest - foo.md'),
      '---\nslug: briefings/webex-digest-foo\ntype: meeting\n---\n\nLink to [[people/jbryan-aseva]] inside.\n',
    );
    writeFileSync(
      join(tmpDir2, 'people', 'jbryan-aseva.md'),
      '---\nslug: people/jbryan-aseva\ntype: person\nname: Jessie Bryan\n---\n',
    );

    // Seed both pages so FK constraints on addLink don't fail.
    const meetingPage: PageInput = {
      type: 'meeting',
      title: 'Webex Digest - foo',
      compiled_truth: 'Link to [[people/jbryan-aseva]] inside.',
      timeline: '',
    };
    const personPage: PageInput = {
      type: 'person',
      title: 'Jessie Bryan',
      compiled_truth: '',
      timeline: '',
    };
    await engine2.putPage('briefings/webex-digest-foo', meetingPage);
    await engine2.putPage('people/jbryan-aseva', personPage);
  }, 60_000);

  afterAll(async () => {
    if (engine2) await engine2.disconnect();
    rmSync(tmpDir2, { recursive: true, force: true });
  }, 60_000);

  test('extractForSlugs finds links in non-canonical-filename file', async () => {
    // PRE-FIX: extractForSlugs does join(brainDir, slug + '.md') + existsSync(),
    //          which fails for 'Webex Digest - foo.md', so links_created === 0.
    // POST-FIX: uses slug→filepath map, so links_created === 1.
    const result = await runExtractCore(engine2, {
      mode: 'links',
      dir: tmpDir2,
      dryRun: false,
      jsonMode: true,
      slugs: ['briefings/webex-digest-foo'],
    });
    expect(result.links_created).toBe(1);
  });
});
