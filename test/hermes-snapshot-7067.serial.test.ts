/**
 * #7067: the Hermes adapter snapshotted a live WAL-mode store by copying the
 * main file and then the -wal/-shm sidecars as separate filesystem copies. A
 * writer that checkpoints between those copies leaves a torn snapshot: the
 * copied WAL refers to pages the copied main file never had, and the read
 * fails (`disk I/O error`) even though the original store is healthy.
 *
 * Protects: a writer that commits, checkpoints (TRUNCATE) and writes again
 * between the old copy steps cannot tear the snapshot; the adapter reads one
 * coherent, complete session; un-checkpointed WAL writes are visible; the
 * original store stays healthy and no temp snapshot is left behind.
 * Seams: mock.module('node:fs') wraps copyFileSync to inject the writer after
 * the main-file copy (the issue's synthetic repro shape), hence serial.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realCopyFileSync = fs.copyFileSync;
let activePath = '';
let writer: Database | null = null;
let injected = false;

function injectWriterAndCheckpoint(db: Database): void {
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 400; i++) ins.run('session-a', 'assistant', `synthetic reply ${i} ${'x'.repeat(1000)}`, 1786000001 + i);
  })();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.prepare('UPDATE messages SET content = ? WHERE id = 1').run(`synthetic question updated ${'z'.repeat(50000)}`);
}

mock.module('node:fs', () => ({
  ...fs,
  copyFileSync: (src: string, dest: string, ...rest: unknown[]) => {
    (realCopyFileSync as (...a: unknown[]) => void)(src, dest, ...rest);
    if (!injected && writer && src === activePath) {
      injected = true;
      injectWriterAndCheckpoint(writer);
    }
  },
}));

const { hermesAdapter } = await import('../src/core/transcripts/hermes.ts');

const root = fs.mkdtempSync(join(tmpdir(), 'gbrain-hermes-7067-'));
afterAll(() => {
  writer?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function openLiveStore(name: string): Database {
  activePath = join(root, name);
  const db = new Database(activePath, { create: true });
  db.exec(`
    PRAGMA page_size = 512;
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT, started_at REAL, cwd TEXT, model TEXT, source TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-a', 'synthetic session', null, 1786000000, '/tmp/acme-example', null, 'cli');
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('session-a', 'user', 'synthetic question', 1786000000);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return db;
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

function hermesTempDirs(): number {
  return fs.readdirSync(tmpdir()).filter((n) => n.startsWith('gbrain-hermes-') && !n.startsWith('gbrain-hermes-7067-')).length;
}

describe('hermes snapshot under a concurrent checkpoint (#7067)', () => {
  test('a writer that checkpoints mid-snapshot cannot tear it: one coherent, complete session', async () => {
    writer = openLiveStore('race.db');
    injected = false;
    const { sessions, diag } = await drain(activePath);
    expect(diag.zeroSessionsReason).toBeUndefined();
    expect(sessions).toHaveLength(1);

    const texts = sessions[0].messages.map((m) => m.text);
    const afterWriter = writer.query<{ content: string }, []>('SELECT content FROM messages ORDER BY timestamp, id').all().map((r) => r.content);
    expect([['synthetic question'], afterWriter]).toContainEqual(texts);
    expect(writer.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    writer.close();
    writer = null;
  });

  test('un-checkpointed WAL writes are in the snapshot, and no temp snapshot survives', async () => {
    writer = openLiveStore('wal-only.db');
    injected = true;
    writer.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('session-a', 'assistant', 'synthetic answer still in the WAL', 1786000001);
    expect(fs.statSync(`${activePath}-wal`).size).toBeGreaterThan(0);

    const tmpBefore = hermesTempDirs();
    const { sessions } = await drain(activePath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages.map((m) => m.text)).toEqual(['synthetic question', 'synthetic answer still in the WAL']);
    expect(hermesTempDirs()).toBeLessThanOrEqual(tmpBefore);
    writer.close();
    writer = null;
  });
});
