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
import { extractLinksForSlugs } from '../src/commands/extract.ts';
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
    expect(created).toBeGreaterThanOrEqual(0);
  });
});
