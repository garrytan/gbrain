/**
 * Unit tests for the live worker registry (issue #1815, Q1-C).
 *
 * Pins the lifecycle edges Codex flagged:
 *   - ESRCH entries pruned, EPERM entries kept alive (#9).
 *   - PID-reuse guard: an entry whose pid started long after registration is
 *     not reported (#8).
 *   - Registry path is brain-isolated under gbrainPath (#7).
 *   - Corrupt JSON skipped; cleanup unlinks.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';

let home: string;
const origHome = process.env.GBRAIN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-reg-'));
  process.env.GBRAIN_HOME = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = origHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Imported lazily AFTER GBRAIN_HOME is set so gbrainPath resolves to the temp dir.
async function reg() {
  return await import('../src/core/minions/worker-registry.ts');
}

describe('classifyLiveness (Codex #9)', () => {
  test('no error = alive, ESRCH = dead, EPERM = alive, other = unknown', async () => {
    const { classifyLiveness } = await reg();
    expect(classifyLiveness(undefined)).toBe('alive');
    expect(classifyLiveness('ESRCH')).toBe('dead');
    expect(classifyLiveness('EPERM')).toBe('alive'); // not pruned just because unsignalable
    expect(classifyLiveness('EINVAL')).toBe('unknown');
  });
});

describe('parseEtimeToMs (PID-reuse guard, timezone-free)', () => {
  test('parses every portable ps etime shape', async () => {
    const { parseEtimeToMs } = await reg();
    expect(parseEtimeToMs('00:00')).toBe(0);
    expect(parseEtimeToMs('00:42')).toBe(42_000);
    expect(parseEtimeToMs('01:23')).toBe(83_000);
    expect(parseEtimeToMs('12:34:56')).toBe(((12 * 3600) + (34 * 60) + 56) * 1000);
    expect(parseEtimeToMs('3-04:05:06')).toBe(((3 * 86400) + (4 * 3600) + (5 * 60) + 6) * 1000);
    expect(parseEtimeToMs('  01:00  ')).toBe(60_000);
  });

  test('returns null when elapsed time cannot be determined', async () => {
    const { parseEtimeToMs } = await reg();
    expect(parseEtimeToMs('')).toBeNull();
    expect(parseEtimeToMs('garbage')).toBeNull();
    expect(parseEtimeToMs('not:a:number:at:all')).toBeNull();
    expect(parseEtimeToMs('Mon Sep  7 00:30:32 2026')).toBeNull(); // the old lstart shape
  });
});

describe('register + read round trip', () => {
  test('registerWorker writes under gbrainPath; readWorkers returns the live worker', async () => {
    const { registerWorker, readWorkers, workerRegistryDir } = await reg();
    expect(workerRegistryDir()).toBe(join(home, '.gbrain', 'workers'));

    const cleanup = registerWorker({
      pid: process.pid, // a definitely-alive pid
      queue: 'default',
      nice_requested: 10,
      nice_effective: 10,
      started_at: Date.now(),
    });

    const live = readWorkers(() => 10); // inject niceness read
    expect(live.length).toBe(1);
    expect(live[0]!.pid).toBe(process.pid);
    expect(live[0]!.queue).toBe('default');
    expect(live[0]!.nice_requested).toBe(10);
    expect(live[0]!.nice_now).toBe(10);

    cleanup();
    expect(readWorkers(() => 10).length).toBe(0);
  });

  test('#4885: a live worker survives a runtime zone that differs from the one ps prints in', async () => {
    const { registerWorker, readWorkers } = await reg();
    // Bun re-resolves the runtime zone on reassignment but does not hand the
    // mutation to the ps child, so a zone-dependent start-time parse drifts by
    // the offset (+12h here) and drops a live worker. etime is zone-free.
    await withEnv({ TZ: 'Etc/GMT+12' }, async () => {
      const cleanup = registerWorker({
        pid: process.pid, queue: 'default', nice_requested: 10, nice_effective: 10, started_at: Date.now(),
      });
      try {
        expect(readWorkers(() => 10).length).toBe(1);
      } finally {
        cleanup();
      }
    });
  });

  test('cleanup unlinks the entry file', async () => {
    const { registerWorker, workerRegistryDir } = await reg();
    const cleanup = registerWorker({
      pid: process.pid, queue: 'q', nice_requested: null, nice_effective: 0, started_at: Date.now(),
    });
    expect(readdirSync(workerRegistryDir()).length).toBe(1);
    cleanup();
    expect(readdirSync(workerRegistryDir()).length).toBe(0);
  });
});

/** #9229: real registry/config round trips must not hide a worker because its
 * connection tuning differs. Existing lifecycle tests never changed the DB
 * spelling between registration and reading. No new production seam is needed.
 * Keep routing differences and pre-upgrade raw-hash entries isolated too. */
