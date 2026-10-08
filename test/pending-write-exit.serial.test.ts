/**
 * #5232 / O-DX-1 / O-ENG-1: the CLI write exit contract, asserted on real CLI
 * processes. Committed → 0; admitted but pending → PENDING_WRITE_EXIT_CODE
 * (0 with --accept-pending or GBRAIN_ACCEPT_PENDING=1); terminal failure → 1;
 * pre-admission refusal → 1 even with the opt-in; lost transport → 1 with an
 * unknown submission, distinct from pending. Covers generated write commands,
 * `gbrain call` and custom mutation commands over a resident-owner socket and
 * an HTTP thin client. The direct path runs in pending-write-exit-owner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPersistenceIpcServer, persistenceSocketPathForConfig, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { MIGRATIONS_RUNNING_EXIT_CODE, PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';
import { describeMigrationFailure } from '../src/commands/upgrade.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const ID = '20000000-0000-4000-8000-000000000001';
const CLI = join(import.meta.dir, '../src/cli.ts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Outcome = 'committed' | 'pending' | 'pending_once' | 'failed' | 'closing' | 'silent';

async function spawnCli(dir: string, args: string[], env: Record<string, string | undefined> = {}, stdin?: string) {
  const childEnv: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host',
    GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_WRITE_WAIT_MS: undefined, GBRAIN_ACCEPT_PENDING: undefined, ...env };
  for (const name of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE']) delete childEnv[name];
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: childEnv, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe', stderr: 'pipe' });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(watchdog); }
}

function pendingError(requestId: string) {
  const error = new OperationError('write_pending', 'The write is accepted and is still pending.', 'Poll get_write_request.');
  error.writeRequest = { request_id: requestId, state: 'running', retry_after_ms: 100 };
  error.writeError = 'write_pending';
  return error;
}

/** A resident owner socket whose answer per call is scripted. */
async function withOwner(outcome: Outcome, run: (dir: string, calls: PersistenceIpcRequest[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gb-pending-exit-'));
  dirs.push(dir);
  const databasePath = join(dir, 'db');
  const config = { engine: 'pglite' as const, database_path: databasePath };
  mkdirSync(join(dir, '.gbrain', 'persistence'), { recursive: true });
  mkdirSync(databasePath, { recursive: true });
  const lock = await acquireLock(databasePath);
  const metadataPath = lock.lockPath ?? join(databasePath, '.gbrain-lock', 'lock');
  writeFileSync(metadataPath, JSON.stringify({ ...JSON.parse(readFileSync(metadataPath, 'utf8')), subcommand: 'serve' }));
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.gbrain', 'persistence', `${BRAIN}.cli.json`), JSON.stringify({ id: BRAIN, credential: 'a'.repeat(64), lane: 'cli' }), { mode: 0o600 });
  const calls: PersistenceIpcRequest[] = [];
  const binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, {
    brainId: BRAIN,
    dispatch: async request => {
      calls.push(request);
      const requestId = request.params.request_id as string;
      if (outcome === 'silent') return new Promise(() => {});
      if (outcome === 'closing') throw new OperationError('unavailable', 'The persistence owner is closing. Retry the same request_id after restart.');
      if (outcome === 'pending' || outcome === 'pending_once' && calls.length === 1) throw pendingError(requestId);
      if (outcome === 'failed') {
        const error = new OperationError('revision_conflict', 'The page changed.', 'Read the page again.');
        error.writeRequest = { request_id: requestId, state: 'conflict', retry_after_ms: null };
        error.writeError = 'revision_conflict';
        throw error;
      }
      const receipt = { request_id: requestId, state: 'committed', retry_after_ms: null };
      return { ...receipt, slug: request.params.slug ?? 'inbox/example', status: 'created_or_updated', write_request: receipt };
    },
  });
  try { await run(dir, calls); }
  finally {
    if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
    await releaseLock(lock);
  }
}

const COMMANDS: Array<[string, (dir: string) => string[], string?]> = [
  ['generated put', () => ['put', 'notes/example', '--request-id', ID, '--json'], '---\ntitle: Example\n---\n\nBody.\n'],
  ['gbrain call', () => ['call', 'put_page', JSON.stringify({ slug: 'notes/example', content: 'Body.', request_id: ID })]],
  ['custom capture', dir => { writeFileSync(join(dir, 'in.md'), '# Example\n'); return ['capture', '--file', join(dir, 'in.md'), '--request-id', ID, '--json']; }],
];

describe('resident owner: pending-write exit codes', () => {
  for (const [label, args, stdin] of COMMANDS) {
    test(`${label}: committed 0, pending ${PENDING_WRITE_EXIT_CODE}, opt-in 0, failure 1`, async () => {
      const cases: Array<[Outcome, string[], Record<string, string>, number]> = [
        ['committed', [], {}, 0],
        ['pending', [], { GBRAIN_WRITE_WAIT_MS: '0' }, PENDING_WRITE_EXIT_CODE],
        ['pending', ['--accept-pending'], { GBRAIN_WRITE_WAIT_MS: '0' }, 0],
        ['pending', [], { GBRAIN_WRITE_WAIT_MS: '0', GBRAIN_ACCEPT_PENDING: '1' }, 0],
        ['pending', ['--no-accept-pending'], { GBRAIN_WRITE_WAIT_MS: '0', GBRAIN_ACCEPT_PENDING: '1' }, PENDING_WRITE_EXIT_CODE],
        ['failed', ['--accept-pending'], {}, 1],
        ['closing', ['--accept-pending'], { GBRAIN_ACCEPT_PENDING: '1' }, 1],
      ];
      for (const [outcome, extra, env, expected] of cases) {
        await withOwner(outcome, async (dir, calls) => {
          const result = await spawnCli(dir, [...args(dir), ...extra], env, stdin);
          expect({ outcome, extra, env, code: result.code, stderr: result.stderr }).toMatchObject({ code: expected });
          expect(calls).toHaveLength(1);
          if (outcome === 'pending') {
            const body = JSON.parse(result.stdout);
            expect(body.write_request).toMatchObject({ request_id: ID, state: 'running' });
            expect(body).toMatchObject({ request_id: ID, state: 'running' });
            // #6255: the poll command is the envelope's receipt fix, pinned to the brain it ran against.
            expect(body.poll_command).toBe(`gbrain write-request --brain host -- ${ID}`);
            expect(body.poll_command).toBe(body.fix.argv.join(' '));
            expect(result.stderr).toContain(`Poll: gbrain write-request --brain host -- ${ID}`);
          }
        });
      }
    }, 120_000);
  }

  test('the CLI wait travels to the owner and bounds one exchange with admission headroom', async () => {
    await withOwner('committed', async (dir, calls) => {
      expect((await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID }), '--wait', '45'])).code).toBe(0);
      expect((await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID })], { GBRAIN_WRITE_WAIT_MS: '7000' })).code).toBe(0);
      expect((await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID })])).code).toBe(0);
      // An explicit --timeout shorter than wait + headroom asks the owner to stop early.
      expect((await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID }), '--timeout=20s'])).code).toBe(0);
      const waits = calls.map(call => call.write_wait_ms);
      expect(waits[0]).toBeGreaterThan(44_000);
      expect(waits[0]).toBeLessThanOrEqual(45_000);
      expect(waits[1]).toBeGreaterThan(6_000);
      expect(waits[1]).toBeLessThanOrEqual(7_000);
      expect(waits[2]).toBeGreaterThan(29_000);
      expect(waits[2]).toBeLessThanOrEqual(30_000);
      expect(waits[3]).toBeLessThanOrEqual(5_000);
    });
  }, 60_000);

  test('a pending answer is replayed with the same request_id while the wait lasts', async () => {
    await withOwner('pending_once', async (dir, calls) => {
      const result = await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID }), '--wait', '5']);
      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(JSON.parse(result.stdout).write_request.state).toBe('committed');
      expect(calls).toHaveLength(2);
      expect(calls.map(call => call.params.request_id)).toEqual([ID, ID]);
    });
  }, 60_000);

  test('a lost response is an unknown submission, not a pending write', async () => {
    await withOwner('silent', async (dir) => {
      const result = await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID }), '--timeout=1s', '--accept-pending']);
      expect(result.code).toBe(1);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({ request_id: ID, submission_status: 'unknown' });
      expect(body).not.toHaveProperty('write_request');
    });
  }, 60_000);

  test('a malformed --wait or GBRAIN_WRITE_WAIT_MS refuses before any write is sent, naming the fix', async () => {
    await withOwner('committed', async (dir, calls) => {
      const result = await spawnCli(dir, ['call', 'put_page', '{}', '--wait', 'soon']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('--wait requires a number of seconds');
      const env = await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A' })], { GBRAIN_WRITE_WAIT_MS: 'soon' });
      expect(env.code).toBe(1);
      expect(JSON.parse(env.stdout)).toMatchObject({ error: 'invalid_write_wait', docs: 'docs/guides/write-refusals.md#invalid_write_wait' });
      expect(env.stderr).toContain('Fix: unset GBRAIN_WRITE_WAIT_MS');
      expect(calls).toHaveLength(0);
    });
  }, 30_000);

  test('plain output names the request, the poll command and the exit status', async () => {
    await withOwner('pending', async (dir) => {
      const result = await spawnCli(dir, ['call', 'put_page', JSON.stringify({ slug: 'notes/a', content: 'A', request_id: ID }), '--wait', '0']);
      expect(result.code).toBe(PENDING_WRITE_EXIT_CODE);
      expect(result.stderr).toContain(`Request: ${ID} (running)`);
      expect(result.stderr).toContain(`Poll: gbrain write-request --brain host -- ${ID}`);
      expect(result.stderr).toContain('#cli-exit-status-for-writes');
    });
  }, 30_000);
});

