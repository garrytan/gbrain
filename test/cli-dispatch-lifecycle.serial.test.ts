/**
 * Refactor wave 1 W4 (cli, EO5): engine lifecycle per dispatch path.
 *
 * Protects: for representative CLI paths, the ordered connect / remote-route /
 * drain / disconnect calls the dispatcher makes around the command handler:
 * post-connect records connect, run, then drain + disconnect (also when the
 * handler throws); `serve` is never torn down; pre-connect records never
 * connect unless their module opens its own engine (and then tears it down
 * itself); `--help` paths never connect; thin clients route remotely and
 * never connect; a connect failure runs no handler and no teardown; a dead
 * Postgres serve recovers into degraded mode; the read-only `sources list`
 * path and the shared-operation path drain + disconnect after a failure.
 * Fails when: the command table or the pipeline stages move a record across
 * the connectEngine() terminator, lose the fall-through teardown, tear down
 * `serve`, or connect on a thin client or for help.
 * Why new: the W0 goldens pin dispatch shape and outputs, not the engine
 * lifecycle calls between them. Seam: main() via the cli `__testing` export,
 * with the engine factory and a few command modules replaced by recorders
 * (mock.module, hence the serial lane) and `fetch` recording every remote
 * call. The same expectations hold on master (verified before the move).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const events: string[] = [];
let connectError: Error | null = null;

function fakeEngine(): Record<string, unknown> {
  return {
    kind: 'pglite',
    connect: async () => {
      events.push('connect');
      if (connectError) throw connectError;
    },
    disconnect: async () => { events.push('disconnect'); },
    // hasPendingMigrations reads `version`; a far-future value means none pending.
    getConfig: async (key: string) => (key === 'version' ? '100000' : null),
    setConfig: async () => {},
    initSchema: async () => {},
  };
}

const recordHandler = (name: string) => async (..._args: unknown[]) => { events.push(`handler:${name}`); };

mock.module('../src/core/engine-factory.ts', () => ({ createEngine: async () => fakeEngine() }));
mock.module('../src/commands/orphans.ts', () => ({ runOrphans: recordHandler('orphans') }));
mock.module('../src/commands/salience.ts', () => ({
  runSalience: async () => { events.push('handler:salience'); throw new Error('synthetic handler failure'); },
}));
mock.module('../src/commands/serve.ts', () => ({ runServe: recordHandler('serve') }));
mock.module('../src/commands/lint.ts', () => ({ runLint: recordHandler('lint') }));
mock.module('../src/commands/compile-context.ts', () => ({
  runCompileContext: async () => { events.push('handler:compile-context'); return 0; },
}));
mock.module('../src/commands/sync.ts', () => ({ runSync: recordHandler('sync') }));
mock.module('../src/commands/sources.ts', () => ({ runSources: recordHandler('sources') }));

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_NO_RETRY_CONNECT', 'GBRAIN_SERVE_DEGRADED', 'GBRAIN_REMOTE_CLIENT_SECRET'];
let main: () => Promise<void>;

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config, null, 2));
}

const LOCAL = { engine: 'pglite', database_path: '/nonexistent/gbrain-lifecycle/brain.pglite' };
const DEAD_POSTGRES = { engine: 'postgres', database_url: 'postgresql://nobody@127.0.0.1:1/none' };
const THIN = {
  engine: 'postgres',
  remote_mcp: { issuer_url: 'http://127.0.0.1:1', mcp_url: 'http://127.0.0.1:1/mcp', oauth_client_id: 'cid', oauth_client_secret: 'csecret' },
};

/** Run `gbrain <argv>` in-process; returns the recorded events plus how it ended. */
async function run(argv: string[]): Promise<string[]> {
  events.length = 0;
  const savedArgv = process.argv;
  process.argv = [savedArgv[0]!, 'gbrain', ...argv];
  try {
    await main();
    events.push('returned');
  } catch (e) {
    events.push(e instanceof ExitSignal ? `exit:${e.code}` : `threw:${(e as Error).message}`);
  } finally {
    process.argv = savedArgv;
  }
  // Collapse consecutive duplicates (one remote attempt may be several fetches).
  return events.filter((e, i) => e !== events[i - 1]);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'gbrain-cli-lifecycle-'));
  process.env.HOME = home;
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_REMOTE_CLIENT_SECRET;
  delete process.env.GBRAIN_SERVE_DEGRADED;
  process.env.GBRAIN_NO_RETRY_CONNECT = '1';
  const { __registerDrainerForTest } = await import('../src/core/background-work.ts');
  __registerDrainerForTest({
    name: 'lifecycle-recorder',
    order: 99,
    drain: async () => { events.push('drain'); return { unfinished: 0 }; },
  });
  main = (await import('../src/cli.ts')).__testing.main;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