describe('database identity across connection spellings (#9229)', () => {
  function config(value: Record<string, string>) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(value));
  }

  const primary = 'postgresql://reader:synthetic-old@db.example:5432/brain';
  const env = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
  const worker = () => ({ pid: process.pid, queue: 'default', nice_requested: null,
    nice_effective: 0, started_at: Date.now() });
  function legacyId(key: string): string {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
  }

  test('file-config worker remains visible to an env-config reader with driver options', async () => {
    await withEnv(env, async () => {
      const { registerWorker, currentBrainId, readWorkers, workerRegistryDir } = await reg();
      const { queueWorkerAlive } = await import('../src/core/minions/no-worker.ts');
      config({ database_url: primary });
      const id = currentBrainId();
      const cleanup = registerWorker(worker());
      try {
        await withEnv({ DATABASE_URL: `${primary}?connect_timeout=10&sslmode=require` }, async () => {
          expect(readWorkers(() => null).map(w => w.pid)).toEqual([process.pid]);
          expect(queueWorkerAlive('default')).toBe(true);
          expect(queueWorkerAlive('other')).toBe(false);
        });
        const stored = readFileSync(join(workerRegistryDir(), `worker-${process.pid}.json`), 'utf8');
        expect(JSON.parse(stored).brain_id).toBe(id); // pre-upgrade reader compatibility
        expect(stored).not.toContain('synthetic-old');
        expect(stored).not.toContain('db.example');
      } finally { cleanup(); }
    });
  });

  test('scheme, hostname, default port, escaping and password rotation preserve identity', async () => {
    await withEnv({ ...env, PGPORT: undefined }, async () => {
      const { currentBrainId, registerWorker, readWorkers } = await reg();
      config({ database_url: primary });
      const id = currentBrainId();
      const cleanup = registerWorker(worker());
      try {
        for (const url of [
          'postgres://reader:synthetic-new@DB.EXAMPLE/brain',
          'postgresql://%72eader@db.example/%62rain?application_name=probe&prepare=false',
          `${primary}?password=synthetic-new&sslmode=require`,
        ]) {
          config({ database_url: url });
          expect(readWorkers(() => null)).toHaveLength(1);
        }
        config({ database_url: primary });
        expect(currentBrainId()).toBe(id); // do not rename supervisor pidfiles
      } finally { cleanup(); }
    });
  });

  test('omitted port honors PGPORT without cross-reporting the default port', async () => {
    await withEnv({ ...env, PGPORT: '5433' }, async () => {
      const { default: postgres } = await import('#postgres');
      const { registerWorker, readWorkers } = await reg();
      const omitted = primary.replace(':5432', '');
      const alternate = primary.replace(':5432', ':5433');
      // Constructing clients only parses options; no query or connection is made.
      const clients = [omitted, alternate, primary].map(url => postgres(url, {
        connection: { default_transaction_read_only: true },
      }));
      try {
        expect(clients.map(client => client.options.port)).toEqual([[5433], [5433], [5432]]);
        config({ database_url: omitted });
        const cleanup = registerWorker(worker());
        try {
          config({ database_url: alternate });
          expect(readWorkers(() => null)).toHaveLength(1);
          config({ database_url: primary });
          expect(readWorkers(() => null)).toHaveLength(0);
        } finally { cleanup(); }
      } finally {
        await Promise.all(clients.map(client => client.end()));
      }
    });
  });

  test('different database, role, endpoint, port and behavior options do not cross-report', async () => {
    await withEnv(env, async () => {
      const { registerWorker, readWorkers } = await reg();
      config({ database_url: primary });
      const cleanup = registerWorker(worker());
      try {
        for (const url of [
          primary.replace('/brain', '/other'), primary.replace('reader:', 'other:'),
          primary.replace('db.example', 'other.example'), primary.replace(':5432', ':5433'),
          `${primary}?options=-c%20search_path%3Dother`, `${primary}?host=other.example`,
        ]) {
          config({ database_url: url });
          expect(readWorkers(() => null)).toHaveLength(0);
        }
      } finally { cleanup(); }
    });
  });

  test('PGLite relative and absolute paths identify the same database, not another path', async () => {
    await withEnv(env, async () => {
      const { registerWorker, readWorkers } = await reg();
      const relative = `./worker-identity-${process.pid}/../worker-identity-${process.pid}`;
      config({ database_path: relative });
      const cleanup = registerWorker(worker());
      try {
        config({ database_path: join(process.cwd(), `worker-identity-${process.pid}`) });
        expect(readWorkers(() => null)).toHaveLength(1);
        config({ database_path: join(home, 'other') });
        expect(readWorkers(() => null)).toHaveLength(0);
      } finally { cleanup(); }
    });
  });

  test('legacy raw-hash entries remain readable only for the exact configured target', async () => {
    await withEnv(env, async () => {
      const { readWorkers, workerRegistryDir } = await reg();
      config({ database_url: primary });
      mkdirSync(workerRegistryDir(), { recursive: true });
      writeFileSync(join(workerRegistryDir(), `worker-${process.pid}.json`), JSON.stringify({
        ...worker(), brain_id: legacyId(primary),
      }));
      expect(readWorkers(() => null)).toHaveLength(1);
      config({ database_url: `${primary}?connect_timeout=10` });
      // Old entries contain only an irreversible raw hash; do not guess which
      // alternate spelling they came from. A worker restart adds the target id.
      expect(readWorkers(() => null)).toHaveLength(0);
      config({ database_url: primary.replace('/brain', '/other') });
      expect(readWorkers(() => null)).toHaveLength(0);
    });
  });

  test('malformed targets keep their raw discriminator instead of collapsing to default', async () => {
    await withEnv(env, async () => {
      const { currentBrainId, registerWorker, readWorkers } = await reg();
      for (const database_url of ['not a URL', 'postgresql://reader@db.example/%ZZ', 'postgresql://db.example']) {
        config({ database_url });
        expect(currentBrainId()).toBe(legacyId(database_url));
        const cleanup = registerWorker(worker());
        try {
          expect(readWorkers(() => null)).toHaveLength(1);
          config({ database_url: 'another malformed URL' });
          expect(readWorkers(() => null)).toHaveLength(0);
        } finally { cleanup(); }
      }
    });
  });

  test('explicit caller identity is not overridden by the configured target', async () => {
    await withEnv(env, async () => {
      const { registerWorker, readWorkers } = await reg();
      config({ database_url: primary });
      const cleanup = registerWorker({ ...worker(), brain_id: 'another-brain' });
      try { expect(readWorkers(() => null)).toHaveLength(0); }
      finally { cleanup(); }
    });
  });

  test('unknown parameters sort by key while repeated routing options retain value order', async () => {
    await withEnv(env, async () => {
      const { registerWorker, readWorkers } = await reg();
      config({ database_url: `${primary}?options=first&options=last&custom=value` });
      const cleanup = registerWorker(worker());
      try {
        config({ database_url: `${primary}?custom=value&connect_timeout=10&options=first&options=last` });
        expect(readWorkers(() => null)).toHaveLength(1);
        config({ database_url: `${primary}?custom=value&options=last&options=first` });
        expect(readWorkers(() => null)).toHaveLength(0);
        config({ database_url: `${primary}?custom=different&options=first&options=last` });
        expect(readWorkers(() => null)).toHaveLength(0);
      } finally { cleanup(); }
    });
  });

  test('a mismatched normalized target never falls back to a matching legacy id', async () => {
    await withEnv(env, async () => {
      const { registerWorker, readWorkers, workerRegistryDir } = await reg();
      config({ database_url: primary });
      const cleanup = registerWorker(worker());
      try {
        const file = join(workerRegistryDir(), `worker-${process.pid}.json`);
        const entry = JSON.parse(readFileSync(file, 'utf8'));
        entry.brain_target_id = 'another-target';
        writeFileSync(file, JSON.stringify(entry));
        expect(readWorkers(() => null)).toHaveLength(0);
      } finally { cleanup(); }
    });
  });
});