/** A loopback MCP server scripted like the owner fixture (HTTP thin client). */
async function withThinServer(outcome: Outcome, run: (dir: string, calls: Record<string, unknown>[]) => Promise<void>) {
  const calls: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const base = `http://127.0.0.1:${server.port}`;
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, token_endpoint: `${base}/token` });
    if (path === '/token') return Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, scope: 'read write' });
    if (path !== '/mcp' || request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.json() as any;
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
    const args = body.params.arguments as Record<string, unknown>;
    calls.push(args);
    const receipt = (state: string) => ({ request_id: args.request_id, state, retry_after_ms: state === 'running' ? 100 : null });
    const error = (envelope: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id: body.id,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] } });
    if (outcome === 'pending' || outcome === 'pending_once' && calls.length === 1) return error({ error: 'write_pending',
      message: 'The write is accepted and is still pending.', write_error: 'write_pending', write_request: receipt('running') });
    if (outcome === 'failed') return error({ error: 'revision_conflict', message: 'The page changed.', write_error: 'revision_conflict', write_request: receipt('conflict') });
    if (outcome === 'closing') return error({ error: 'unavailable', message: 'The persistence owner is closing.' });
    const committed = receipt('committed');
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text',
      text: JSON.stringify({ ...committed, slug: args.slug ?? 'inbox/example', status: 'created_or_updated', write_request: committed }) }] } });
  } });
  const dir = mkdtempSync(join(tmpdir(), 'gb-pending-thin-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.gbrain'));
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', remote_mcp: {
    issuer_url: `http://127.0.0.1:${server.port}`, mcp_url: `http://127.0.0.1:${server.port}/mcp`,
    oauth_client_id: 'fixture', oauth_client_secret: 'fixture' } }));
  try { await run(dir, calls); } finally { await server.stop(true); }
}

