/**
 * ENG-O14 cross-lane journey: #5081 with #5032. A stdio connection bound by
 * GBRAIN_SOURCE=work reads a colon-slug page from a federated source by naming
 * it (#5081), still cannot write into that source (read admission confers no
 * write right), and its own colon-slug writes follow #5032: refused before
 * admission on Windows when the write source writes through to files,
 * database-only writes succeed, and macOS and Linux are unchanged.
 *
 * Off Windows the Windows case runs with `process.platform` forced to win32;
 * on the windows-latest security-regressions job it runs natively.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { nativeLockCapability } from '../src/core/persistence/native-lock.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { resolveMcpStdioSourceScope } from '../src/mcp/server.ts';
import { withEnv } from './helpers/with-env.ts';

const NATIVE_WINDOWS = process.platform === 'win32';
const home = mkdtempSync(join(tmpdir(), 'gbrain-5081-5032-'));
const workRoot = join(home, 'work');
let engine: PGLiteEngine;
const PAGE = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${title} body.\n`;

async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  if (NATIVE_WINDOWS) return fn();
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

async function boundOpts(): Promise<DispatchOpts> {
  const scope = await withEnv({ GBRAIN_SOURCE: 'work' }, () => resolveMcpStdioSourceScope(engine, home));
  return {
    remote: true, transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: scope.sourceId,
    ...(scope.explicitReadBinding ? { explicitReadBinding: scope.explicitReadBinding } : {}),
  };
}

async function call(name: string, params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, name, params, await boundOpts());
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

beforeAll(async () => {
  await nativeLockCapability();
  mkdirSync(workRoot);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('work', 'work', $1, '{}'::jsonb)`, [workRoot]);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('notes', 'notes', NULL, '{"federated": true}'::jsonb)`);
  const seeded = await importFromContent(engine, 'calendar:standup', PAGE('Standup'), { sourceId: 'notes', noEmbed: true });
  expect(seeded.status).toBe('imported');
}, 60_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

describe('ENG-O14 #5081 + #5032', () => {
  test('the bound connection reads a federated colon-slug page by naming its source', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { isError, body } = await call('get_page', { slug: 'calendar:standup', source_id: 'notes' });
    expect(isError).toBe(false);
    expect(body.source_id).toBe('notes');
    expect((await call('get_page', { slug: 'calendar:standup' })).isError).toBe(true);
  }));

  test('read admission confers no write right into the admitted source', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { isError, body } = await call('put_page', { slug: 'calendar:retro', content: PAGE('Retro'), source_id: 'notes' });
    expect(isError).toBe(true);
    expect(body.error).toBe('permission_denied');
    expect(await engine.getPage('calendar:retro', { sourceId: 'notes' })).toBeNull();
  }));

  test('Windows: a colon-slug write into the write-through bound source is refused before admission', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { isError, body } = await asWindows(() => call('put_page', { slug: 'calendar:planning', content: PAGE('Planning') }));
    expect(isError).toBe(true);
    expect(body.error).toBe('colon_slug_windows_write_through');
    expect(body.docs).toBe('docs/guides/write-refusals.md#colon_slug_windows_write_through');
    expect(await engine.getPage('calendar:planning', { sourceId: 'work' })).toBeNull();
  }));

  test.skipIf(NATIVE_WINDOWS)('macOS and Linux: the same write lands in the bound source and its file', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { isError } = await call('put_page', { slug: 'calendar:planning', content: PAGE('Planning') });
    expect(isError).toBe(false);
    expect(await engine.getPage('calendar:planning', { sourceId: 'work' })).not.toBeNull();
    expect(existsSync(join(workRoot, 'calendar:planning.md'))).toBe(true);
  }));
});
