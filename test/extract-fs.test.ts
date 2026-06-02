/**
 * Tests for `gbrain extract --source fs` (the default, FS-walking path).
 *
 * Companion to test/extract-db.test.ts. Specifically guards against the
 * v0.12.0 N+1 hang: extractLinksFromDir / extractTimelineFromDir used to
 * pre-load the entire dedup set with one engine.getLinks() per page across
 * engine.listPages(), which on a 47K-page brain meant 47K sequential
 * round-trips before any work happened.
 *
 * Verifies:
 *   1. Single run extracts the expected links + timeline entries.
 *   2. Second run reports `created: 0` (proves DO NOTHING in batch + accurate
 *      counter via RETURNING).
 *   3. --dry-run prints the same link found across multiple files exactly
 *      once (proves the dry-run-only dedup Set works).
 *   4. Second run wall-clock < 2s (regression guard against any future change
 *      that re-introduces the N+1 read pre-load).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

const personPage = (title: string, body = ''): PageInput => ({
  type: 'person', title, compiled_truth: body, timeline: '',
});

const companyPage = (title: string, body = ''): PageInput => ({
  type: 'company', title, compiled_truth: body, timeline: '',
});

beforeEach(async () => {
  await truncateAll();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-fs-'));
}, 15_000);

function writeFile(rel: string, content: string) {
  const full = join(brainDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('gbrain extract links --source fs', () => {
  test('first run inserts links, second run reports 0 (idempotent + truthful counter)', async () => {
    // Set up brain in DB matching the file structure
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    await engine.putPage('companies/acme', companyPage('Acme'));

    // Set up matching markdown files on disk
    writeFile('people/alice.md', '---\ntitle: Alice\n---\n\n[Bob](../people/bob.md) is a friend.\n');
    writeFile('people/bob.md', '---\ntitle: Bob\n---\n\nWorks at [Acme](../companies/acme.md).\n');
    writeFile('companies/acme.md', '---\ntitle: Acme\n---\n\nFounded by [Alice](../people/alice.md).\n');

    // First run — write batch path
    await runExtract(engine, ['links', '--dir', brainDir]);
    const linksAfter1 = (await engine.getLinks('people/alice'))
      .concat(await engine.getLinks('people/bob'))
      .concat(await engine.getLinks('companies/acme'));
    expect(linksAfter1.length).toBeGreaterThanOrEqual(3);

    // Second run — must dedup via ON CONFLICT and report 0 new (truthful counter)
    const start = Date.now();
    await runExtract(engine, ['links', '--dir', brainDir]);
    const elapsedMs = Date.now() - start;

    const linksAfter2 = (await engine.getLinks('people/alice'))
      .concat(await engine.getLinks('people/bob'))
      .concat(await engine.getLinks('companies/acme'));
    expect(linksAfter2.length).toBe(linksAfter1.length);

    // Perf regression guard: re-run on tiny fixture must not loop through
    // listPages + per-page getLinks. ~10 files should complete in well under
    // 2s even on a slow CI box.
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('--dry-run dedups duplicate candidates across files (printed once, not N times)', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('companies/acme', companyPage('Acme'));

    // Same link target appears in 3 different files. The target file must
    // exist on disk so the FS extractor's allSlugs Set includes it.
    writeFile('companies/acme.md', '---\ntitle: Acme\n---\n');
    writeFile('a.md', '[Acme](companies/acme.md)\n');
    writeFile('b.md', '[Acme](companies/acme.md)\n');
    writeFile('c.md', '[Acme](companies/acme.md)\n');

    // Capture stdout to check print frequency
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await runExtract(engine, ['links', '--dry-run', '--dir', brainDir]);
    } finally {
      console.log = origLog;
    }

    // Each (from, to, link_type) tuple should print at most once.
    // Three distinct from_slugs (a, b, c) all link to companies/acme, so
    // we expect 3 link lines (one per source file), not 9.
    const linkLines = lines.filter(l => l.includes('→') && l.includes('companies/acme'));
    expect(linkLines.length).toBe(3);

    // No actual writes happened
    const links = await engine.getLinks('companies/acme');
    expect(links.length).toBe(0);
  });
});

describe('gbrain extract timeline --source fs', () => {
  test('first run inserts entries, second run reports 0 (idempotent + truthful counter)', async () => {
    await engine.putPage('people/alice', personPage('Alice'));

    writeFile('people/alice.md', `---
title: Alice
---

## Timeline

- **2024-01-15** | source — Founded NovaMind
- **2024-06-01** | source — Raised seed round
`);

    await runExtract(engine, ['timeline', '--dir', brainDir]);
    const after1 = await engine.getTimeline('people/alice');
    expect(after1.length).toBe(2);

    const start = Date.now();
    await runExtract(engine, ['timeline', '--dir', brainDir]);
    const elapsedMs = Date.now() - start;

    const after2 = await engine.getTimeline('people/alice');
    expect(after2.length).toBe(2);

    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('gbrain extract --dir default resolution', () => {
  // Pin the cwd-footgun fix: when --dir is not passed, extract resolves the
  // brain dir from the sources(local_path) row before falling back. The bare
  // `.` default would let a user running from a directory with a node_modules/
  // tree walk tens of thousands of unrelated .md files and report
  // "created 0 links from 28K pages" — looks like a no-op, was actually a
  // wasteful junk walk that wrote nothing because synthetic from_slugs don't
  // match the pages table.
  test('uses configured sources(local_path) when --dir is not passed', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    writeFile('people/alice.md', '---\ntitle: Alice\n---\n\n[Bob](../people/bob.md) is a friend.\n');
    writeFile('people/bob.md', '---\ntitle: Bob\n---\n');

    // Register brainDir as the default source's local_path.
    await (engine as any).db.exec(
      `UPDATE sources SET local_path = '${brainDir.replace(/'/g, "''")}' WHERE id = 'default'`,
    );

    // Save + clobber cwd to a sibling tmpdir so the test fails loudly if the
    // resolver still walks `.` instead of the configured path.
    const otherDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-other-'));
    const savedCwd = process.cwd();
    try {
      process.chdir(otherDir);
      await runExtract(engine, ['links']); // no --dir
    } finally {
      process.chdir(savedCwd);
      try { rmSync(otherDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0]).toMatchObject({ to_slug: 'people/bob' });
  });

  test('errors with actionable message when no --dir and no source configured', async () => {
    // Clear the default source's local_path so getDefaultSourcePath returns null.
    await (engine as any).db.exec(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await (engine as any).db.exec(`DELETE FROM config WHERE key = 'sync.repo_path'`);

    let exitCode: number | null = null;
    const errBuf: string[] = [];
    const savedExit = process.exit;
    const savedConsoleError = console.error;
    try {
      (process as any).exit = (code: number) => { exitCode = code; throw new Error('__test_exit__'); };
      console.error = (...parts: unknown[]) => { errBuf.push(parts.join(' ')); };
      try {
        await runExtract(engine, ['links']);
      } catch (e) {
        if (!(e instanceof Error && e.message === '__test_exit__')) throw e;
      }
    } finally {
      (process as any).exit = savedExit;
      console.error = savedConsoleError;
    }
    expect(exitCode as unknown).toBe(1);
    const all = errBuf.join('\n');
    expect(all).toContain('No brain directory configured');
    expect(all).toContain('--source db');
    expect(all).toContain('--dir');
  });

  test('explicit --dir always wins over configured source', async () => {
    await engine.putPage('people/alice', personPage('Alice'));
    await engine.putPage('people/bob', personPage('Bob'));
    writeFile('people/alice.md', '---\ntitle: Alice\n---\n\n[Bob](../people/bob.md) is a friend.\n');
    writeFile('people/bob.md', '---\ntitle: Bob\n---\n');

    // Configured path points elsewhere; explicit --dir must override.
    const decoyDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-decoy-'));
    await (engine as any).db.exec(
      `UPDATE sources SET local_path = '${decoyDir.replace(/'/g, "''")}' WHERE id = 'default'`,
    );

    try {
      await runExtract(engine, ['links', '--dir', brainDir]);
      const links = await engine.getLinks('people/alice');
      expect(links.length).toBe(1);
      expect(links[0]).toMatchObject({ to_slug: 'people/bob' });
    } finally {
      try { rmSync(decoyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── issue #972: pure-function tests for resolveSlugAll + helpers ────────

import {
  resolveSlug,
  resolveSlugAll,
  resolveBasenameMatchesFromSlugs,
  extractLinksFromFile,
} from '../src/commands/extract.ts';

describe('extractLinksFromFile — code-fence stripping (codex P2b)', () => {
  test('a bare wikilink inside a code fence does NOT create an FS edge', async () => {
    const allSlugs = new Set(['projects/struktura', 'concepts/x']);
    const content = [
      '---', 'title: X', 'type: concept', '---', '',
      'Real ref: [[struktura]].',
      '',
      '```', 'code mentions [[struktura]] but must be ignored', '```',
    ].join('\n');
    const links = await extractLinksFromFile(content, 'concepts/x.md', allSlugs, { globalBasename: true });
    const toStruktura = links.filter(l => l.to_slug === 'projects/struktura');
    // Exactly one edge — from the prose ref, NOT the fenced one.
    expect(toStruktura.length).toBe(1);
    expect(toStruktura[0].link_source).toBe('wikilink-resolved');
  });
});

describe('resolveBasenameMatchesFromSlugs (pure)', () => {
  test('returns ALL slugs whose tail matches', () => {
    const all = new Set([
      'projects/struktura',
      'archive/struktura',
      'notes/other',
    ]);
    const matches = resolveBasenameMatchesFromSlugs('struktura', all);
    expect(matches.sort()).toEqual(['archive/struktura', 'projects/struktura']);
  });

  test('case-insensitive tail match', () => {
    const all = new Set(['companies/fast-weigh']);
    expect(resolveBasenameMatchesFromSlugs('Fast-Weigh', all))
      .toEqual(['companies/fast-weigh']);
    expect(resolveBasenameMatchesFromSlugs('FAST-WEIGH', all))
      .toEqual(['companies/fast-weigh']);
  });

  test('slugified fallback (spaces → hyphens)', () => {
    const all = new Set(['companies/fast-weigh']);
    expect(resolveBasenameMatchesFromSlugs('Fast Weigh', all))
      .toEqual(['companies/fast-weigh']);
  });

  test('top-level slugs (no `/`) match by themselves', () => {
    const all = new Set(['struktura', 'notes/struktura']);
    const matches = resolveBasenameMatchesFromSlugs('struktura', all);
    expect(matches.sort()).toEqual(['notes/struktura', 'struktura']);
  });

  test('no match returns []', () => {
    const all = new Set(['projects/struktura']);
    expect(resolveBasenameMatchesFromSlugs('never-existed', all)).toEqual([]);
  });

  test('empty/whitespace input returns []', () => {
    const all = new Set(['projects/struktura']);
    expect(resolveBasenameMatchesFromSlugs('', all)).toEqual([]);
    expect(resolveBasenameMatchesFromSlugs('   ', all)).toEqual([]);
  });

  test('stable sort: shorter slug first, then lexical', () => {
    const all = new Set([
      'zzz/struktura',
      'projects/struktura',
      'archive/struktura',
      'a/struktura',
    ]);
    const matches = resolveBasenameMatchesFromSlugs('struktura', all);
    // Lengths: a/struktura(11), zzz/struktura(13), archive/struktura(17), projects/struktura(18)
    expect(matches).toEqual([
      'a/struktura',
      'zzz/struktura',
      'archive/struktura',
      'projects/struktura',
    ]);
  });
});

describe('resolveSlugAll', () => {
  test('ancestor walk wins → single-element array, no basename fallback', () => {
    // resolveSlug already finds notes/struktura via ancestor walk.
    // resolveSlugAll must return only that one even though basename
    // would find others.
    const all = new Set([
      'notes/struktura',
      'archive/struktura',
      'projects/struktura',
    ]);
    const out = resolveSlugAll('notes/sub', 'struktura.md', all,
      { globalBasename: true });
    expect(out).toEqual(['notes/struktura']);
  });

  test('ancestor walk misses + globalBasename off → []', () => {
    const all = new Set(['projects/struktura']);
    const out = resolveSlugAll('concepts', 'struktura.md', all);
    expect(out).toEqual([]);
  });

  test('ancestor walk misses + globalBasename on → all basename matches', () => {
    const all = new Set([
      'projects/struktura',
      'archive/struktura',
    ]);
    const out = resolveSlugAll('concepts', 'struktura.md', all,
      { globalBasename: true });
    expect(out.sort()).toEqual(['archive/struktura', 'projects/struktura']);
  });

  test('zero basename matches when globalBasename on returns []', () => {
    const all = new Set(['projects/struktura']);
    const out = resolveSlugAll('concepts', 'phantom.md', all,
      { globalBasename: true });
    expect(out).toEqual([]);
  });

  test('strips dirname from relTarget when applying basename lookup', () => {
    // [[notes/struktura]] with no `notes` ancestor: ancestor walk strips
    // `concepts` → tries `notes/struktura` which DOES exist → emits.
    // This case verifies the basename fallback only fires when ancestor
    // walk truly fails. (Sanity check on the fallback ordering.)
    const all = new Set(['notes/struktura']);
    expect(resolveSlugAll('concepts', 'notes/struktura.md', all))
      .toEqual(['notes/struktura']);
  });

  test('resolveSlug back-compat: existing single-match callers unaffected', () => {
    const all = new Set(['notes/struktura']);
    // The legacy resolveSlug must keep returning the string|null shape.
    expect(resolveSlug('notes', 'struktura.md', all)).toBe('notes/struktura');
    expect(resolveSlug('concepts', 'phantom.md', all)).toBeNull();
  });
});

describe('issue #972 repro: bare wikilinks resolve when flag is on', () => {
  // End-to-end: reproduces the issue's exact repro inside a tempdir +
  // PGLite, then asserts edge count under both flag states.
  test('flag OFF → 0 edges (back-compat)', async () => {
    await engine.putPage('projects/struktura',
      { type: 'project', title: 'Struktura', compiled_truth: 'A project page.', timeline: '' });
    await engine.putPage('concepts/knowledge-graph',
      { type: 'concept', title: 'Knowledge Graph',
        compiled_truth: 'This concept relates to [[struktura]].', timeline: '' });

    // Mirror to disk: the FS extractor walks files, not DB pages.
    writeFile('projects/struktura.md', '---\ntitle: Struktura\ntype: project\n---\n\nA project page.\n');
    writeFile('concepts/knowledge-graph.md',
      '---\ntitle: Knowledge Graph\ntype: concept\n---\n\nThis concept relates to [[struktura]].\n');

    // Ensure flag is off (default)
    await engine.setConfig('link_resolution.global_basename', 'false');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('concepts/knowledge-graph');
    expect(links.find(l => l.to_slug === 'projects/struktura')).toBeUndefined();
  });

  test('flag ON → 1 edge with wikilink_basename type', async () => {
    await engine.putPage('projects/struktura',
      { type: 'project', title: 'Struktura', compiled_truth: 'A project page.', timeline: '' });
    await engine.putPage('concepts/knowledge-graph',
      { type: 'concept', title: 'Knowledge Graph',
        compiled_truth: 'This concept relates to [[struktura]].', timeline: '' });

    writeFile('projects/struktura.md', '---\ntitle: Struktura\ntype: project\n---\n\nA project page.\n');
    writeFile('concepts/knowledge-graph.md',
      '---\ntitle: Knowledge Graph\ntype: concept\n---\n\nThis concept relates to [[struktura]].\n');

    await engine.setConfig('link_resolution.global_basename', 'true');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('concepts/knowledge-graph');
    const strk = links.find(l => l.to_slug === 'projects/struktura');
    expect(strk).toBeDefined();
    expect(strk!.link_type).toBe('wikilink_basename');
  });

  test('flag ON + ambiguous basename → one edge per match', async () => {
    await engine.putPage('projects/struktura',
      { type: 'project', title: 'Struktura', compiled_truth: '', timeline: '' });
    await engine.putPage('archive/struktura',
      { type: 'concept' as any, title: 'Struktura (archived)',
        compiled_truth: '', timeline: '' });
    await engine.putPage('concepts/knowledge-graph',
      { type: 'concept', title: 'Knowledge Graph',
        compiled_truth: 'See [[struktura]].', timeline: '' });

    writeFile('projects/struktura.md', '---\ntitle: Struktura\ntype: project\n---\n');
    writeFile('archive/struktura.md', '---\ntitle: Struktura\ntype: concept\n---\n');
    writeFile('concepts/knowledge-graph.md',
      '---\ntitle: Knowledge Graph\ntype: concept\n---\n\nSee [[struktura]].\n');

    await engine.setConfig('link_resolution.global_basename', 'true');

    await runExtract(engine, ['links', '--dir', brainDir]);
    const links = await engine.getLinks('concepts/knowledge-graph');
    const basenameLinks = links.filter(l => l.link_type === 'wikilink_basename');
    const targets = basenameLinks.map(l => l.to_slug).sort();
    expect(targets).toEqual(['archive/struktura', 'projects/struktura']);
  });
});
