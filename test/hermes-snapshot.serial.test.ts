/**
 * Protect coherent, bounded, readonly Hermes imports under a live checkpoint.
 * Split DB/WAL copies reproduce SQLITE_IOERR_SHORT_READ; an unpinned serialize
 * captures mixed/newer data. Real SQLite with synthetic stores, no providers.
 * Process-isolated filesystem/SQLite spies cannot share the parallel unit lane.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

const roots: string[] = [];
const writers: Database[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const writer of writers.splice(0)) writer.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'hermes-snapshot-test-'));
  roots.push(root);
  const path = join(root, 'state.db');
  const writer = new Database(path, { create: true });
  writers.push(writer);
  writer.exec(`PRAGMA page_size=512; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,display_name TEXT,started_at REAL,cwd TEXT,model TEXT,source TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
    INSERT INTO sessions VALUES('a','synthetic fixture',NULL,1785916800,NULL,NULL,'fixture');
    INSERT INTO messages VALUES(1,'a','user','original fixture message',1785916801);
    PRAGMA wal_checkpoint(TRUNCATE);`);
  return { path, writer };
}

async function drain(path: string, maxBytes?: number) {
  const sessions: ParsedSession[] = [];
  const iterator = hermesAdapter.parse(path, { maxBytes });
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { sessions, diagnostics: step.value };
    sessions.push(step.value);
  }
}

function trackCopies() {
  const original = fs.mkdtempSync;
  const copies: string[] = [];
  const spy = spyOn(fs, 'mkdtempSync').mockImplementation((prefix, ...args) => {
    const dir = Reflect.apply(original, fs, [prefix, ...args]);
    if (String(prefix).includes('gbrain-hermes-')) copies.push(String(dir));
    return dir;
  });
  restores.push(() => spy.mockRestore());
  return copies;
}

describe('Hermes coherent SQLite snapshots (#7067)', () => {
  test('checkpoint between capture steps cannot tear the snapshot or modify the source', async () => {
    const { path, writer } = fixture();
    const copies = trackCopies();
    let injected = false;
    let readonly = false;
    const mutate = () => {
      if (injected) return;
      injected = true;
      const insert = writer.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)');
      writer.transaction(() => {
        for (let i = 0; i < 400; i++) insert.run('a', 'assistant', `synthetic ${i} ${'x'.repeat(1000)}`, 1785916802 + i);
      })();
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      writer.prepare('UPDATE messages SET content=? WHERE id=1').run('updated ' + 'z'.repeat(50000));
    };
    // The historical split-copy path deterministically tears here.
    const originalCopy = fs.copyFileSync;
    const copySpy = spyOn(fs, 'copyFileSync').mockImplementation((src, dest, flags) => {
      originalCopy(src, dest, flags);
      if (src === path) mutate();
    });
    restores.push(() => copySpy.mockRestore());
    // Exercise the replacement at its capture boundary too, not just absence
    // of the old copy call: the established read transaction must win.
    const originalSerialize = Database.prototype.serialize;
    const serializeSpy = spyOn(Database.prototype, 'serialize').mockImplementation(function (this: Database, name?: string) {
      try { this.exec("INSERT INTO sessions(id) VALUES('must-not-write')"); }
      catch (error) { readonly = String(error).includes('readonly'); }
      mutate();
      return originalSerialize.call(this, name);
    });
    restores.push(() => serializeSpy.mockRestore());
    const result = await drain(path, 10 * 1024 * 1024);
    expect(injected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages.map(message => message.text)).toEqual(['original fixture message']);
    expect(result.diagnostics.sessions).toBe(1);
    expect(readonly).toBe(true);
    expect(writer.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(writer.query('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 401 });
    expect(writer.query("SELECT count(*) AS n FROM sessions WHERE id='must-not-write'").get()).toEqual({ n: 0 });
    expect(copies).toHaveLength(1);
    expect(copies.every(copy => !fs.existsSync(copy))).toBe(true);
  });

  test('includes committed WAL-only rows and freezes all sessions before yielding', async () => {
    const { path, writer } = fixture();
    writer.exec("INSERT INTO sessions VALUES('b','second',NULL,1785916900,NULL,NULL,'fixture'); INSERT INTO messages VALUES(2,'b','assistant','WAL-only fixture',1785916901)");
    const iterator = hermesAdapter.parse(path);
    expect((await iterator.next()).done).toBe(false);
    // A detached snapshot must not retain a live read transaction while the
    // consumer awaits publication of the first session.
    expect(writer.query('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
    writer.exec("UPDATE messages SET content='newer writer text' WHERE id=2");
    const second = await iterator.next();
    expect(second.done).toBe(false);
    if (!second.done) expect(second.value.messages[0].text).toBe('WAL-only fixture');
    await iterator.return(undefined as never);
    const next = await drain(path);
    expect(next.sessions[1].messages[0].text).toBe('newer writer text');
  });

  test('rejects oversized total DB plus sidecars before capture', async () => {
    const { path, writer } = fixture();
    writer.prepare('INSERT INTO messages VALUES(2,?,?,?,?)').run('a', 'assistant', 'x'.repeat(80000), 1785916802);
    const copies = trackCopies();
    await expect(drain(path, fs.statSync(path).size + 1)).rejects.toThrow('too large');
    expect(copies).toHaveLength(0);
  });

  test('checks the pinned logical size when a writer grows after the file census', async () => {
    const { path, writer } = fixture();
    const originalStat = fs.statSync;
    let grew = false;
    const spy = spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      const result = Reflect.apply(originalStat, fs, [file, ...args]);
      if (file === path + '-shm' && !grew) {
        grew = true;
        writer.prepare('INSERT INTO messages VALUES(2,?,?,?,?)').run('a', 'assistant', 'x'.repeat(80000), 1785916802);
      }
      return result;
    }) as typeof fs.statSync);
    restores.push(() => spy.mockRestore());
    await expect(drain(path, 50000)).rejects.toThrow('too large');
    expect(grew).toBe(true);
    expect(writer.query('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
  });

  test('cleans the snapshot on early iterator return and capture failure', async () => {
    const { path, writer } = fixture();
    const copies = trackCopies();
    const iterator = hermesAdapter.parse(path);
    await iterator.next();
    await iterator.return(undefined as never);
    expect(copies).toHaveLength(1);
    expect(fs.existsSync(copies[0])).toBe(false);
    const spy = spyOn(Database.prototype, 'serialize').mockImplementation(() => { throw new Error('synthetic capture failure'); });
    restores.push(() => spy.mockRestore());
    await expect(drain(path)).rejects.toThrow('synthetic capture failure');
    expect(copies.every(copy => !fs.existsSync(copy))).toBe(true);
    expect(writer.query('PRAGMA wal_checkpoint(TRUNCATE)').get()).toMatchObject({ busy: 0 });
  });

  test('missing sidecars are safe and host schema drift still carries diagnostics', async () => {
    const { path, writer } = fixture();
    writer.exec('PRAGMA journal_mode=DELETE; DROP TABLE sessions');
    const copies = trackCopies();
    const result = await drain(path);
    expect(result.sessions).toHaveLength(0);
    expect(result.diagnostics.zeroSessionsReason).toContain('schema mismatch reading sessions table');
    expect(copies).toHaveLength(1);
    expect(fs.existsSync(copies[0])).toBe(false);
  });
});
