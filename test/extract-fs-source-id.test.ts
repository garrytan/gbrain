/**
 * #1747 — fs-walk extract on a non-default source.
 *
 * `gbrain import --source-id wiki` puts pages under source 'wiki', but the
 * fs-walk extractors (extractLinksFromDir / extractTimelineFromDir /
 * extractForSlugs) built batch rows with no source_id. addLinksBatch /
 * addTimelineEntriesBatch map missing → literal 'default', and their
 * `JOIN pages ON (slug, source_id)` dropped every row → "Links: created 0
 * from N pages" with no error. This file pins that the resolved source id
 * threads through both the CLI fs path (--source-id) and the library
 * runExtractCore path (incremental slugs — the cycle's route, #1503).
 *
 * Hermetic via PGLite in-memory. Canonical shared-engine block per
 * scripts/check-test-isolation.sh.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runExtract, runExtractCore } from '../src/commands/extract.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-fs-src-'));
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  // alice links to bob and carries a timeline bullet; bob links back.
  writeFileSync(
    join(brainDir, 'people', 'alice.md'),
    '# Alice\n\nMet [[people/bob]] today.\n\n## Timeline\n\n- **2026-01-05** | meeting — Discussed the wiki\n',
  );
  writeFileSync(join(brainDir, 'people', 'bob.md'), '# Bob\n\nFriend of [[people/alice]].\n');

  // Pages live ONLY in source 'wiki' (the `import --source-id wiki` shape).
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [brainDir],
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES
       ('people/alice', 'wiki', 'person', 'Alice', '', ''),
       ('people/bob', 'wiki', 'person', 'Bob', '', '')`,
  );
});

async function linkSourceIds(): Promise<Array<{ from_src: string; to_src: string }>> {
  return engine.executeRaw<{ from_src: string; to_src: string }>(
    `SELECT pf.source_id AS from_src, pt.source_id AS to_src
     FROM links l
     JOIN pages pf ON pf.id = l.from_page_id
     JOIN pages pt ON pt.id = l.to_page_id`,
  );
}

async function timelineCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM timeline_entries t JOIN pages p ON p.id = t.page_id AND p.source_id = 'wiki'`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe('fs-walk extract on a non-default source (#1747)', () => {
  test('CLI `extract all --source-id wiki` creates edges + timeline in the wiki source', async () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['all', '--dir', brainDir, '--source-id', 'wiki', '--json']);
    } finally {
      console.log = origLog;
    }

    const links = await linkSourceIds();
    expect(links.length).toBeGreaterThanOrEqual(2); // alice→bob, bob→alice
    for (const l of links) {
      expect(l.from_src).toBe('wiki');
      expect(l.to_src).toBe('wiki');
    }
    expect(await timelineCount()).toBeGreaterThanOrEqual(1);
  });

  test('CLI fs path auto-resolves the source from the registered dir (no --source-id)', async () => {
    // brainDir is the registered local_path of 'wiki' (and 'wiki' is the sole
    // non-default source) — the resolver chain must land on it without a flag.
    const origLog = console.log;
    console.log = () => {};
    try {
      await runExtract(engine, ['links', '--dir', brainDir, '--json']);
    } finally {
      console.log = origLog;
    }

    const links = await linkSourceIds();
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l.from_src).toBe('wiki');
  });

  test('runExtractCore incremental slugs path (the cycle route, #1503) stamps sourceId', async () => {
    const result = await runExtractCore(engine, {
      mode: 'all',
      dir: brainDir,
      slugs: ['people/alice', 'people/bob'],
      jsonMode: true,
      sourceId: 'wiki',
    });

    expect(result.links_created).toBeGreaterThanOrEqual(2);
    expect(result.timeline_entries_created).toBeGreaterThanOrEqual(1);
    const links = await linkSourceIds();
    for (const l of links) {
      expect(l.from_src).toBe('wiki');
      expect(l.to_src).toBe('wiki');
    }
    expect(await timelineCount()).toBeGreaterThanOrEqual(1);
  });

  test('regression shape: without a sourceId the batch JOIN drops every row (created 0)', async () => {
    // Pre-#1747 behavior, kept as the negative control: unstamped rows map to
    // 'default' where these pages don't exist, so nothing is inserted.
    const result = await runExtractCore(engine, {
      mode: 'all',
      dir: brainDir,
      slugs: ['people/alice', 'people/bob'],
      jsonMode: true,
    });
    expect(result.links_created).toBe(0);
    expect(result.timeline_entries_created).toBe(0);
  });
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
});
