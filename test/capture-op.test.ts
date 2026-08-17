/**
 * CLI→MCP gap-closure wave — the capture op (D2A). Pins: default-slug
 * determinism, the NUL/empty guards, the frontmatter merge (single block),
 * put_page delegation (provenance server-stamped mcp:put_page for remote —
 * honest CV6 delegation), the [EV7] bound-prefix default for fenced clients,
 * and content_hash stability.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('capture op', () => {
  test('captures a note under a stable inbox/ slug and stamps provenance server-side', async () => {
    const content = 'Decided to use PGLite as the default engine: zero-config wins.';
    const res = await dispatchToolCall(engine, 'capture', { content }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.slug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(body.channel).toBe('capture');
    expect(typeof body.content_hash).toBe('string');

    const page = await engine.getPage(body.slug);
    expect(page).toBeTruthy();
    // CV6: remote provenance is server-stamped by the delegated put_page.
    expect(page?.source_kind).toBe('mcp:put_page');
    // Frontmatter merged as a single stamped block.
    expect(page?.frontmatter?.captured_at).toBeDefined();

    // Idempotent default slug: identical normalized content → same slug.
    const again = parsed(await dispatchToolCall(engine, 'capture', { content: `  ${content}\r\n` }, { ...STDIO }));
    expect(again.slug).toBe(body.slug);
    expect(again.content_hash).toBe(body.content_hash);
  });

  test('type routes the default slug prefix (diary → life/diary/)', async () => {
    const body = parsed(await dispatchToolCall(engine, 'capture', {
      content: 'Long day, good demo.', type: 'diary',
    }, { ...STDIO }));
    expect(body.slug).toMatch(/^life\/diary\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  });

  test('NUL byte and empty content are refused with named errors', async () => {
    const nul = parsed(await dispatchToolCall(engine, 'capture', { content: 'ab\u0000cd' }, { ...STDIO }));
    expect(nul.error).toBe('invalid_params');
    expect(nul.message).toContain('NUL');
    const empty = parsed(await dispatchToolCall(engine, 'capture', { content: '   \n  ' }, { ...STDIO }));
    expect(empty.error).toBe('invalid_params');
    expect(empty.message).toContain('empty');
  });

  test('[EV7] fenced client: default slug nests under the first bound prefix', async () => {
    const auth: AuthInfo = { token: 't', clientId: 'fenced-agent', scopes: ['write'], boundSlugPrefixes: ['wiki/agents/x/'] };
    const body = parsed(await dispatchToolCall(engine, 'capture', { content: 'fenced note' }, {
      ...STDIO, auth,
    }));
    expect(body.slug).toMatch(/^wiki\/agents\/x\/inbox\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    // An explicit out-of-fence slug still denies via the inherited fence.
    const denied = parsed(await dispatchToolCall(engine, 'capture', {
      content: 'escape attempt', slug: 'inbox/escape',
    }, { ...STDIO, auth }));
    expect(denied.error).toBe('permission_denied');
  });

  test('[EV7] fenced client + typed capture: the ENTIRE default slug (type prefix included) nests under the bound prefix', async () => {
    const auth: AuthInfo = { token: 't', clientId: 'fenced-agent', scopes: ['write'], boundSlugPrefixes: ['wiki/agents/x/'] };
    const body = parsed(await dispatchToolCall(engine, 'capture', {
      content: 'fenced diary note', type: 'diary',
    }, { ...STDIO, auth }));
    expect(body.slug).toMatch(/^wiki\/agents\/x\/life\/diary\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(body.slug).not.toContain('diary/diary');
  });

  test('dry_run short-circuits before any write', async () => {
    const body = parsed(await dispatchToolCall(engine, 'capture', { content: 'dry note', dry_run: true }, { ...STDIO }));
    expect(body.dry_run).toBe(true);
    const page = await engine.getPage(body.slug);
    expect(page).toBeNull();
  });
});
