/**
 * The #7067 snapshot opened the Hermes store read-only in place and ran
 * VACUUM INTO. A WAL-mode store in a directory gbrain cannot write (a store
 * at rest has no -wal/-shm, and a read-only open has to create them) failed
 * with "attempt to write a readonly database", where the earlier file copy
 * imported it; in a writable directory the open left -wal/-shm sidecars
 * beside the store.
 *
 * Protects: a WAL store at rest in an unwritable directory imports its
 * session, and no import leaves a -wal or -shm file in the Hermes directory.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-ro-test-'));
afterAll(() => {
  for (const dir of ['ro', 'rw']) if (existsSync(join(root, dir))) chmodSync(join(root, dir), 0o755);
  rmSync(root, { recursive: true, force: true });
});

function walStoreAtRest(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'state.db');
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT, started_at REAL, cwd TEXT, model TEXT, source TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-a', 'synthetic session', null, 1786000000, '/tmp/acme-example', null, 'cli');
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('session-a', 'user', 'synthetic question', 1786000000);
  db.close(true);
  expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  return path;
}

async function drain(path: string) {
  const sessions = [];
  const it = hermesAdapter.parse(path, { maxBytes: 64 * 1024 * 1024 });
  while (true) {
    const step = await it.next();
    if (step.done) return { sessions, diag: step.value };
    sessions.push(step.value);
  }
}

describe('hermes snapshot of a store gbrain cannot write beside', () => {
  test('a WAL store at rest in an unwritable directory imports, and no sidecar appears', async () => {
    const dir = join(root, 'ro');
    const path = walStoreAtRest(dir);
    chmodSync(dir, 0o555);
    const { sessions, diag } = await drain(path);
    expect(diag.zeroSessionsReason).toBeUndefined();
    expect(sessions.map((s) => s.messages.map((m) => m.text))).toEqual([['synthetic question']]);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test('a WAL store at rest in a writable directory leaves no sidecar behind', async () => {
    const path = walStoreAtRest(join(root, 'rw'));
    const { sessions } = await drain(path);
    expect(sessions).toHaveLength(1);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });
});
