/**
 * #5720: a managed sync of a file whose frontmatter `slug:` conflicts with its
 * path names the conflict, the path's expected slug, the frontmatter slug and
 * the fix, in the sync output and in `gbrain write-request`, instead of the
 * generic "The write did not commit" fallback and an empty outcome.
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
import { writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-conflict-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

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

const expected = 'The frontmatter slug "books/other-chapter" in books/fairml/ch01.md conflicts with its path, which expects slug "books/fairml/ch01". Remove `slug:` or make it match the path.';

test('a frontmatter slug that conflicts with its path is named in sync output and in write-request', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const id = `slug-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
    mkdirSync(join(root, 'books/fairml'), { recursive: true }); await makeGitFixture(root);
    writeFileSync(join(root, 'books/fairml/ch01.md'), '---\ntitle: Chapter one\nslug: books/other-chapter\n---\nA synthetic chapter.\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture content');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
      expect(result).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'invalid_params', message: expected } });
      let output = '';
      printSyncResult(result, { write: (text: string) => { output += text; return true; } } as NodeJS.WriteStream);
      expect(output).toContain(expected);
      expect(output).not.toContain('The write did not commit');

      const requestId = result.managedWrite!.write_request.request_id;
      const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: id, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      const receipt = await operations.find(op => op.name === 'get_write_request')!.handler(ctx, { request_id: requestId });
      expect(receipt).toMatchObject({ request_id: requestId, state: 'failed', write_error: 'invalid_params', write_error_message: expected });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }
}), 120_000);

test('only the slug-conflict shape passes through; other invalid_params causes keep the generic diagnostic', () => {
  expect(writeFailureDiagnostic('invalid_params', expected)).toEqual({ reason: 'invalid_params', message: expected,
    suggestion: 'Correct the frontmatter in the file and commit the change.' });
  for (const message of [expected.replace('books/fairml/ch01.md', '/private/books/ch01.md'), 'limit must be an integer from 1 to 100.', `${expected} credential=redacted`]) {
    expect(writeFailureDiagnostic('invalid_params', message).message).toBe('The write did not commit. Inspect its durable request on the source host.');
  }
  expect(writeFailureDiagnostic('storage_error', expected).message).not.toContain('books/other-chapter');
});
