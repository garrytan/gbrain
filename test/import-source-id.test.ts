/**
 * v0.37.7.0 #1167 — `gbrain import --source-id <id>` routes to a brain source.
 *
 * Pre-fix, `gbrain import --source dept-x ./pages` silently fell back to
 * `default` because the CLI parser didn't consume `--source` at all
 * (PR #707's design intent explicitly excluded it). Users had no signal
 * their pages were being written to the wrong place.
 *
 * Fix: add `--source-id <id>` parsing. The flag is named --source-id
 * (not --source) to avoid colliding with future axes; matches the
 * v0.37.7.0 extract.ts convention from T2.
 *
 * Hermetic PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncatePages(): Promise<void> {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('import --source-id (#1167)', () => {
  let scratchDir: string;
  beforeEach(async () => {
    await truncatePages();
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    scratchDir = mkdtempSync(join(tmpdir(), 'gbrain-import-src-'));
    mkdirSync(join(scratchDir, 'wiki'), { recursive: true });
    writeFileSync(
      join(scratchDir, 'wiki', 'alpha.md'),
      '---\ntype: note\n---\n# Alpha\n\nContent of alpha.',
    );
    writeFileSync(
      join(scratchDir, 'wiki', 'beta.md'),
      '---\ntype: note\n---\n# Beta\n\nContent of beta.',
    );
  });

  test('without --source-id, pages land in default source', async () => {
    await runImport(engine, [scratchDir, '--no-embed', '--json']);
    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages ORDER BY slug`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.source_id).toBe('default');
    }
  });

  test('--source-id dept-x routes pages to dept-x source', async () => {
    await runImport(engine, [scratchDir, '--source-id', 'dept-x', '--no-embed', '--json']);
    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages ORDER BY slug`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.source_id).toBe('dept-x');
    }
  });

  // The --json payload reports counts; without a destination field a caller
  // (gstack's memory-ingest is the one in tree — see
  // test/import-json-stdout.serial.test.ts) cannot tell a routed import from
  // one that fell through the resolver to `default`. Both directions are
  // pinned so the field can't be "fixed" by hardcoding either answer.
  async function importPayload(args: string[]): Promise<Record<string, unknown>> {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await runImport(engine, args);
    } finally {
      console.log = origLog;
    }
    const jsonLine = lines.find((l) => l.trimStart().startsWith('{'));
    expect(jsonLine).toBeDefined();
    return JSON.parse(jsonLine!) as Record<string, unknown>;
  }

  test('--json payload names default as the destination when unrouted', async () => {
    const payload = await importPayload([scratchDir, '--no-embed', '--json']);
    expect(payload.source_id).toBe('default');
  });

  test('--json payload names the routed source', async () => {
    const payload = await importPayload([scratchDir, '--source-id', 'dept-x', '--no-embed', '--json']);
    expect(payload.source_id).toBe('dept-x');
  });

  test('--source-id value is NOT treated as a positional dir arg', async () => {
    // Regression: flag-value-as-dirArg was a real bug class in early
    // CLI parsers. Pre-fix the parser at line 82-83 would have
    // matched 'dept-x' as dirArg (since dept-x doesn't start with --).
    // The flagValues set now excludes the arg at sourceIdIdx+1.
    let threw = false;
    try {
      await runImport(engine, ['--source-id', 'dept-x', scratchDir, '--no-embed', '--json']);
    } catch (e) {
      threw = true;
    }
    // Should NOT throw "Usage: gbrain import <dir>..." because scratchDir
    // is still recognized as the positional dir.
    expect(threw).toBe(false);
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages LIMIT 1`,
    );
    expect(rows[0]?.source_id).toBe('dept-x');
  });
});