describe('pruning + guards', () => {
  test('ESRCH (dead) entries are dropped and their files pruned', async () => {
    const { readWorkers, workerRegistryDir, currentBrainId } = await reg();
    const dir = workerRegistryDir();
    // A pid that is essentially never alive.
    const deadPid = 2147483600;
    const file = join(dir, `worker-${deadPid}.json`);
    require('fs').mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({
      pid: deadPid, queue: 'q', brain_id: currentBrainId(),
      started_at: Date.now(), nice_requested: 5, nice_effective: 5,
    }));
    const live = readWorkers(() => 5);
    expect(live.length).toBe(0);
    expect(existsSync(file)).toBe(false); // pruned
  });

  test('PID-reuse guard: live pid that started long after registration is skipped (Codex #8)', async () => {
    const { readWorkers, workerRegistryDir, currentBrainId } = await reg();
    const dir = workerRegistryDir();
    require('fs').mkdirSync(dir, { recursive: true });
    // Use our own (alive) pid but claim it was registered far in the past — our
    // process actually started AFTER that, so the start-time guard rejects it.
    writeFileSync(join(dir, `worker-${process.pid}.json`), JSON.stringify({
      pid: process.pid, queue: 'q', brain_id: currentBrainId(),
      started_at: 1, // epoch ~1970; our process clearly started long after
      nice_requested: 5, nice_effective: 5,
    }));
    const live = readWorkers(() => 5);
    expect(live.length).toBe(0);
  });

  test('corrupt JSON is skipped, not fatal', async () => {
    const { readWorkers, workerRegistryDir } = await reg();
    const dir = workerRegistryDir();
    require('fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `worker-${process.pid}.json`), '{ not valid json');
    expect(() => readWorkers(() => 5)).not.toThrow();
    expect(readWorkers(() => 5).length).toBe(0);
  });
});

describe('unreadable registry is unknown, not empty', () => {
  // queueWorkerAlive, wedged_queue and remediation all keep a liveness-unknown
  // path for a throwing read; readWorkers must actually throw to reach it.
  test('a missing registry dir reads as empty and no-worker', async () => {
    const { readWorkers, workerRegistryDir } = await reg();
    const { queueWorkerAlive } = await import('../src/core/minions/no-worker.ts');
    expect(existsSync(workerRegistryDir())).toBe(false);
    expect(readWorkers(() => null)).toEqual([]);
    expect(queueWorkerAlive('default')).toBe(false);
  });

  test('a registry path that cannot be listed (ENOTDIR) throws; liveness is unknown, so no no_worker advice', async () => {
    const { readWorkers, workerRegistryDir } = await reg();
    const { queueWorkerAlive } = await import('../src/core/minions/no-worker.ts');
    const { deriveWedgeSignal } = await import('../src/core/minions/queue.ts');
    require('fs').mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(workerRegistryDir(), 'not a directory');
    expect(() => readWorkers(() => null)).toThrow(/ENOTDIR/);
    const { WorkerRegistryUnreadableError, workerRegistryReadFailure } = await reg();
    let caught: unknown;
    try { readWorkers(() => null); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WorkerRegistryUnreadableError);
    expect(workerRegistryReadFailure(caught)).toEqual({ errno: 'ENOTDIR', path: workerRegistryDir() });
    expect(queueWorkerAlive('default')).toBeUndefined();
    const signal = deriveWedgeSignal(
      { queue: 'default', active_healthy: 0, waiting: 3, minutes_since_completion: null },
      { workerAlive: queueWorkerAlive('default') },
    );
    expect(signal.no_worker).toBe(false);
    expect(signal.wedged).toBe(true);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unsearchable parent (EACCES) throws instead of reading as absent',
    async () => {
      const { readWorkers } = await reg();
      const { queueWorkerAlive } = await import('../src/core/minions/no-worker.ts');
      const parent = join(home, '.gbrain');
      require('fs').mkdirSync(join(parent, 'workers'), { recursive: true });
      require('fs').chmodSync(parent, 0o000);
      try {
        expect(() => readWorkers(() => null)).toThrow(/EACCES/);
        expect(queueWorkerAlive('default')).toBeUndefined();
      } finally {
        require('fs').chmodSync(parent, 0o700);
      }
    },
  );
});
