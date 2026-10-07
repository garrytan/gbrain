/**
 * #5946: the per-worker Postgres pools of parallel import and incremental
 * sync retry a handshake that missed postgres.js's connect timer.
 *
 * Those pools open only after the parent engine has connected to the same
 * database_url, so a CONNECT_TIMEOUT there is a starved handshake, not a bad
 * route. connectWithRetry takes that as an explicit opt-in
 * (`retryConnectTimeout`); every other caller still fails fast on it.
 *
 * Three layers:
 *   1. connectWithRetry's decision table against a scripted engine.
 *   2. A real PostgresEngine against a TCP endpoint that accepts and never
 *      answers, so the error postgres.js actually throws is the one matched.
 *   3. runImport --workers and the incremental sync drain, with the worker
 *      pools' connect() scripted through a prototype spy (no database).
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { runImport } from '../src/commands/import.ts';
import { connectWithRetry } from '../src/core/db.ts';
import { performSync } from '../src/commands/sync.ts';
import * as importFiles from '../src/core/import-file.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const handshakeTimeout = (where = 'undefined:undefined') =>
  Object.assign(new Error(`write CONNECT_TIMEOUT ${where}`), { code: 'CONNECT_TIMEOUT' });
const pgFailure = (code: string, message: string) => Object.assign(new Error(message), { code });

/** An engine whose connect() replays `script` (an Error throws, undefined succeeds), then succeeds. */
function scriptedEngine(script: Array<Error | undefined>) {
  const calls = { n: 0 };
  const engine = {
    async connect() {
      const step = script[calls.n++];
      if (step) throw step;
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

const CFG = { database_url: 'postgresql://worker.example.invalid/brain', poolSize: 2 };
const quiet = { baseDelayMs: 1, log: () => {} };

describe('connectWithRetry: retryConnectTimeout decides whether CONNECT_TIMEOUT earns another attempt', () => {
  const noRetryUnset = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_NO_RETRY_CONNECT: undefined }, fn);

  test('opted in: a single handshake timeout is retried and the connect succeeds', () => noRetryUnset(async () => {
    const warned: string[] = [];
    const { engine, calls } = scriptedEngine([handshakeTimeout('db.example.invalid:5432')]);
    await connectWithRetry(engine, CFG, { baseDelayMs: 1, log: line => warned.push(line), retryConnectTimeout: true });
    expect(calls.n).toBe(2);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('CONNECT_TIMEOUT');
  }));

  test('opted in: a timeout that keeps happening stops after three attempts with the last error', () => noRetryUnset(async () => {
    const last = handshakeTimeout();
    const { engine, calls } = scriptedEngine([handshakeTimeout(), handshakeTimeout(), last, undefined]);
    await expect(connectWithRetry(engine, CFG, { ...quiet, retryConnectTimeout: true })).rejects.toBe(last);
    expect(calls.n).toBe(3);
  }));

  const singleAttempt: Array<[string, Error, Record<string, unknown>]> = [
    ['no option: the general startup policy still fails fast on a timeout', handshakeTimeout(), {}],
    ['explicit false', handshakeTimeout(), { retryConnectTimeout: false }],
    ['a truthy non-boolean is not an opt-in', handshakeTimeout(), { retryConnectTimeout: 1 }],
    ['opted in, but noRetry wins', handshakeTimeout(), { retryConnectTimeout: true, noRetry: true }],
    ['opted in, a missing database is permanent', pgFailure('3D000', 'database "brain" does not exist'), { retryConnectTimeout: true }],
    ['opted in, a statement timeout is not a handshake timeout', pgFailure('57014', 'canceling statement due to statement timeout'), { retryConnectTimeout: true }],
    ['opted in, a lock timeout is not a handshake timeout', pgFailure('55P03', 'could not obtain lock on relation'), { retryConnectTimeout: true }],
  ];
  for (const [name, failure, extra] of singleAttempt) {
    test(`one attempt only: ${name}`, () => noRetryUnset(async () => {
      const { engine, calls } = scriptedEngine([failure]);
      await expect(connectWithRetry(engine, CFG, { ...quiet, ...extra })).rejects.toBe(failure);
      expect(calls.n).toBe(1);
    }));
  }

  test('opted in: GBRAIN_NO_RETRY_CONNECT=1 still makes it one attempt', () => withEnv({ GBRAIN_NO_RETRY_CONNECT: '1' }, async () => {
    const failure = handshakeTimeout();
    const { engine, calls } = scriptedEngine([failure]);
    await expect(connectWithRetry(engine, CFG, { ...quiet, retryConnectTimeout: true })).rejects.toBe(failure);
    expect(calls.n).toBe(1);
  }));

  test('opted in: the existing retryable class (a dropped connection) is still retried', () => noRetryUnset(async () => {
    const { engine, calls } = scriptedEngine([new Error('connection refused')]);
    await connectWithRetry(engine, CFG, { ...quiet, retryConnectTimeout: true });
    expect(calls.n).toBe(2);
  }));
});

describe('a real pool against an endpoint that never answers the handshake', () => {
  let server: Server;
  let dialed = 0;
  const held: Socket[] = [];

  beforeAll(async () => {
    server = createServer(socket => { dialed += 1; held.push(socket); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    for (const socket of held) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const silentUrl = () => `postgres://worker@127.0.0.1:${(server.address() as AddressInfo).port}/brain?connect_timeout=1`;
  const attempt = (opts: Parameters<typeof connectWithRetry>[2]) => withEnv({ GBRAIN_NO_RETRY_CONNECT: undefined }, async () => {
    dialed = 0;
    const engine = new PostgresEngine();
    try {
      return await connectWithRetry(engine, { database_url: silentUrl(), poolSize: 1 }, { baseDelayMs: 20, log: () => {}, ...opts })
        .then(() => undefined, (e: unknown) => e);
    } finally {
      await engine.disconnect().catch(() => {});
    }
  });

  test('opted in: postgres.js\'s own timeout is recognised and the pool dials three times', async () => {
    const error = await attempt({ retryConnectTimeout: true });
    expect((error as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect(dialed).toBe(3);
  }, 20_000);

  test('not opted in: the same timeout ends after one dial', async () => {
    const error = await attempt({});
    expect((error as { code?: string }).code).toBe('CONNECT_TIMEOUT');
    expect(dialed).toBe(1);
  }, 20_000);
});

describe('both worker-pool call sites retry a starved handshake', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-worker-pool-retry-'));
  const repo = join(home, 'notes');
  let brain: PGLiteEngine;
  let script: Array<Error | undefined> = [];
  let workerConnects = 0;

  const inHome = <T>(fn: () => Promise<T>) => withEnv({
    GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    GBRAIN_MAX_CONNECTIONS: undefined, GBRAIN_POOL_SIZE: undefined, GBRAIN_NO_RETRY_CONNECT: undefined,
  }, fn);
  const note = (name: string) =>
    writeFileSync(join(repo, `${name}.md`), `---\ntype: note\ntitle: ${name}\n---\n\nWorker pool fixture ${name}.\n`);
  const gitIn = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Example', '-c',
    'user.email=example@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
  /** The PGLite engine, presenting itself as Postgres so the parallel worker-pool branch runs. */
  const asPostgres = () => new Proxy(brain, {
    get: (target, key) => {
      const member = key === 'kind' ? 'postgres' : Reflect.get(target, key);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  }) as BrainEngine;
  const workerSpies = () => [
    spyOn(PostgresEngine.prototype, 'connect').mockImplementation(async () => {
      const step = script[workerConnects++];
      if (step) throw step;
    }),
    spyOn(PostgresEngine.prototype, 'disconnect').mockImplementation(async () => {}),
    spyOn(importFiles, 'importFile').mockImplementation(async (_eng, _file, relPath) =>
      ({ status: 'imported', slug: relPath.replace(/\.md$/, ''), chunks: 1 })),
    spyOn(console, 'warn').mockImplementation(() => {}),
  ];

  beforeAll(async () => {
    brain = new PGLiteEngine();
    await brain.connect({});
    await brain.initSchema();
    const configFile = join(home, '.gbrain', 'config.json');
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ engine: 'postgres', database_url: CFG.database_url }));
    mkdirSync(repo, { recursive: true });
    note('seed');
    execFileSync('git', ['init', '--quiet', repo]);
    gitIn('add', '-A');
    gitIn('commit', '--quiet', '-m', 'seed');
    await brain.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [repo, 'default']);
  }, 60_000);

  afterAll(async () => {
    await brain.disconnect();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => { script = []; workerConnects = 0; });

  const importWithTwoWorkers = () => inHome(() =>
    withSourceFilesystemLock(brain, repo, () => runImport(asPostgres(), ['--no-embed', '--workers', '2', repo])));

  test('import --workers: the first pool times out once, is redialled, and the import completes', async () => {
    const spies = workerSpies();
    script = [handshakeTimeout()];
    try {
      await importWithTwoWorkers();
      expect(workerConnects).toBe(3);
      expect(spies[2]).toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 30_000);

  test('import --workers: a permanent worker connect error is not retried', async () => {
    const spies = workerSpies();
    const permanent = pgFailure('3D000', 'database "brain" does not exist');
    script = [permanent];
    try {
      await expect(importWithTwoWorkers()).rejects.toBe(permanent);
      expect(workerConnects).toBe(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 30_000);

  test('incremental sync: a starved worker handshake is redialled and the source still syncs', () => inHome(async () => {
    const syncOf = { repoPath: repo, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
    const seeded = await performSync(brain, syncOf);
    expect(seeded.status).toBe('first_sync');
    note('one');
    note('two');
    gitIn('add', '-A');
    gitIn('commit', '--quiet', '-m', 'two notes');

    const spies = workerSpies();
    script = [undefined, handshakeTimeout('db.example.invalid:5432')];
    try {
      const result = await withSourceFilesystemLock(brain, repo, () =>
        performSync(asPostgres(), { ...syncOf, concurrency: 2, skipLock: true }));
      expect(result.status).toBe('synced');
      expect(result.added).toBe(2);
      expect(workerConnects).toBe(3);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }), 60_000);
});
