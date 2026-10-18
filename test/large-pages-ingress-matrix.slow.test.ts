/**
 * Large pages (Wave A, T14/T35/A8): the ingress x size matrix.
 *
 * Every raisable ingress bound derives from PAGE_MAX_BYTES (24 MiB), so a page
 * at the ceiling is admitted end to end and one byte over is refused with a
 * named limit, never truncated. Arms: CLI import (importFromContent, the local
 * put_page path), import and sync file reads, stdin, a managed put_page
 * through the journal and the local persistence IPC (with a second outstanding
 * write from the same principal), and export of a ceiling-size page.
 *
 * Slow tier: each ceiling-size import chunks 24 MiB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readImportBytes } from '../src/core/persistence/import-prepare.ts';
import { readSyncFile } from '../src/core/persistence/sync-discovery.ts';
import { readStdinBounded, DEFAULT_STDIN_MAX_BYTES } from '../src/core/interaction.ts';
import { PAGE_MAX_BYTES, PUSH_SCAN_MAX_FILE_BYTES } from '../src/core/page-size-policy.ts';
import { SYNC_READ_BOUND } from '../src/core/persistence/sync-blobs.ts';
import { PERSISTENCE_IPC_MAX_BYTES } from '../src/core/persistence/ipc.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { mcpStdioTransport } from '../src/mcp/server.ts';

const MB = 1_000_000;
const SIZES = [4.9 * MB, 12 * MB, PAGE_MAX_BYTES] as const;
const NEEDLE = 'quokkalanternneedle';
const LINE = 'alice-example: did acme-example ship the harvest report yet?\n';

/** A Markdown page of exactly `bytes` UTF-8 bytes with a needle in the middle. */
function page(bytes: number, title = 'Long chat'): string {
  const head = `---\ntype: note\ntitle: ${title}\n---\n\n`;
  const marker = `The code word is ${NEEDLE}.\n`;
  const room = bytes - head.length - marker.length;
  const half = LINE.repeat(Math.floor(room / 2 / LINE.length));
  const body = half + marker + half;
  return head + body + 'z'.repeat(bytes - head.length - body.length);
}

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'large-pages-matrix-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingress bounds derive from the 24 MiB page ceiling', () => {
  test('every raisable bound is at least the ceiling, and the push-scan cap leaves room for frontmatter', () => {
    expect(SYNC_READ_BOUND).toBe(PAGE_MAX_BYTES);
    expect(DEFAULT_STDIN_MAX_BYTES).toBe(PAGE_MAX_BYTES);
    expect(PUSH_SCAN_MAX_FILE_BYTES - PAGE_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    // A ceiling page of chat text escapes to well under the 32 MiB IPC frame as JSON.
    expect(JSON.stringify({ content: page(PAGE_MAX_BYTES) }).length).toBeLessThan(PERSISTENCE_IPC_MAX_BYTES);
  });

  for (const bytes of SIZES) {
    test(`CLI import (importFromContent): ${bytes} bytes is admitted, chunked and keyword-searchable`, async () => {
      const slug = `chats/import-${bytes}`;
      const result = await importFromContent(engine, slug, page(bytes), { noEmbed: true });
      expect(result.status).toBe('imported');
      expect((await engine.getChunks(slug)).length).toBeGreaterThan(100);
      expect((await engine.searchKeyword(NEEDLE, { limit: 20 })).map(hit => hit.slug)).toContain(slug);
    }, 180_000);
  }

  test('CLI import: one byte over the ceiling is refused before parsing, with the limit named', async () => {
    const result = await importFromContent(engine, 'chats/over', page(PAGE_MAX_BYTES + 1), { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('too large');
    expect(await engine.getPage('chats/over')).toBeNull();
  }, 60_000);

  test('import and sync file reads admit the ceiling and refuse one byte more', () => {
    const at = join(dir, 'at.md');
    const over = join(dir, 'over.md');
    writeFileSync(at, page(PAGE_MAX_BYTES));
    writeFileSync(over, page(PAGE_MAX_BYTES + 1));
    expect(readImportBytes(at).length).toBe(PAGE_MAX_BYTES);
    expect(() => readImportBytes(over)).toThrow(/too large/i);
    expect(readSyncFile(dir, 'at.md')?.length).toBe(PAGE_MAX_BYTES);
    expect(() => readSyncFile(dir, 'over.md')).toThrow(/exceeds|too large/i);
  });

  test('stdin admits the ceiling and refuses one byte more, never truncating', async () => {
    const at = await readStdinBounded({ stream: Readable.from([Buffer.from(page(PAGE_MAX_BYTES))]) });
    expect(at.kind).toBe('data');
    const over = await readStdinBounded({ stream: Readable.from([Buffer.from(page(PAGE_MAX_BYTES + 1))]) });
    expect(over.kind).toBe('error');
  }, 60_000);

  test('MCP stdio: a put_page JSON-RPC message carrying a ceiling-size page is read whole, not dropped with the session', async () => {
    const stdin = new PassThrough();
    const transport = mcpStdioTransport(stdin, new PassThrough());
    const errors: unknown[] = [];
    transport.onerror = error => { errors.push(error); };
    const received = new Promise<{ params?: { arguments?: { content?: string } } }>(resolve => { transport.onmessage = message => resolve(message as never); });
    await transport.start();
    const content = page(PAGE_MAX_BYTES).replaceAll('?', '"');
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'put_page', arguments: { slug: 'chats/stdio', content } } })}\n`);
    const message = await received;
    expect(errors).toEqual([]);
    expect(message.params?.arguments?.content?.length).toBe(content.length);
    await transport.close();
  }, 60_000);

  test('managed put_page: a ceiling-size write commits while the same principal has another write outstanding', async () => {
    await managedBrain(async brain => {
      const ctx = { ...brain.ctx, writeWaitMs: 240_000 };
      await Promise.all([
        submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'chats/managed-ceiling', request_id: randomUUID(), content: page(PAGE_MAX_BYTES, 'Ceiling') } }),
        submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'chats/managed-second', request_id: randomUUID(), content: page(4.9 * MB, 'Second') } }),
      ]);
      await disposePersistenceConsumer(brain.engine);
      const hits = (await brain.engine.searchKeyword(NEEDLE, { limit: 20 })).map(hit => hit.slug);
      expect(hits).toEqual(expect.arrayContaining(['chats/managed-ceiling', 'chats/managed-second']));
      const file = readFileSync(join(brain.root, 'chats', 'managed-ceiling.md'));
      expect(file.length).toBeGreaterThanOrEqual(PAGE_MAX_BYTES - 64);
      expect(file.length).toBeLessThan(PUSH_SCAN_MAX_FILE_BYTES);
    });
  }, 300_000);

  test('export writes a ceiling-size page whole', async () => {
    const { runExport } = await import('../src/commands/export.ts');
    const out = join(dir, 'export');
    await runExport(engine, ['--dir', out]);
    const files: string[] = [];
    const walk = (d: string) => { for (const name of readdirSync(d)) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(out);
    const exported = files.find(f => f.endsWith(`import-${PAGE_MAX_BYTES}.md`));
    expect(exported).toBeDefined();
    expect(readFileSync(exported!, 'utf-8')).toContain(NEEDLE);
    expect(statSync(exported!).size).toBeGreaterThanOrEqual(PAGE_MAX_BYTES - 64);
  }, 120_000);
});
