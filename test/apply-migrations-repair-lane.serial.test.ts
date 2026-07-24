/**
 * #2646 — apply-migrations drift-repair lane lifecycle test.
 *
 * Exercises the runner's detect → repair → recount path in-process:
 * v0.32.2 is ledger-'complete', active legacy rows exist (inserted
 * after the backfill by a lingering pre-fence writer), and
 * `runApplyMigrations --yes --migration 0.32.2` must repair them
 * WITHOUT touching the completed-migrations ledger, then report
 * up-to-date (exit 0) on the next run.
 *
 * Real PGLite via __setTestEngineOverride; GBRAIN_HOME sandboxes the
 * config + ledger paths (config.json lives at $GBRAIN_HOME/.gbrain/,
 * completed.jsonl at $GBRAIN_HOME/migrations/ — the two resolvers
 * differ, both honored here). process.exit is stubbed to a sentinel
 * throw so the runner's exit-code branches are assertable.
 *
 * Serial: mutates process.env.GBRAIN_HOME + process.exit.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setTestEngineOverride } from '../src/commands/migrations/v0_32_2.ts';
import { runApplyMigrations } from '../src/commands/apply-migrations.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let home: string;
let brainDir: string;
let ledgerPath: string;
let prevGbrainHome: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realExit: any;

class ExitSentinel extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);

  home = mkdtempSync(join(tmpdir(), 'repair-lane-test-'));
  // config.json: config.ts appends '.gbrain' to GBRAIN_HOME.
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_dimensions: 1536,
    }) + '\n',
  );
  // completed.jsonl: preferences.ts treats GBRAIN_HOME as the dir itself.
  mkdirSync(join(home, 'migrations'), { recursive: true });
  ledgerPath = join(home, 'migrations', 'completed.jsonl');
  writeFileSync(
    ledgerPath,
    JSON.stringify({ version: '0.32.2', status: 'complete', ts: '2026-01-01T00:00:00Z' }) + '\n',
  );
  prevGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;

  realExit = process.exit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => { throw new ExitSentinel(code); };
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = realExit;
  if (prevGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevGbrainHome;
  __setTestEngineOverride(null);
  await engine.disconnect();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'repair-lane-brain-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir],
  );
});

const ARGS = ['--yes', '--non-interactive', '--migration', '0.32.2'];

describe('apply-migrations drift-repair lane (#2646)', () => {
  test('detect → repair → recount: active legacy rows fenced, ledger untouched, next run up-to-date', async () => {
    // Post-migration drift: one active + one soft-expired legacy row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, expired_at)
       VALUES
         ('default', 'people/alice', 'post-migration active claim', 'fact', 'private', 'medium',
          now(), 'mcp:put_page', 1.0, NULL),
         ('default', 'people/alice', 'post-migration forgotten claim', 'fact', 'private', 'medium',
          now(), 'mcp:put_page', 1.0, now())`,
    );
    const ledgerBefore = readFileSync(ledgerPath, 'utf-8');

    // Run 1: v0.32.2 is 'complete' → normal plan has nothing to run →
    // the repair lane fires. Successful repair must NOT process.exit.
    await runApplyMigrations([...ARGS]);

    // The active row is fenced + stamped; the forgotten one untouched.
    const pagePath = join(brainDir, 'people/alice.md');
    expect(existsSync(pagePath)).toBe(true);
    const parsed = parseFactsFence(readFileSync(pagePath, 'utf-8'));
    expect(parsed.facts.map(f => f.claim)).toEqual(['post-migration active claim']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT fact, row_num, source_markdown_slug, expired_at FROM facts ORDER BY id`,
    );
    expect(rows.rows[0]).toMatchObject({
      fact: 'post-migration active claim', row_num: 1, source_markdown_slug: 'people/alice',
    });
    expect(rows.rows[0].expired_at).toBeNull();
    expect(rows.rows[1].row_num).toBeNull();
    expect(rows.rows[1].expired_at).not.toBeNull();

    // Ledger invariant: the repair never appends to completed.jsonl.
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(ledgerBefore);

    // Run 2: drift is drained → the runner reaches the up-to-date
    // branch, which exits 0.
    let sentinel: ExitSentinel | null = null;
    try {
      await runApplyMigrations([...ARGS]);
    } catch (e) {
      if (e instanceof ExitSentinel) sentinel = e;
      else throw e;
    }
    expect(sentinel).not.toBeNull();
    expect(sentinel!.code).toBe(0);
    // Ledger still untouched.
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(ledgerBefore);
  });

  test('--dry-run surfaces the drift as Would REPAIR and takes no action', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/bob', 'drifted claim', 'fact', 'private', 'medium',
               now(), 'mcp:put_page', 1.0)`,
    );

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
    let sentinel: ExitSentinel | null = null;
    try {
      await runApplyMigrations([...ARGS, '--dry-run']);
    } catch (e) {
      if (e instanceof ExitSentinel) sentinel = e;
      else throw e;
    } finally {
      console.log = realLog;
    }
    expect(sentinel).not.toBeNull();
    expect(sentinel!.code).toBe(0);
    expect(logged.some(l => l.includes('Would REPAIR'))).toBe(true);

    // No side effects: row unstamped, no page written.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(`SELECT row_num FROM facts`);
    expect(rows.rows[0].row_num).toBeNull();
    expect(existsSync(join(brainDir, 'people/bob.md'))).toBe(false);
  });

  test('no drift → plain up-to-date exit 0, repair lane stays silent', async () => {
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
    let sentinel: ExitSentinel | null = null;
    try {
      await runApplyMigrations([...ARGS]);
    } catch (e) {
      if (e instanceof ExitSentinel) sentinel = e;
      else throw e;
    } finally {
      console.log = realLog;
    }
    expect(sentinel).not.toBeNull();
    expect(sentinel!.code).toBe(0);
    // No repair messaging on the silent path.
    expect(logged.some(l => /repair/i.test(l))).toBe(false);
  });
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});
