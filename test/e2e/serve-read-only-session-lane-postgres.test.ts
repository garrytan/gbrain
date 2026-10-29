/**
 * #7599: a harness runs one stdio `gbrain serve --access read-only` per session, so each one's resident direct pool held
 * session-lane connections (3 each) and a few sessions could starve the long-lived serve, worker and autopilot. A read-only
 * serve now takes the one-shot direct-pool profile and runs no resident write duty (persistence consumer, on-commit
 * notifier lease, sweeps), so it holds no session-lane connection after startup or after a search. A read-write serve
 * keeps its 3. The direct lane is tagged with an application_name so pg_stat_activity counts only it. Runs when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const WORD = 'quillmarsh';

describe.skipIf(!DATABASE_URL)('#7599 serve --access read-only on the session lane (postgres)', () => {
  let home: string;
  let env: Record<string, string>;
  let close: (() => Promise<void>) | undefined;
  let admin: PostgresEngine | null = null;
  let tag = '';
  let directBase = '';
  let serve: ChildProcess | null = null;

  const directConnections = async () => Number((await admin!.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [tag]))[0]!.n);

  async function startServe(access: 'read-only' | 'full'): Promise<{ call: (id: number, method: string, params: object) => Promise<any>; log: () => string }> {
    let log = '';
    let out = '';
    tag = `gbrain_direct_7599_${access.replace('-', '_')}_${process.pid}`;
    const direct = new URL(directBase);
    direct.searchParams.set('application_name', tag);
    const child = spawn('bun', ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--surface', 'full', '--access', access],
      { cwd: process.cwd(), env: { ...env, GBRAIN_DIRECT_DATABASE_URL: direct.toString() }, stdio: ['pipe', 'pipe', 'pipe'] });
    serve = child;
    child.stderr!.on('data', data => { log += String(data); });
    child.stdout!.on('data', data => { out += String(data); });
    const call = async (id: number, method: string, params: object) => {
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      for (let i = 0; i < 240; i++) {
        const line = out.split('\n').find(l => l.includes(`"id":${id}`));
        if (line) return JSON.parse(line);
        await Bun.sleep(250);
      }
      throw new Error(`no response to ${method}; serve log:\n${log}`);
    };
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-7599', version: '1' } });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { call, log: () => log };
  }

  async function stopServe(): Promise<void> {
    const child = serve;
    serve = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => { clearTimeout(deadline); resolve(); });
      child.stdin!.end();
    });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-7599-'));
    const isolated = await isolatedPersistencePostgres(DATABASE_URL!);
    close = isolated.close;
    await importFromContent(isolated.engine, 'notes/alpha-example', `---\ntitle: notes/alpha-example\ntype: note\n---\n\n${WORD} synthetic page.\n`, {
      sourceId: 'default', noEmbed: true,
      prepare: async prepared => { await withManagedFixtureWrite(isolated.engine, ['default'], tx => prepared.apply(tx)); return prepared.result; },
    });
    await isolated.engine.disconnect();
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: isolated.databaseUrl }));
    directBase = isolated.databaseUrl;
    env = keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined, GBRAIN_SOURCE: undefined,
      GBRAIN_DISABLE_DIRECT_POOL: undefined, GBRAIN_DIRECT_POOL_SIZE: undefined,
      GBRAIN_DIRECT_POOL_BY_COMMAND: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_RETRY_CONNECT: '1',
    });
    admin = new PostgresEngine();
    await admin.connect({ database_url: DATABASE_URL!, poolSize: 1 });
  }, 180_000);

  afterAll(async () => {
    await stopServe();
    await admin?.disconnect();
    await close?.();
    if (home) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('a read-only serve holds no session-lane connection after startup or after a search, and runs no resident write duty', async () => {
    const s = await startServe('read-only');
    // gstack-timing-ok: the contract is an absence (no session-lane connection ever opens); a read-write serve opens its 3 within this window
    await Bun.sleep(5_000);
    expect(await directConnections()).toBe(0);
    const found = await s.call(2, 'tools/call', { name: 'search', arguments: { query: WORD } });
    expect(JSON.stringify(found.result)).toContain('notes/alpha-example');
    // gstack-timing-ok: absence again, after a search; a lazily opened session lane would appear within this window
    await Bun.sleep(2_000);
    expect(await directConnections()).toBe(0);
    expect(s.log()).toContain('[gbrain-serve] read-only: no persistence consumer, on-commit sync or sweep runs here');
    expect(s.log()).not.toContain("owner of this host's notifier");
    await stopServe();
  }, 120_000);

  test('a read-write serve keeps its 3-connection resident direct pool and its notifier lease', async () => {
    const s = await startServe('full');
    let n = 0;
    for (let i = 0; i < 60 && n < 3; i++) { n = await directConnections(); if (n < 3) await Bun.sleep(500); }
    expect(n).toBe(3);
    for (let i = 0; i < 60 && !s.log().includes("owner of this host's notifier"); i++) await Bun.sleep(500);
    expect(s.log()).toContain("owner of this host's notifier");
    await stopServe();
  }, 120_000);
});
