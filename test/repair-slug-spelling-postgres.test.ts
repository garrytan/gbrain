/**
 * `gbrain repair slug-spelling` on Postgres: a write that is already under way against the page's stored spelling holds
 * that spelling's page lock, so the repair waits for it, and when that write changed the page the repair refuses
 * (`changed_since_preview`) instead of moving a page nobody approved.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: with a second connection holding the stored spelling's page lock and then editing the page, the repair
 *     started in between does not finish until that connection ends its transaction, then refuses `changed_since_preview`
 *     and leaves the page under its stored spelling.
 *  2. Regression: the repair locked the normal spelling twice and never the stored one, so such an edit could land after
 *     the repair's check and the page moved with the edit in it.
 *  3. Existing coverage: test/repair-slug-spelling.test.ts runs PGLite only (one connection, so it can only assert which
 *     locks were taken).
 *  4. Seam: none. Real Postgres, the repair command, and a second pool connection.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withStoredSlug } from '../src/core/utils.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const run = testBackends().includes('postgres') ? describe : describe.skip;
let engine: BrainEngine;
let close: () => Promise<void>;
const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-spelling-pg-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' };

beforeAll(async () => {
  if (!testBackends().includes('postgres')) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  engine = pg.engine; close = pg.close;
}, 180_000);
afterAll(async () => {
  if (engine) await disposePersistenceConsumer(engine);
  await close?.();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

async function repairJson(args: string[]) {
  const { runRepairCommand } = await import('../src/commands/repair.ts');
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = original; process.stdout.write = write; }
  return JSON.parse(printed).results[0] as { preview_hash: string; applied?: number };
}

run('postgres: the repair holds the stored spelling\'s page lock', () => {
  test('a write holding the stored spelling\'s lock makes the repair wait, and its edit refuses the move', () => withEnv(env, async () => {
    _resetCliExitVerdictForTests();
    const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const stored = 'Notes/Lock-Race';
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
    await engine.putPage('notes/seed-lock', { type: 'note', title: 'Lock race', compiled_truth: 'before', timeline: '' }, { sourceId });
    await engine.executeRaw('UPDATE pages SET slug=$1 WHERE slug=$2 AND source_id=$3', [stored, 'notes/seed-lock', sourceId]);
    const preview = await repairJson(['slug-spelling', '--source', sourceId]);

    let release!: () => void, held!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = new Promise<void>(resolve => { held = resolve; });
    // An edit in flight: it holds the stored spelling's page lock (as every writer of an existing page does), then edits the page.
    const edit = maintenanceTransaction(engine, tx => withStoredSlug(stored, async () => {
      await tx.lockPageKeys([{ sourceId, slug: stored }]);
      held();
      await gate;
      await tx.executeRaw("UPDATE pages SET compiled_truth='edited while the repair waited' WHERE source_id=$1 AND slug=$2", [sourceId, stored]);
    }));
    await holding;

    let settled = false;
    const apply = repairJson(['slug-spelling', '--source', sourceId, '--apply', '--expect', preview.preview_hash, '--yes']).then(
      value => { settled = true; return value; }, error => { settled = true; throw error; });
    apply.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(settled).toBe(false);
    release();
    await edit;
    const error = await apply.then(() => undefined, e => e as OperationError);
    expect(error?.code).toBe('changed_since_preview');
    expect((await engine.executeRaw<{ slug: string; compiled_truth: string }>('SELECT slug, compiled_truth FROM pages WHERE source_id=$1', [sourceId])))
      .toEqual([{ slug: stored, compiled_truth: 'edited while the repair waited' }]);
  }), 60_000);
});