describe('HTTP thin client: pending-write exit codes', () => {
  const thin: Array<[string, string[], string?]> = [
    ['generated put', ['put', 'notes/example', '--json'], '---\ntitle: Example\n---\n\nBody.\n'],
    ['custom capture', ['capture', 'An example note', '--json']],
    ['custom takes add', ['takes', 'add', 'notes/example', '--claim', 'Example', '--kind', 'take', '--who', 'world', '--json']],
  ];
  for (const [label, args, stdin] of thin) {
    test(`${label}: committed 0, pending ${PENDING_WRITE_EXIT_CODE}, opt-in 0, failure 1, refusal 1`, async () => {
      const cases: Array<[Outcome, string[], Record<string, string>, number]> = [
        ['committed', [], {}, 0],
        ['pending', ['--wait', '0'], {}, PENDING_WRITE_EXIT_CODE],
        ['pending', ['--wait', '0', '--accept-pending'], {}, 0],
        ['failed', ['--accept-pending'], {}, 1],
        ['closing', [], { GBRAIN_ACCEPT_PENDING: '1' }, 1],
      ];
      for (const [outcome, extra, env, expected] of cases) {
        await withThinServer(outcome, async (dir, calls) => {
          const result = await spawnCli(dir, [...args, ...extra], env, stdin);
          expect({ outcome, extra, code: result.code, stderr: result.stderr }).toMatchObject({ code: expected });
          expect(calls).toHaveLength(1);
        });
      }
    }, 120_000);
  }

  test('the CLI wait outlasts the server wait by replaying the same request_id', async () => {
    await withThinServer('pending_once', async (dir, calls) => {
      const result = await spawnCli(dir, ['capture', 'An example note', '--json', '--wait', '5']);
      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(calls).toHaveLength(2);
      expect(calls[0].request_id).toBe(calls[1].request_id);
    });
  }, 60_000);
});

test('a pending post-upgrade write is not reported as a migration-lock conflict (O-ENG-1)', async () => {
  expect(PENDING_WRITE_EXIT_CODE).not.toBe(MIGRATIONS_RUNNING_EXIT_CODE);
  expect(await describeMigrationFailure({ status: MIGRATIONS_RUNNING_EXIT_CODE }, '')).toContain('in another apply-migrations');
  expect(await describeMigrationFailure({ status: PENDING_WRITE_EXIT_CODE }, '')).not.toContain('in another apply-migrations');
});
