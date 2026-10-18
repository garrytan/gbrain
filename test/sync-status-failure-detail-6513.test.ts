/**
 * Wave 16 G3.5 ([R13], #6513 comments, media-corpus): when a managed sync page
 * publication is refused by a database trigger gbrain does not know, the
 * failure the run records, the local ledger mirror, `gbrain sync status --json`
 * and the receipt all carry the bounded public detail (origin, sqlstate,
 * raiser, table, the closed `reason`), and none of them, nor the stored
 * receipt row, carries the trigger's message text. Before, the failure row and the status said only
 * `storage_error: Publication failed (P0001 in <raiser>). Inspect owner
 * diagnostics.`; the receipt's `write_error_detail` was the one place that
 * named the raiser and table.
 *
 * On PGLite and Postgres: an operator trigger on `pages` raises a P0001 whose
 * message starts with an identifier-shaped private token.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { formatManagedSyncFailure, readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { receiptFor } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const PRIVATE = 'private_person_example_42';
const home = mkdtempSync(join(tmpdir(), 'gbrain-6513-detail-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function fixture(engine: BrainEngine) {
  const id = `det-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), `---\ntitle: a\n---\nObservation a for the refused publication.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}
const leak = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v).includes(PRIVATE);
const PUBLIC = { origin: 'database_trigger', sqlstate: 'P0001', raiser: 'operator_hook_example', table: 'pages', reason: 'unknown', stage: 'publication' };

test('an unknown trigger refusal: failure row, ledger mirror, sync status and receipt carry raiser/table/reason, never the message text', async () => withEnv(env, async () => {
  for (const engine of engines) {
    rmSync(join(home, 'sync-failures.jsonl'), { force: true });
    const f = await fixture(engine);
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION operator_hook_example() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_id = '${f.id}' THEN RAISE EXCEPTION '${PRIVATE}: refused by an operator hook' USING TABLE = TG_TABLE_NAME; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('DROP TRIGGER IF EXISTS operator_hook_example ON pages');
    await engine.executeRaw('CREATE TRIGGER operator_hook_example BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION operator_hook_example()');
    try {
      const result = await performManagedSync(engine, f.opts);
      expect(result).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'storage_error', count: 1 }] });
      const failure = result.failures![0]!;
      expect(failure).toMatchObject({ code: 'storage_error', path: 'a.md', phase: 'receipt', write_error_detail: PUBLIC });
      expect(failure.message).toBe('Publication failed (P0001 in operator_hook_example: unknown). Inspect owner diagnostics.');
      expect(leak(result)).toBe(false);
      const formatted = formatManagedSyncFailure(failure);
      expect(formatted).toContain('raiser=operator_hook_example table=pages reason=unknown');
      expect(formatted).not.toContain(PRIVATE);
      // The durable failure row and the local ledger mirror.
      const [read] = await readManagedSyncFailures(engine, [f.id]);
      expect(read).toMatchObject({ code: 'storage_error', write_error_detail: PUBLIC });
      const mirrored = loadSyncFailures().filter(row => row.source_id === f.id);
      expect(mirrored).toHaveLength(1);
      expect(mirrored[0]!.error).toContain('raiser=operator_hook_example table=pages reason=unknown');
      expect(leak(mirrored)).toBe(false);
      // sync status: last_error.detail is the reason, write_error_detail the bounded public detail; the verdict is unchanged for storage_error.
      const status = await readSyncStatus(engine, f.id);
      expect(status.last_error).toMatchObject({ code: 'storage_error', detail: 'unknown', write_error_detail: PUBLIC, class: 'connection', safe_actions: ['retry'], needs_human: false });
      expect(leak(status)).toBe(false);
      // The receipt: the public projection matches, and the stored row (owner-only detail included) holds no part of the message.
      const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [failure.request_id]);
      expect(receiptFor(row!)).toMatchObject({ state: 'failed', write_error: 'storage_error', write_error_detail: PUBLIC });
      expect(leak(row)).toBe(false);
      expect(row!.error_detail).toMatchObject({ ...PUBLIC, attempt: { consumer_version: expect.any(String) } });
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS operator_hook_example ON pages');
      await engine.executeRaw('DROP FUNCTION IF EXISTS operator_hook_example()');
    }
  }
}), 240_000);
