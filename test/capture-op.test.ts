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
  // #4655: pin the active pack via the DB plane (tier-4) so the write-time
  // vocabulary checks resolve gbrain-base regardless of the host's file config.
  await engine.setConfig('schema_pack', 'gbrain-base');
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

  // #4655: EXPLICIT undeclared page types are rejected fail-loud, naming the
  // pack and its declared vocabulary. STDIO carries remote: true, so these
  // double as the remote-caller negative tests for the changed op.
  test('rejects an undeclared explicit page type before writing (remote)', async () => {
    const slug = 'inbox/capture-bad-explicit-type';
    const body = parsed(await dispatchToolCall(engine, 'capture', {
      content: 'This should not be written.',
      slug,
      type: 'definitely_not_a_type',
    }, { ...STDIO }));
    expect(body.error).toBe('invalid_params');
    expect(body.message).toContain("page type 'definitely_not_a_type' is not declared");
    expect(body.message).toContain('gbrain-base');
    // The suggestion names the declared vocabulary so agents self-correct.
    expect(body.suggestion).toContain('Use a declared page type');
    expect(body.suggestion).toContain('analysis');
    expect(await engine.getPage(slug)).toBeNull();
  });

  test('rejects an undeclared frontmatter page type before writing (remote)', async () => {
    const slug = 'inbox/capture-bad-frontmatter-type';
    const body = parsed(await dispatchToolCall(engine, 'capture', {
      content: '---\ntype: definitely_not_a_type\n---\n\nThis should not be written.',
      slug,
    }, { ...STDIO }));
    expect(body.error).toBe('invalid_params');
    expect(body.message).toContain("page type 'definitely_not_a_type' is not declared");
    expect(await engine.getPage(slug)).toBeNull();
  });

  // Ship-review fix on the #4721 rework: with no `type` param the handler
  // used to validate the frontmatter's explicit type against the pack, then
  // hand the defaulted 'note' to mergeCaptureFrontmatter (opts.type wins) —
  // so a capture APPROVED as 'person' was STORED as 'note'. The effective
  // type is the validated explicit/frontmatter type when present, else
  // 'note', and it drives both the stamp and the default-slug prefix.
  test('frontmatter type is the stored type when no type param is given', async () => {
    const slug = 'inbox/capture-frontmatter-type-kept';
    const body = parsed(await dispatchToolCall(engine, 'capture', {
      content: '---\ntype: person\ntitle: Alice Example\n---\n\nDeclared frontmatter type, no explicit param.',
      slug,
    }, { ...STDIO }));
    expect(body.error).toBeUndefined();
    const page = await engine.getPage(slug);
    // put_page lifts the stamped frontmatter `type` into the type column.
    expect(page?.type).toBe('person');
  });

  test('the default-slug prefix follows the frontmatter type (diary → life/diary/)', async () => {
    const body = parsed(await dispatchToolCall(engine, 'capture', {
      content: '---\ntype: diary\n---\n\nFrontmatter diary, no explicit param.',
    }, { ...STDIO }));
    expect(body.error).toBeUndefined();
    expect(body.slug).toMatch(/^life\/diary\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect((await engine.getPage(body.slug))?.type).toBe('diary');
  });

  test('no frontmatter and no type param still stamps note; an explicit type param beats frontmatter', async () => {
    const plain = parsed(await dispatchToolCall(engine, 'capture', {
      content: 'Plain body, nothing declared.', slug: 'inbox/capture-plain-note',
    }, { ...STDIO }));
    expect((await engine.getPage(plain.slug))?.type).toBe('note');
    const explicit = parsed(await dispatchToolCall(engine, 'capture', {
      content: '---\ntype: person\n---\n\nParam wins over frontmatter.',
      slug: 'inbox/capture-param-beats-frontmatter',
      type: 'meeting',
    }, { ...STDIO }));
    expect(explicit.error).toBeUndefined();
    expect((await engine.getPage(explicit.slug))?.type).toBe('meeting');
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
