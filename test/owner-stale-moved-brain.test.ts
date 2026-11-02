/**
 * GBRA-248 W0a against the real CLI: a PGLite brain moved or restored under a
 * new host identity (its host.json did not come along, as with a fresh
 * container GBRAIN_HOME) queues writes for the old owner, which will never
 * publish them. The receipt names the stale owner (reason owner_unavailable, a diagnostic.owner block) with its last activity,
 * --accept-pending (flag and env) still exits 10, and doctor's
 * owner_host_stale warns. Before the move the same brain's opt-in exits 0.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withEnv } from './helpers/with-env.ts';
import { PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
let dir: string;
let config: { engine: 'pglite'; database_path: string };
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gb-owner-stale-'));
  config = { engine: 'pglite', database_path: join(dir, 'db') };
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  mkdirSync(join(dir, 'brain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
  await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const engine = new PGLiteEngine();
    await engine.connect(config); await engine.initSchema();
    await engine.setConfig('sync.repo_path', join(dir, 'brain'));
    await engine.disconnect();
  });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a moved PGLite brain and the pending-write contract', () => {
  test('on its owner a paused write is covered by --accept-pending; after the move its owner is stale and it exits 10', async () => {
    const seeded = await cli(['put', 'notes/seed', '--json'], page('Seed body.'));
    expect({ code: seeded.code, stderr: seeded.stderr }).toMatchObject({ code: 0 });

    // On the owner host: a write held behind the worktree lock is an ordinary pending write the opt-in covers.
    const heldId = randomUUID();
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host' }, async () => {
      const engine = new PGLiteEngine();
      await engine.connect(config);
      const binding = await getWorktreeBinding(engine, 'default');
      await engine.disconnect();
      const lock = (await acquireWorktree(binding!))!;
      try {
        const held = await cli(['put', 'notes/held', '--request-id', heldId, '--wait', '1', '--accept-pending', '--json'], page('Held body.'));
        expect({ code: held.code, stderr: held.stderr }).toMatchObject({ code: 0 });
        expect(JSON.parse(held.stdout).write_request.diagnostic?.owner).toBeUndefined();
      } finally { await lock.release(); }
    });
    const drained = await cli(['put', 'notes/held', '--request-id', heldId, '--wait', '30', '--json'], page('Held body.'));
    expect({ code: drained.code, stderr: drained.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(drained.stdout).state).toBe('committed');

    // The move: the brain's files arrive under a home whose host identity is new.
    rmSync(join(dir, '.gbrain', 'persistence', 'host.json'));
    const id = randomUUID();
    const pending = await cli(['put', 'notes/moved', '--request-id', id, '--wait', '1', '--accept-pending', '--json'], page('Moved body.'));
    expect({ code: pending.code, stderr: pending.stderr }).toMatchObject({ code: PENDING_WRITE_EXIT_CODE });
    const receipt = JSON.parse(pending.stdout).write_request;
    expect(receipt).toMatchObject({ request_id: id, diagnostic: { reason: 'owner_unavailable', next_action: 'inspect_owner' } });
    expect(Number.isFinite(Date.parse(receipt.diagnostic.owner.last_active))).toBe(true);
    expect(pending.stderr).toContain('quiet past the stale window');
    expect(pending.stderr).toContain('gbrain doctor --only owner_host_stale --json');

    const viaEnv = await cli(['put', 'notes/moved', '--request-id', id, '--wait', '0', '--json'], page('Moved body.'), { GBRAIN_ACCEPT_PENDING: '1' });
    expect({ code: viaEnv.code, stderr: viaEnv.stderr }).toMatchObject({ code: PENDING_WRITE_EXIT_CODE });
    const plain = await cli(['put', 'notes/moved', '--request-id', id, '--wait', '0', '--json'], page('Moved body.'));
    expect({ code: plain.code }).toMatchObject({ code: PENDING_WRITE_EXIT_CODE });

    const doctor = await cli(['doctor', '--only', 'owner_host_stale', '--json']);
    const check = (JSON.parse(doctor.stdout).checks as Array<Record<string, any>>).find(c => c.name === 'owner_host_stale')!;
    expect(check).toMatchObject({ status: 'warn', details: { count: 1 } });
    expect(check.details.stale[0]).toMatchObject({ source_ids: ['default'], foreign_file_holder: true, open_writes: 1 });
    expect(check.fix.argv.slice(0, 5)).toEqual(['gbrain', 'sources', 'writer', 'status', '--json']);
  }, 240_000);
});
