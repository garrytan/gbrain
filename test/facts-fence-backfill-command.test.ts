/**
 * #1867 — `gbrain facts fence-backfill` command tests.
 *
 * The command re-runs the (idempotent) v0_32_2 phase B on demand so
 * row_num-NULL backlogs — remote extract_facts deposits that predate
 * the fence-write backstop — can be cleared without re-running the
 * one-shot migration. Real PGLite + real tempdir filesystem.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsCommand } from '../src/commands/facts.ts';
import { phaseBFenceFacts } from '../src/commands/migrations/v0_32_2.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'facts-backfill-cmd-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

async function seedLegacyFact(fact: string): Promise<void> {
  // The row_num-NULL shape a remote extract_facts deposit leaves behind
  // when it lands via the legacy DB-only path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ('default', 'people/alice', $1, 'fact', 'private', 'medium',
             now(), 'mcp:extract_facts', 1.0)`,
    [fact],
  );
}

describe('gbrain facts fence-backfill', () => {
  test('fences row_num-NULL rows and stamps the DB', async () => {
    await seedLegacyFact('Deposited remotely');

    await runFactsCommand(engine, ['fence-backfill']);

    // The fence exists on disk with the claim.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Deposited remotely');

    // The backlog is cleared: no row_num-NULL rows remain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num, source_markdown_slug FROM facts',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].row_num).toBe(1);
    expect(rows.rows[0].source_markdown_slug).toBe('people/alice');
  });

  test('re-run is a no-op (idempotent)', async () => {
    await seedLegacyFact('Deposited remotely');
    await runFactsCommand(engine, ['fence-backfill']);
    await runFactsCommand(engine, ['fence-backfill']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT id FROM facts');
    expect(rows.rows).toHaveLength(1);
    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body.match(/Deposited remotely/g)).toHaveLength(1);
  });

  test('--dry-run reports without writing', async () => {
    await seedLegacyFact('Deposited remotely');
    await runFactsCommand(engine, ['fence-backfill', '--dry-run']);

    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts',
    );
    expect(rows.rows[0].row_num).toBeNull();
  });

  test('diverged page: appends past the DB row_num max instead of colliding (#2044 class)', async () => {
    // The #2044 divergence shape the backfill must survive: the DB already
    // holds stamped rows 1..3 for the slug (legacy wrong-path fence write),
    // but the fence at the resolved path is missing. Fence-max+1 (= 1) would
    // collide with the stamped rows on the post-rename UPDATE, failing the
    // page and leaving the renamed fence disagreeing with the DB.
    for (let n = 1; n <= 3; n++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                            valid_from, source, confidence, row_num, source_markdown_slug)
         VALUES ('default', 'people/alice', $1, 'fact', 'private', 'medium',
                 now(), 'mcp:extract_facts', 1.0, $2, 'people/alice')`,
        [`stamped ${n}`, n],
      );
    }
    await seedLegacyFact('Deposited remotely');

    const result = await phaseBFenceFacts(engine, { dryRun: false });
    expect(result.status).toBe('complete');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num FROM facts WHERE fact = 'Deposited remotely'`,
    );
    expect(rows.rows[0].row_num).toBe(4);
    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('| 4 | Deposited remotely |');
  });
});