let restores: Array<() => void> = [];
beforeEach(() => {
  connectError = null;
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never);
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    events.push('remote-route');
    throw new TypeError('fetch failed: connection refused (test)');
  }) as never);
  const quiet = (['log', 'error', 'warn'] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
  const write = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  restores = [() => exit.mockRestore(), () => fetchSpy.mockRestore(), () => write.mockRestore(), ...quiet.map((q) => () => q.mockRestore())];
});
afterEach(() => {
  for (const r of restores) r();
  // Failure paths set the CLI exit verdict (mirrored onto process.exitCode);
  // the test process must not inherit it.
  process.exitCode = 0;
});

describe('CLI dispatch lifecycle (connect / remote-route / drain / disconnect)', () => {
  test('post-connect record: connect, handler, drain, disconnect', async () => {
    writeConfig(LOCAL);
    expect(await run(['orphans'])).toEqual(['connect', 'handler:orphans', 'drain', 'disconnect', 'returned']);
  });

  test('post-connect record that throws still drains and disconnects', async () => {
    writeConfig(LOCAL);
    expect(await run(['salience'])).toEqual(['connect', 'handler:salience', 'drain', 'disconnect', 'threw:synthetic handler failure']);
  });

  test('serve is never torn down by the dispatcher', async () => {
    writeConfig(LOCAL);
    expect(await run(['serve'])).toEqual(['connect', 'handler:serve', 'returned']);
  });

  test('engine-free pre-connect record never connects', async () => {
    writeConfig(LOCAL);
    expect(await run(['lint', 'notes'])).toEqual(['handler:lint', 'returned']);
  });

  test('own-engine pre-connect record connects and tears its engine down itself', async () => {
    writeConfig(LOCAL);
    expect(await run(['compile-context', '--target', 'codex'])).toEqual(['connect', 'handler:compile-context', 'drain', 'disconnect', 'returned']);
  });

  test('--help never connects: self-help route and the generic stub', async () => {
    writeConfig(LOCAL);
    expect(await run(['sync', '--help'])).toEqual(['handler:sync', 'returned']);
    expect(await run(['orphans', '--help'])).toEqual(['returned']);
  });

  test('connect failure runs no handler and no teardown', async () => {
    writeConfig(LOCAL);
    connectError = new Error('synthetic connect failure');
    expect(await run(['orphans'])).toEqual(['connect', 'threw:synthetic connect failure']);
  });

  test('a dead Postgres serve recovers into degraded mode without teardown', async () => {
    writeConfig(DEAD_POSTGRES);
    connectError = new Error('synthetic connect failure');
    expect(await run(['serve'])).toEqual(['connect', 'handler:serve', 'returned']);
  });

  test('read-only sources list: connect, handler, drain, disconnect', async () => {
    writeConfig(LOCAL);
    expect(await run(['sources', 'list'])).toEqual(['connect', 'handler:sources', 'drain', 'disconnect', 'returned']);
  });

  test('thin client: a routable subcommand goes remote and never connects', async () => {
    writeConfig(THIN);
    const seen = await run(['takes', 'list']);
    expect(seen[0]).toBe('remote-route');
    expect(seen).not.toContain('connect');
  });

  test('thin client: a refused command never connects and exits 1', async () => {
    writeConfig(THIN);
    expect(await run(['sync'])).toEqual(['exit:1']);
  });

  test('thin client: a shared operation routes remotely and never connects', async () => {
    writeConfig(THIN);
    const seen = await run(['get', 'alice-example']);
    expect(seen[0]).toBe('remote-route');
    expect(seen).not.toContain('connect');
  });

  test('shared operation failure on a local brain still drains and disconnects', async () => {
    writeConfig(LOCAL);
    const seen = await run(['get', 'alice-example']);
    expect(seen.slice(0, 1)).toEqual(['connect']);
    expect(seen.slice(-3)).toEqual(['drain', 'disconnect', 'returned']);
  });
});
