/**
 * IRON RULE regression test (per D1 from /plan-eng-review for v0.42.0.0).
 *
 * Pins byte-identical output between:
 *   - `gbrain orphans --json` (CLI orchestrator `runOrphans`)
 *   - `findOrphans(engine, opts)` (canonical pure data fn)
 *   - `getOrphansData(engine, opts)` (v0.42.0.0 alias for findOrphans)
 *
 * If a future refactor lets the CLI filter results differently after
 * `findOrphans` returns, this test catches the drift. Doctor's
 * `orphan_ratio` check imports `getOrphansData`; this test guarantees
 * the doctor count cannot disagree with `gbrain orphans --count`.
 *
 * Hermetic via PGLite. No DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  findOrphans,
  getOrphansData,
  shouldExclude,
  runOrphans,
} from '../src/commands/orphans.ts';

let engine: PGLiteEngine;
let logBuffer: string[];
const originalLog = console.log;

function captureConsoleLog(): void {
  logBuffer = [];
  console.log = (msg?: unknown) => {
    logBuffer.push(typeof msg === 'string' ? msg : String(msg));
  };
}

function restoreConsoleLog(): void {
  console.log = originalLog;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreConsoleLog();
});

beforeEach(async () => {
  // Clean slate per test — keeps the IRON RULE assertions deterministic
  // across the file's test suite.
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

async function seedFixture(): Promise<void> {
  // 5 entity pages: 2 will have inbound links, 3 will be orphans.
  // 2 pseudo-pages: should be excluded by default filter.
  // 1 content page: links to person-1 + company-1.
  await engine.putPage('people/person-1', {
    type: 'person', title: 'Person 1', compiled_truth: 'p1', timeline: '', frontmatter: { domain: 'people' },
  });
  await engine.putPage('people/person-2', {
    type: 'person', title: 'Person 2', compiled_truth: 'p2', timeline: '', frontmatter: { domain: 'people' },
  });
  await engine.putPage('people/person-3', {
    type: 'person', title: 'Person 3', compiled_truth: 'p3', timeline: '', frontmatter: { domain: 'people' },
  });
  await engine.putPage('companies/company-1', {
    type: 'company', title: 'Company 1', compiled_truth: 'c1', timeline: '', frontmatter: { domain: 'companies' },
  });
  await engine.putPage('companies/company-2', {
    type: 'company', title: 'Company 2', compiled_truth: 'c2', timeline: '', frontmatter: { domain: 'companies' },
  });
  // Pseudo-pages — should be excluded from default orphan results.
  await engine.putPage('_atlas', {
    type: 'note', title: 'Atlas', compiled_truth: 'atlas', timeline: '', frontmatter: {},
  });
  await engine.putPage('templates/meeting', {
    type: 'note', title: 'Meeting template', compiled_truth: 'tmpl', timeline: '', frontmatter: {},
  });
  // Content page that links to person-1 + company-1.
  await engine.putPage('writing/post-1', {
    type: 'note', title: 'Post 1', compiled_truth: 'content', timeline: '', frontmatter: {},
  });
  await engine.addLinksBatch([
    { from_slug: 'writing/post-1', to_slug: 'people/person-1', link_type: 'mentions', link_source: 'markdown', context: '' },
    { from_slug: 'writing/post-1', to_slug: 'companies/company-1', link_type: 'mentions', link_source: 'markdown', context: '' },
  ]);
}

describe('orphans pure data fn — IRON RULE byte-identical contract', () => {
  test('getOrphansData is the same function reference as findOrphans', () => {
    expect(getOrphansData).toBe(findOrphans);
  });

  test('findOrphans and getOrphansData produce deep-equal output', async () => {
    await seedFixture();
    const viaFindOrphans = await findOrphans(engine, { includePseudo: false });
    const viaGetOrphansData = await getOrphansData(engine, { includePseudo: false });
    expect(viaGetOrphansData).toEqual(viaFindOrphans);
  });

  test('includePseudo: false vs true changes excluded count', async () => {
    await seedFixture();
    const def = await findOrphans(engine, { includePseudo: false });
    const all = await findOrphans(engine, { includePseudo: true });
    expect(all.excluded).toBe(0);
    expect(def.excluded).toBeGreaterThan(0);
    expect(all.total_orphans).toBeGreaterThanOrEqual(def.total_orphans);
  });

  test('CLI --json output deep-equals findOrphans return value', async () => {
    await seedFixture();
    const direct = await findOrphans(engine, { includePseudo: false });
    captureConsoleLog();
    try {
      await runOrphans(engine, ['--json']);
    } finally {
      restoreConsoleLog();
    }
    expect(logBuffer.length).toBe(1);
    const cliOutput = JSON.parse(logBuffer[0]!);
    // IRON RULE: CLI --json output must deep-equal the pure-fn output.
    // If a future change adds CLI-side post-filtering, this fires.
    expect(cliOutput).toEqual(direct);
  });

  test('CLI --count matches total_orphans from pure fn', async () => {
    await seedFixture();
    const direct = await findOrphans(engine, { includePseudo: false });
    captureConsoleLog();
    try {
      await runOrphans(engine, ['--count']);
    } finally {
      restoreConsoleLog();
    }
    expect(logBuffer.length).toBe(1);
    expect(logBuffer[0]).toBe(String(direct.total_orphans));
  });

  test('CLI --count with --include-pseudo matches pure-fn total_orphans (includePseudo: true)', async () => {
    await seedFixture();
    const direct = await findOrphans(engine, { includePseudo: true });
    captureConsoleLog();
    try {
      await runOrphans(engine, ['--count', '--include-pseudo']);
    } finally {
      restoreConsoleLog();
    }
    expect(logBuffer[0]).toBe(String(direct.total_orphans));
  });
});

describe('shouldExclude — orphan filter regression (preserve curation)', () => {
  test('pseudo-pages are excluded', () => {
    expect(shouldExclude('_atlas')).toBe(true);
    expect(shouldExclude('_index')).toBe(true);
    expect(shouldExclude('_orphans')).toBe(true);
  });

  test('auto-suffix patterns are excluded', () => {
    expect(shouldExclude('people/_index')).toBe(true);
    expect(shouldExclude('writing/log')).toBe(true);
  });

  test('raw segment is excluded', () => {
    expect(shouldExclude('media/x/raw/post')).toBe(true);
  });

  test('deny-prefixes are excluded', () => {
    expect(shouldExclude('templates/meeting')).toBe(true);
    expect(shouldExclude('dashboards/_index')).toBe(true);
    expect(shouldExclude('scripts/build')).toBe(true);
    expect(shouldExclude('output/foo')).toBe(true);
  });

  test('first-segment exclusions fire', () => {
    expect(shouldExclude('scratch/notes')).toBe(true);
    expect(shouldExclude('thoughts/today')).toBe(true);
    expect(shouldExclude('catalog/movies')).toBe(true);
    expect(shouldExclude('entities/anonymous')).toBe(true);
  });

  test('regular slugs are NOT excluded', () => {
    expect(shouldExclude('people/alice')).toBe(false);
    expect(shouldExclude('companies/acme')).toBe(false);
    expect(shouldExclude('writing/post-1')).toBe(false);
  });
});
