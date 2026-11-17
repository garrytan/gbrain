/**
 * `foresights inbox`: the drop folder wired to the capture pipeline.
 *
 * - processInboxOnce with textOnly: text files are delivered then archived; a file no
 *   processor reads (PDF, image) stays in the inbox; dot files are skipped; a delivery
 *   that fails leaves the file in the inbox.
 * - binary content_hash is the SHA-256 of the bytes, not of path + size + mtime.
 * - runInbox on a PGLite brain (no worker) writes the page right away; the same file
 *   again applies once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashFileBytes, processInboxOnce, listInboxFiles, archiveDateFolder } from '../src/core/ingestion/sources/inbox-folder.ts';
import type { IngestionEvent, IngestionSourceContext } from '../src/core/ingestion/types.ts';
import { runInbox, inboxCaptureKey } from '../src/commands/inbox.ts';

let dir: string;
const warnings: string[] = [];
const ctx = (): IngestionSourceContext => ({
  emit: () => {}, engine: null as never, config: {}, abortSignal: new AbortController().signal,
  logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} } as never,
});
const archived = (name: string) => join(dir, '.archived', archiveDateFolder(new Date()), name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-inbox-'));
  warnings.length = 0;
});

describe('processInboxOnce (textOnly)', () => {
  test('text is delivered then archived; a PDF stays with a note; dot files are skipped', async () => {
    writeFileSync(join(dir, 'note.md'), '# A note\nbody');
    writeFileSync(join(dir, 'scan.pdf'), '%PDF-1.4');
    writeFileSync(join(dir, '.DS_Store'), 'x');
    const delivered: IngestionEvent[] = [];
    const r = await processInboxOnce({ inboxDir: dir, textOnly: true, deliver: async e => { delivered.push(e); return true; } }, ctx());
    expect(r.emitted.map(f => f.split('/').pop())).toEqual(['note.md']);
    expect(r.held.map(f => f.split('/').pop())).toEqual(['scan.pdf']);
    expect(r.skipped.map(f => f.split('/').pop())).toEqual(['.DS_Store']);
    expect(delivered[0]?.content).toBe('# A note\nbody');
    expect(existsSync(archived('note.md'))).toBe(true);
    expect(existsSync(join(dir, 'note.md'))).toBe(false);
    expect(existsSync(join(dir, 'scan.pdf'))).toBe(true);
    expect(warnings.some(w => w.includes('scan.pdf left in the inbox'))).toBe(true);
  });

  test('a failed delivery leaves the file in the inbox', async () => {
    writeFileSync(join(dir, 'note.md'), 'body');
    const r = await processInboxOnce({ inboxDir: dir, textOnly: true, deliver: async () => false }, ctx());
    expect(r.failed.length).toBe(1);
    expect(existsSync(join(dir, 'note.md'))).toBe(true);
    expect(existsSync(archived('note.md'))).toBe(false);
  });

  test('nested files are found; the archive folder never is', async () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'deep.md'), 'deep');
    mkdirSync(join(dir, '.archived', 'old'), { recursive: true });
    writeFileSync(join(dir, '.archived', 'old', 'done.md'), 'done');
    expect(listInboxFiles(dir).map(f => f.slice(dir.length + 1))).toEqual(['sub/deep.md']);
  });
});

describe('binary content_hash', () => {
  test('is the SHA-256 of the bytes: equal bytes hash equal anywhere, different bytes differ', async () => {
    const a = join(dir, 'a.png'), b = join(dir, 'b.png'), c = join(dir, 'c.png');
    writeFileSync(a, Buffer.from([1, 2, 3, 4]));
    writeFileSync(b, Buffer.from([1, 2, 3, 4]));
    writeFileSync(c, Buffer.from([1, 2, 3, 5]));
    const ha = await hashFileBytes(a);
    expect(ha).toBe(createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex'));
    expect(await hashFileBytes(b)).toBe(ha);
    expect(await hashFileBytes(c)).not.toBe(ha);
  });
});

describe('runInbox on PGLite (no worker): pages are written right away', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  async function quiet<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { return { value: await fn(), out: lines.join('\n') }; } finally { console.log = orig; }
  }

  test('status lists what is waiting; run --once captures it as an inbox page and archives the original', async () => {
    writeFileSync(join(dir, 'idea.md'), '# Widget idea\n\nSell the widget to clinics first.\n');
    const status = JSON.parse((await quiet(() => runInbox(engine, ['status', '--dir', dir, '--json']))).out);
    expect(status.waiting).toEqual(['idea.md']);

    const out = JSON.parse((await quiet(() => runInbox(engine, ['run', '--once', '--dir', dir, '--json']))).out);
    expect(out.captured).toEqual(['idea.md']);
    expect(out.delivery).toBe('written');
    const pages = await engine.executeRaw<{ slug: string; compiled_truth: string }>(
      `SELECT slug, compiled_truth FROM pages WHERE slug LIKE 'inbox/%' AND deleted_at IS NULL`);
    expect(pages.length).toBe(1);
    expect(pages[0].compiled_truth).toContain('Sell the widget to clinics first.');
    expect(readdirSync(join(dir, '.archived', archiveDateFolder(new Date())))).toEqual(['idea.md']);
  });

  test('the same file dropped again applies once (no second page)', async () => {
    writeFileSync(join(dir, 'idea.md'), '# Widget idea\n\nSell the widget to clinics first.\n');
    await quiet(() => runInbox(engine, ['run', '--once', '--dir', dir, '--json']));
    const pages = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'inbox/%' AND deleted_at IS NULL`);
    expect(pages[0].n).toBe(1);
  });

  test('the capture key is per source and content', () => {
    expect(inboxCaptureKey(undefined, 'abc')).toBe('ingest:inbox:default:abc');
    expect(inboxCaptureKey('work', 'abc')).toBe('ingest:inbox:work:abc');
  });
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
