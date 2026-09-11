// Serial: child pool mocking and import/log spies are process-wide.
import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import * as importFiles from '../src/core/import-file.ts';
import * as locks from '../src/core/db-lock.ts';
import { runImport, ImportAbortError } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import { withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { APPLICATION_AUTHORITY, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { withEnv } from './helpers/with-env.ts';

let disconnects = 0;
mock.module('../src/core/postgres-engine.ts', () => ({
  PostgresEngine: class {
    kind = 'postgres';
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> { disconnects++; }
  },
}));

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-cancel-'));
const root = join(home, 'repo');
const checkpoint = join(home, '.gbrain', 'import-checkpoint.json');
let engine: PGLiteEngine;
const isolated = (fn: () => Promise<void>) => withEnv({
  GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_MAX_CONNECTIONS: undefined,
}, fn);
beforeAll(async () => isolated(async () => {
  mkdirSync(root); mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgresql://example.invalid/gbrain_test' }));
  for (let i = 0; i < 8; i++) writeFileSync(join(root, `page-${i}.md`), `---\ntype: note\ntitle: Page ${i}\n---\n\nA cancellation fixture body ${i}.\n`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
}), 60_000);
afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function reset(): Promise<void> {
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("UPDATE sources SET last_commit = NULL WHERE id = 'default'");
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'sync.%'");
  rmSync(checkpoint, { force: true }); disconnects = 0;
}
function completedPaths(): string[] { return JSON.parse(readFileSync(checkpoint, 'utf8')).completedPaths; }

test('an admission database failure racing caller cancellation remains a failure', () => isolated(async () => {
  await reset();
  const controller = new AbortController();
  const failure = new Error('fixture admission connection failure');
  const original = engine.executeRaw.bind(engine);
  const querySpy = spyOn(engine, 'executeRaw').mockImplementation((sql, params) => {
    if (sql === "SELECT local_path FROM sources WHERE local_path IS NOT NULL AND local_path <> ''") {
      controller.abort();
      return Promise.reject(failure);
    }
    return original(sql, params);
  });
  try {
    await expect(performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, signal: controller.signal })).rejects.toBe(failure);
  } finally { querySpy.mockRestore(); }
}));

for (const unexpectedFailure of [false, true]) {
  test(`parallel interruption drains every worker before pools/lock release (unexpected failure=${unexpectedFailure})`, () => isolated(async () => {
    await reset();
    const controller = new AbortController();
    const pending: Array<{ path: string; resolve: () => void; reject: (error: Error) => void }> = [];
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const importSpy = spyOn(importFiles, 'importFile').mockImplementation(async (_engine, _path, path) => {
      await new Promise<void>((resolve, reject) => { pending.push({ path, resolve, reject }); if (pending.length === 3) ready(); });
      return { status: 'imported', slug: path.slice(0, -3), chunks: 1 };
    });
    // The actual outer PGLite lock encloses a parent facade whose import pools
    // are simulated. No database URL in this fixture can reach a real server.
    const parent = new Proxy(engine, { get(target, prop) {
      if (prop === 'kind') return 'postgres';
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine;
    let settled = false;
    const run = withSourceFilesystemLock(engine, root, () => runImport(parent, [root, '--no-embed', '--workers', '3'], {
      sourceId: 'default', signal: controller.signal,
    }), { signal: controller.signal }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await started;
      controller.abort();
      const failure = new Error('fixture connection failure');
      if (unexpectedFailure) pending[0].reject(failure); else pending[0].resolve();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(disconnects).toBe(0);
      expect(await engine.executeRaw("SELECT id FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-fs:%'")).toHaveLength(1);
      for (const item of pending.slice(1)) item.resolve();
      const result = await run;
      if (unexpectedFailure) expect(result).toBe(failure);
      else {
        expect(result).toBeInstanceOf(ImportAbortError);
        expect((result as ImportAbortError).partialResult?.imported).toBe(3);
      }
      expect(pending).toHaveLength(3); // Never dequeue another file after abort.
      expect(disconnects).toBe(3);
      expect(completedPaths().sort()).toEqual(pending.slice(unexpectedFailure ? 1 : 0).map(item => item.path).sort());
      expect(await engine.executeRaw("SELECT id FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-fs:%'")).toHaveLength(0);
    } finally {
      for (const item of pending) item.resolve();
      await run; importSpy.mockRestore();
    }
  }), 30_000);
}

for (const mode of ['caller', 'job', 'log-ingest', 'lease', 'caller-and-lease'] as const) {
  test(`sync interruption preserves progress and bookmark (${mode})`, () => isolated(async () => {
    await reset();
    const controller = new AbortController();
    const originalImport = importFiles.importFile;
    const originalLog = engine.logIngest.bind(engine);
    const originalLock = locks.withRefreshingLock;
    let calls = 0;
    const importSpy = spyOn(importFiles, 'importFile').mockImplementation(async (...args) => {
      const result = await originalImport(...args); calls++;
      if (mode === 'lease' || mode === 'caller-and-lease') {
        if (mode === 'caller-and-lease') controller.abort();
        await new Promise(resolve => setTimeout(resolve, 80));
      } else if (mode !== 'log-ingest') controller.abort();
      return result;
    });
    const logSpy = spyOn(engine, 'logIngest').mockImplementation(async (...args) => {
      const result = await originalLog(...args);
      if (mode === 'log-ingest') controller.abort();
      return result;
    });
    const lockSpy = spyOn(locks, 'withRefreshingLock').mockImplementation((eng, key, fn, opts) =>
      originalLock(eng, key, fn, key.startsWith('gbrain-fs:') && mode.includes('lease') ? { ...opts, ttlMinutes: 0.0005 } : opts));
    const sync = () => performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, concurrency: 1, signal: controller.signal });
    try {
      if (mode === 'job') {
        await expect(withSubmissionAuthority(APPLICATION_AUTHORITY, sync, controller.signal)).rejects.toBeInstanceOf(ImportAbortError);
      } else if (mode.includes('lease')) {
        let followup = false;
        await expect(withSourceFilesystemLock(engine, root, async () => {
          await sync(); followup = true;
        }, { signal: controller.signal })).rejects.toBeInstanceOf(locks.LockStolenError);
        expect(followup).toBe(false);
      } else {
        const result = await sync();
        expect(result.status).toBe('partial');
        expect(result.filesImported).toBe(mode === 'log-ingest' ? 8 : 1);
      }
      expect(calls).toBe(mode === 'log-ingest' ? 8 : 1);
      expect(completedPaths()).toHaveLength(calls);
      expect((await engine.executeRaw<{ last_commit: string | null }>("SELECT last_commit FROM sources WHERE id = 'default'"))[0].last_commit).toBeNull();
    } finally { importSpy.mockRestore(); logSpy.mockRestore(); lockSpy.mockRestore(); }
  }), 30_000);
}
