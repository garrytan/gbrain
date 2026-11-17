/**
 * The navigation files (core/nav/nav-pages.ts, foresights nav): index.md, log.md and hot.md.
 *
 * - rendering: pages by folder with a one-line summary; operations newest first, naming
 *   only listed pages; hot.md capped at HOT_MAX_WORDS.
 * - merging: only the marked block is rebuilt; text outside it stays; a file without the
 *   markers is never overwritten.
 * - buildNav on a real brain folder: a git-ignored or private page is never named.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import {
  HOT_MAX_WORDS, NAV_BEGIN, NAV_END, mergeNavFile, renderHot, renderIndex, renderLog, summarize, type NavPage,
} from '../src/core/nav/nav-pages.ts';
import { buildNav } from '../src/commands/nav.ts';
import { isSyncable } from '../src/core/sync.ts';

const page = (slug: string, title: string, body: string, updated_at = '2026-11-16T10:00:00Z'): NavPage =>
  ({ slug, title, type: null, body, updated_at });

describe('rendering', () => {
  test('summarize takes the first plain sentence, skipping headings and stripping links', () => {
    expect(summarize('# Title\n\nMet [[people/alice-example|Alice]] at the fair. More text.')).toBe('Met Alice at the fair.');
    expect(summarize('---\n| a | b |\n```\ncode\n```\n')).toBe('code');
    expect(summarize('x'.repeat(200)).length).toBe(120);
  });

  test('index groups pages by folder, sorted, each with its summary', () => {
    const out = renderIndex([page('people/b', 'B', 'Bee.'), page('notes/a', 'A', 'Aye.'), page('people/a', 'people/a', 'First.')]);
    expect(out).toContain('3 pages in 2 folders.');
    expect(out.indexOf('## notes (1)')).toBeLessThan(out.indexOf('## people (2)'));
    expect(out).toContain('- [[people/a]] - First.');
    expect(out).toContain('- [[people/b|B]] - Bee.');
    expect(out.indexOf('[[people/a]]')).toBeLessThan(out.indexOf('[[people/b|B]]'));
  });

  test('log is newest first and names only listed pages; the rest are counted', () => {
    const out = renderLog([
      { created_at: '2026-11-01T09:00:00Z', source_type: 'directory', source_ref: 'r1', summary: 'old', pages_updated: ['a'] },
      { created_at: '2026-11-02T09:00:00Z', source_type: 'file', source_ref: 'r2', summary: 'new', pages_updated: ['a', 'secret/x'] },
    ], new Set(['a']));
    const lines = out.split('\n');
    expect(lines[0]).toContain('| new | [[a]], 1 not listed');
    expect(lines[1]).toContain('| old | [[a]]');
    expect(out).not.toContain('secret/x');
  });

  test('hot.md is capped at HOT_MAX_WORDS words', () => {
    const many = Array.from({ length: 15 }, (_, i) => page(`n/p${i}`, `P${i}`, `${'word '.repeat(60)}.`));
    const log = Array.from({ length: 8 }, (_, i) => ({ created_at: `2026-11-1${i}T09:00:00Z`, source_type: 'file', source_ref: `r${i}`,
      summary: 'detail '.repeat(80), pages_updated: [] }));
    const out = renderHot(many, log, new Set(), 0, new Date('2026-11-17T00:00:00Z'));
    expect(out.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(HOT_MAX_WORDS + 6);
    expect(out).toContain(`(Cut at ${HOT_MAX_WORDS} words.)`);
  });
});

describe('mergeNavFile', () => {
  test('creates a missing file with title, intro and the marked block', () => {
    const m = mergeNavFile(null, 'Index', 'Intro.', 'BLOCK');
    expect(m.action).toBe('create');
    expect((m as { content: string }).content).toBe(`# Index\n\nIntro.\n\n${NAV_BEGIN}\nBLOCK\n${NAV_END}\n`);
  });

  test('rebuilds only the block and keeps the owner\'s notes; the same block again is unchanged', () => {
    const first = (mergeNavFile(null, 'Index', 'Intro.', 'OLD') as { content: string }).content;
    const edited = first.replace('Intro.', 'Intro.\n\nMy own note.') + '\nFooter note.\n';
    const m = mergeNavFile(edited, 'Index', 'Intro.', 'NEW');
    expect(m.action).toBe('update');
    const next = (m as { content: string }).content;
    expect(next).toContain('My own note.');
    expect(next).toContain('Footer note.');
    expect(next).toContain(`${NAV_BEGIN}\nNEW\n${NAV_END}`);
    expect(next).not.toContain('OLD');
    expect(mergeNavFile(next, 'Index', 'Intro.', 'NEW').action).toBe('unchanged');
  });

  test('a file without the markers is never overwritten', () => {
    expect(mergeNavFile('# My own index\n\nHand-written.', 'Index', 'Intro.', 'BLOCK').action).toBe('refuse');
  });
});

test('sync skips the three files at the root only', () => {
  for (const f of ['index.md', 'log.md', 'hot.md']) expect(isSyncable(f)).toBe(false);
  expect(isSyncable('notes/hot.md')).toBe(true);
});

describe('buildNav on a brain folder', () => {
  let engine: PGLiteEngine;
  let root: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    root = mkdtempSync(join(tmpdir(), 'gb-nav-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
    mkdirSync(join(root, 'people'));
    mkdirSync(join(root, 'notes'));
    const files: Record<string, string> = {
      'people/alice-example.md': '---\ntype: person\ntitle: Alice Example\n---\n# Alice Example\n\nAlice runs operations at acme-example.\n',
      'notes/pilot.md': '---\ntype: note\ntitle: Pilot plan\n---\nThe pilot starts in January.\n',
      'notes/ignored.md': '---\ntype: note\ntitle: Ignored title\n---\nIgnored by git.\n',
      'notes/private.md': '---\ntype: note\ntitle: Private title\nvisibility: private\n---\nPrivate body.\n',
    };
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
    writeFileSync(join(root, '.gitignore'), 'notes/ignored.md\n');
    for (const rel of Object.keys(files)) await importFromFile(engine, join(root, rel), rel, { noEmbed: true });
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  test('writes the three files at the root, naming only git-visible, non-private pages', async () => {
    const r = await buildNav(engine, { now: new Date() });
    expect(r.out).toBe(root);
    expect(r.files.map(f => [f.file, f.action])).toEqual([['index.md', 'create'], ['log.md', 'create'], ['hot.md', 'create']]);
    const index = readFileSync(join(root, 'index.md'), 'utf8');
    expect(index).toContain('[[people/alice-example|Alice Example]] - Alice runs operations at acme-example.');
    expect(index).toContain('[[notes/pilot|Pilot plan]]');
    for (const f of ['index.md', 'log.md', 'hot.md']) {
      const text = readFileSync(join(root, f), 'utf8');
      expect(text).not.toContain('Ignored title');
      expect(text).not.toContain('notes/ignored');
      expect(text).not.toContain('Private title');
      expect(text).not.toContain('notes/private');
    }
  });

  test('a second run keeps the owner\'s notes; a dry run writes nothing; a hand-written file is left alone', async () => {
    const path = join(root, 'index.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('# Index\n', '# Index\n\nMy note about this brain.\n'));
    const again = await buildNav(engine, { now: new Date() });
    expect(again.files.find(f => f.file === 'index.md')!.action).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toContain('My note about this brain.');

    rmSync(join(root, 'log.md'));
    const dry = await buildNav(engine, { now: new Date(), dryRun: true });
    expect(dry.files.find(f => f.file === 'log.md')!.action).toBe('create');
    expect(existsSync(join(root, 'log.md'))).toBe(false);

    writeFileSync(join(root, 'log.md'), '# My log\n\nHand-written.\n');
    const kept = await buildNav(engine, { now: new Date() });
    expect(kept.files.find(f => f.file === 'log.md')!.action).toBe('refuse');
    expect(readFileSync(join(root, 'log.md'), 'utf8')).toBe('# My log\n\nHand-written.\n');
  });

  test('--out writes elsewhere and leaves the source folder alone', async () => {
    const out = mkdtempSync(join(tmpdir(), 'gb-nav-out-'));
    try {
      const r = await buildNav(engine, { out, now: new Date() });
      expect(r.out).toBe(out);
      expect(readFileSync(join(out, 'index.md'), 'utf8')).toContain('[[notes/pilot|Pilot plan]]');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
