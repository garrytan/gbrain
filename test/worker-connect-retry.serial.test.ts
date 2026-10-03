/**
 * A per-worker pool connect survives one transient CONNECT_TIMEOUT.
 *
 * Parallel `import` (which `sync --full` runs) and incremental `sync` open one
 * PostgresEngine pool per worker, each a fresh TCP + TLS + auth handshake,
 * after the parent engine has already connected to the same URL. That connect
 * had no retry, and `isRetryableConnError` does not accept postgres.js's
 * `CONNECT_TIMEOUT` anyway, so one handshake that missed `connect_timeout`
 * threw out of the worker loop: the import failed, and under `sync --all` the
 * whole source was dropped. The usual cause is the client, not the server: a
 * long synchronous stretch in the same process (one source's repository walk)
 * holds the event loop while another source's handshake is in flight.
 *
 * Serial (`.serial.test.ts`): a top-level mock.module stands in for the worker
 * engines so each connect can be scripted to fail; nothing dials a database.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import * as importFiles from '../src/core/import-file.ts';
import * as sourceFilesystem from '../src/core/minions/source-filesystem.ts';
import { withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { runImport } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

let connects = 0;
let scriptedFailures: Error[] = [];

mock.module('../src/core/postgres-engine.ts', () => ({
  PostgresEngine: class {
    readonly kind = 'postgres';
    async connect(): Promise<void> {
      connects += 1;
      const failure = scriptedFailures.shift();
      if (failure) throw failure;
    }
    async disconnect(): Promise<void> {}
  },
}));

/** The shape postgres.js throws when the connect timer fires after the TLS upgrade. */
const connectTimeout = () =>
  Object.assign(new Error('write CONNECT_TIMEOUT undefined:undefined'), { code: 'CONNECT_TIMEOUT' });

const home = mkdtempSync(join(tmpdir(), 'gbrain-worker-connect-retry-'));
const emptyDir = join(home, 'empty-import');
const repo = join(home, 'repo');
let engine: PGLiteEngine;

const isolated = (fn: () => Promise<void>) => withEnv({
  GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_MAX_CONNECTIONS: undefined,
  GBRAIN_POOL_SIZE: undefined, GBRAIN_NO_RETRY_CONNECT: undefined,
}, fn);

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
    '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' }).trim();
}

function writePage(name: string): void {
  writeFileSync(join(repo, `${name}.md`), `---\ntype: note\ntitle: ${name}\n---\n\nWorker connect fixture ${name}.\n`);
}

beforeAll(async () => isolated(async () => {
  mkdirSync(emptyDir);
  mkdirSync(repo);
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'postgres', database_url: 'postgresql://example.invalid/gbrain_test' }));
  writePage('base');
  execFileSync('git', ['init', '-q', repo]);
  git('add', '.');
  git('commit', '-qm', 'base');
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
}), 60_000);

afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); });

beforeEach(() => {
  connects = 0;
  scriptedFailures = [];
});

/** Capture the retry line connectWithRetry writes to stderr. */
async function withCapturedWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  try { await fn(); } finally { warnSpy.mockRestore(); }
  return lines;
}

test('import: a worker connect that times out once is retried, and the import completes', () => isolated(async () => {
  // The worker pools here are mocks; the import runs inside an already-held
  // fixture-root lock, as nested sync imports do (import-connection-budget's seam).
  const heldRoot = realpathSync(emptyDir);
  const lockSpy = spyOn(sourceFilesystem, 'hasSourceFilesystemLock').mockImplementation(path => path === heldRoot);
  const parent = { kind: 'postgres', executeRaw: async () => [], getConfig: async () => null } as unknown as BrainEngine;
  scriptedFailures = [connectTimeout()];
  try {
    const warnings = await withCapturedWarnings(() => runImport(parent, ['--no-embed', '--workers', '2', emptyDir]));
    expect(connects).toBe(3); // two workers, one of them on its second attempt
    expect(warnings.some(line => line.includes('CONNECT_TIMEOUT') && line.includes('retrying'))).toBe(true);
  } finally {
    lockSpy.mockRestore();
  }
}));

test('sync: a worker connect that times out once is retried, and the source still syncs', () => isolated(async () => {
  // First sync (serial, on PGLite) sets the bookmark; the next commit's two
  // pages then go through the incremental parallel drain.
  const first = await performSync(engine, { repoPath: repo, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
  expect(first.status).toBe('first_sync');
  writePage('alpha');
  writePage('beta');
  git('add', '.');
  git('commit', '-qm', 'two more pages');

  // The worker engines are mocks, so the per-file import is stubbed. The
  // parent is the PGLite engine reporting itself as Postgres; the real PGLite
  // engine holds the filesystem lock, and the caller-held scope stands in for
  // the per-source lease (`skipLock`), as in import-cancellation's harness.
  const importSpy = spyOn(importFiles, 'importFile').mockImplementation(async (_eng, _file, path) =>
    ({ status: 'imported', slug: path.slice(0, -3), chunks: 1 }));
  const parent = new Proxy(engine, { get(target, prop) {
    if (prop === 'kind') return 'postgres';
    const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
  scriptedFailures = [connectTimeout()];
  try {
    let result: Awaited<ReturnType<typeof performSync>> | undefined;
    const warnings = await withCapturedWarnings(async () => {
      result = await withSourceFilesystemLock(engine, repo, () => performSync(parent, {
        repoPath: repo, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, concurrency: 2, skipLock: true,
      }));
    });
    expect(result?.status).toBe('synced');
    expect(result?.added).toBe(2);
    expect(importSpy).toHaveBeenCalledTimes(2);
    expect(connects).toBe(3);
    expect(warnings.some(line => line.includes('CONNECT_TIMEOUT') && line.includes('retrying'))).toBe(true);
  } finally {
    importSpy.mockRestore();
  }
}), 60_000);
