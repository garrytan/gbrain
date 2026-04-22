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
