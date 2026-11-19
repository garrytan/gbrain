/**
 * #5988 Lane A: managed sync publication uses the shared content screen.
 * A file whose frontmatter foresights can read by quoting (the issue's exact
 * `author:` line) syncs instead of blocking; a file it would have to guess at
 * is refused with the typed, location-only `Invalid YAML frontmatter:`
 * message, which sync output and `get_write_request` show as is, and which
 * `isContentRefusal` recognizes from the stored receipt.
 *
 * Sync holds such files by default (Lane 2); with sync.holds=fail this pins
 * the refusal the hold store and auto-conversion read.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { printSyncResult } from '../src/commands/sync.ts';
import { isContentRefusal } from '../src/core/import-screen.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-fm-recovery-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const author = 'PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a/status/1)';

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, files: Record<string, string>): Promise<string> {
  const id = `fm-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); await makeGitFixture(root);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture content');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}

test('a quote-recoverable file syncs with its exact value', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const id = await source(engine, { 'notes/roundup.md': `---\ntitle: Payments roundup\nauthor: ${author}\n---\nA synthetic roundup.\n` });
    try {
      const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
      expect(result.status).not.toBe('blocked_by_failures');
      const page = (await engine.readPageSnapshot('notes/roundup', { sourceId: id }))!.page;
      expect(page.frontmatter).toMatchObject({ author });
      expect(page.title).toBe('Payments roundup');
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }
}), 120_000);

test('a file that needs guessing refuses with the typed location-only message in sync output and the receipt', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const id = await source(engine, { 'notes/post.md': '---\ntitle: alice-example first line\nalice-example second line\n---\nA synthetic post.\n' });
    const expected = 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.';
    // #5988: sync holds such a file by default; sync.holds=fail keeps the fail-closed refusal this pins.
    await engine.setConfig('sync.holds', 'fail');
    try {
      const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
      expect(result).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'invalid_params' } });
      expect(result.managedWrite!.message.startsWith(expected)).toBe(true);
      let output = '';
      printSyncResult(result, { write: (text: string) => { output += text; return true; } } as NodeJS.WriteStream);
      expect(output).toContain(expected);
      expect(output).not.toContain('alice-example');

      const requestId = result.managedWrite!.write_request.request_id;
      const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: id, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      const receipt = await operations.find(op => op.name === 'get_write_request')!.handler(ctx, { request_id: requestId }) as Record<string, string>;
      expect(receipt).toMatchObject({ state: 'failed', write_error: 'invalid_params' });
      expect(receipt.write_error_message.startsWith(expected)).toBe(true);
      expect(isContentRefusal(receipt.write_error, receipt.write_error_message)).toBe(true);
    } finally {
      await engine.unsetConfig('sync.holds');
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }
}), 120_000);
