/**
 * The Hermes snapshot falls back to a plain file copy only when the read-only
 * VACUUM INTO cannot run at all (an unwritable directory or an unopenable
 * store). A busy store has a live writer mid-transaction, and copying it is
 * the torn read #7067 fixed, so a busy error has to surface instead.
 *
 * Protects: SQLITE_BUSY from the snapshot is rethrown, no session is imported
 * from a copy, and the temp snapshot directory is removed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import { withEnv } from './helpers/with-env.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-busy-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('hermes snapshot of a busy store', () => {
  test('a busy error is rethrown and nothing is copied', async () => {
    const dir = join(root, 'store');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'state.db');
    const writer = new Database(path, { create: true });
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT, started_at REAL, cwd TEXT, model TEXT, source TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    `);
    writer.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-a', 'synthetic session', null, 1786000000, '/tmp/acme-example', null, 'cli');
    writer.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('session-a', 'user', 'synthetic question', 1786000000);
    writer.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
    writer.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('session-a', 'assistant', 'synthetic answer', 1786000001);

    const snapshotTmp = join(root, 'tmp');
    mkdirSync(snapshotTmp, { recursive: true });
    const sessions: unknown[] = [];
    let thrown: unknown;
    try {
      await withEnv({ TMPDIR: snapshotTmp }, async () => {
        const it = hermesAdapter.parse(path, { maxBytes: 64 * 1024 * 1024 });
        while (true) {
          const step = await it.next();
          if (step.done) break;
          sessions.push(step.value);
        }
      });
    } catch (err) {
      thrown = err;
    } finally {
      writer.exec('COMMIT');
      writer.close();
    }

    expect((thrown as { code?: string } | undefined)?.code).toBe('SQLITE_BUSY');
    expect(sessions).toHaveLength(0);
    expect(readdirSync(snapshotTmp)).toEqual([]);
  }, 30_000);
});
