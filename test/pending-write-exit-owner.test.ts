/**
 * #5232 / O-DX-1 against real writers: a resident PGLite owner whose consumer
 * is paused (the canonical worktree lock is held elsewhere) and the direct
 * path where the CLI opens the brain itself. Exit codes are asserted on real
 * CLI processes; the paused write commits once the lock is released and the
 * same request_id replays to the committed receipt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { startPersistenceIpcServer, persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withEnv } from './helpers/with-env.ts';
import { PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
let dir: string;
let config: { engine: 'pglite'; database_path: string };
let engine: PGLiteEngine;
const page = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}\n`;

async function cli(args: string[], stdin?: string, env: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1',
    GBRAIN_BACKUP_CHECK: '0', GBRAIN_WRITE_WAIT_MS: undefined, GBRAIN_ACCEPT_PENDING: undefined, ...env };
  for (const name of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE']) delete childEnv[name];
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: childEnv,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(watchdog); }
}

async function holdWorktree() {
  const binding = await getWorktreeBinding(engine, 'default');
  expect(binding).not.toBeNull();
  const lock = await acquireWorktree(binding!);
  expect(lock).not.toBeNull();
  return lock!;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gb-pending-owner-'));
  config = { engine: 'pglite', database_path: join(dir, 'db') };
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  mkdirSync(join(dir, 'brain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
  engine = new PGLiteEngine();
});
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('paused writers and the CLI exit contract', () => {
  test('resident owner: pending exits 10 with its receipt, opt-in exits 0, the same request_id commits after release', async () => {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.connect(config); await engine.initSchema();
      await engine.setConfig('sync.repo_path', join(dir, 'brain'));
      const provider = await createPersistenceIpcProvider(engine, config);
      const binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider);
      try {
        const seeded = await cli(['put', 'notes/seed', '--json'], page('Seed body.'));
        expect({ code: seeded.code, stderr: seeded.stderr }).toMatchObject({ code: 0 });
        const lock = await holdWorktree();
        const id = randomUUID();
        try {
          const pending = await cli(['put', 'notes/paused', '--request-id', id, '--wait', '1', '--json'], page('Paused body.'));
          expect({ code: pending.code, stderr: pending.stderr }).toMatchObject({ code: PENDING_WRITE_EXIT_CODE });
          expect(JSON.parse(pending.stdout).write_request).toMatchObject({ request_id: id });
          // #6255: the poll command is the envelope's receipt fix, pinned to the brain it ran against.
          expect(pending.stderr).toContain(`Poll: gbrain write-request --brain host -- ${id}`);
          expect(JSON.parse(pending.stdout).poll_command).toBe(JSON.parse(pending.stdout).fix.argv.join(' '));
          const accepted = await cli(['call', 'put_page', JSON.stringify({ slug: 'notes/paused', content: page('Paused body.'), request_id: id }),
            '--wait', '0', '--accept-pending']);
          expect({ code: accepted.code, stderr: accepted.stderr }).toMatchObject({ code: 0 });
          expect(JSON.parse(accepted.stdout).write_request.state).not.toBe('committed');
        } finally { await lock.release(); }
        const committed = await cli(['put', 'notes/paused', '--request-id', id, '--wait', '30', '--json'], page('Paused body.'));
        expect({ code: committed.code, stderr: committed.stderr }).toMatchObject({ code: 0 });
        expect(JSON.parse(committed.stdout)).toMatchObject({ request_id: id, state: 'committed' });
        const stale = await cli(['put', 'notes/seed', '--expected-revision', randomUUID(), '--json'], page('Stale body.'));
        expect({ code: stale.code }).toMatchObject({ code: 1 });
      } finally {
        if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
        await disposePersistenceConsumer(engine);
      }
    });
  }, 180_000);

  test('direct path: the CLI that opens the brain itself waits its --wait, then exits 10 or 0', async () => {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host' }, async () => {
      const lock = await holdWorktree();
      await engine.disconnect();
      const id = randomUUID();
      try {
        const started = Date.now();
        const pending = await cli(['put', 'notes/direct', '--request-id', id, '--wait', '2', '--json'], page('Direct body.'));
        expect({ code: pending.code, stderr: pending.stderr }).toMatchObject({ code: PENDING_WRITE_EXIT_CODE });
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
        expect(JSON.parse(pending.stdout).write_request.request_id).toBe(id);
        const accepted = await cli(['put', 'notes/direct', '--request-id', id, '--wait', '0', '--json'], page('Direct body.'),
          { GBRAIN_ACCEPT_PENDING: '1' });
        expect({ code: accepted.code, stderr: accepted.stderr }).toMatchObject({ code: 0 });
      } finally { await lock.release(); }
      const committed = await cli(['put', 'notes/direct', '--request-id', id, '--json'], page('Direct body.'));
      expect({ code: committed.code, stderr: committed.stderr }).toMatchObject({ code: 0 });
      expect(JSON.parse(committed.stdout).state).toBe('committed');
    });
  }, 180_000);
});
