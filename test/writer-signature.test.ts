/**
 * Sina's point (2026-11-05): a brain already records which principal wrote a page, but a hosted caller
 * that shares one principal with other AIs could not say which AI it was. A request may now sign itself
 * with the `x-gbrain-writer` header; the write records it on the request's authority, and the existing
 * attribution read shows it — no column, no migration, no new auth path.
 *
 * Protects: the mounted MCP transport reads the header and admission records it, the signature appears on
 * the attribution views a read already returns, an unsigned write is unchanged, and a junk header is
 * dropped rather than stored or refused. Fails when: the header is dropped before admission, invented at
 * read time, or a malformed value reaches the record.
 * Seams: the mounted SDK transport (bearer + worktree claim as a hosted caller would), and the op the
 * read already has. PGLite only: this is a header-to-row path, not a database behaviour.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { mountMcp } from '../src/commands/serve-http-mcp.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseWriterSignature } from '../src/core/persistence/attribution.ts';

const SLUG = 'notes/signed-write';
const TOKEN = `synthetic-writer-signature-${process.pid}`;
let engine: BrainEngine;
let root: string;
let http: Server;
let base: string;

beforeAll(async () => {
  const db = new PGLiteEngine();
  await db.connect({});
  await db.initSchema();
  engine = db;
  root = mkdtempSync(join(tmpdir(), 'gbrain-writer-signature-'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=\'default\'', [root]);
  await claimWorktree(engine, 'default', root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw("INSERT INTO access_tokens(name,token_hash,scopes) VALUES('Synthetic writer token',$1,'{read,write}')", [hashToken(TOKEN)]);
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const app = express();
  mountMcp(app, { engine, config: { engine: 'pglite', embedding_disabled: true }, resourceVerifier: provider,
    resourceMetadataUrl: 'http://127.0.0.1/resource', mcpResourceUrl: new URL('http://127.0.0.1/mcp'),
    mcpOperationsBase: Object.values(operationsByName).filter(op => !op.localOnly && !op.cliOnly), broadcastEvent() {} } as unknown as ServeHttpContext);
  http = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

const content = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n# ${title}\n\nA synthetic page.\n`;
/** One real `tools/call` over the mounted transport, signed with the header (or not). */
async function write(title: string, writer?: string) {
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  const response = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(writer ? { 'x-gbrain-writer': writer } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'put_page',
      arguments: { slug: SLUG, content: content(title), ...(snapshot ? { expected_revision: snapshot.revision } : {}) } } }) });
  expect(response.status).toBe(200);
  expect((await response.text()).includes('"isError":true')).toBe(false);
}
const attributed = async () => await operationsByName.get_write_attribution.handler({
  engine, sourceId: 'default', remote: false, config: { engine: 'pglite', embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} },
} as unknown as OperationContext, { slug: SLUG }) as Record<string, any>;

test('a write signed with the header records the AI that declared itself, and the attribution read shows it', async () => {
  await write('First by Claude', 'Claude Code');
  expect((await attributed()).live_revision.written_by.writer).toBe('Claude Code');

  await write('Then by Codex', 'Codex');
  const second = await attributed();
  expect(second.created.writer).toBe('Claude Code');
  expect(second.last.writer).toBe('Codex');
  expect(second.live_revision.written_by.writer).toBe('Codex');

  await write('Unsigned edit');
  expect((await attributed()).live_revision.written_by.writer).toBeUndefined();

  expect(parseWriterSignature('  ')).toBeUndefined();
  expect(parseWriterSignature(`bad${String.fromCharCode(7)}signature`)).toBeUndefined();
  expect(parseWriterSignature('x'.repeat(121))).toBeUndefined();
  expect(parseWriterSignature('  Claude Code  ')).toBe('Claude Code');
}, 240_000);
