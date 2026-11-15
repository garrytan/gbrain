/**
 * GST-2768 PR 2: the OpenClaw Gateway reader against responses recorded from OpenClaw 2026.11.3 (sessions.list and
 * chat.history over `openclaw gateway call`), plus doc-shaped group rows. Covers paging, chatType mapping (only a
 * verified chatType counts; the key's shape never does), the unknown channel resolving owner-only, the CLI error
 * envelopes mapped to archive_gateway_auth / archive_gateway_unreachable, redacted error bodies, and a failed reader
 * leaving the ledger unchanged. Repo-less PGLite for the archive cases.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { addGroup, addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { gatewayChannel, openclawGatewayReader, parseGatewayCliOutput, type GatewayTransport } from '../src/core/transcripts/openclaw-gateway.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveGroupPrincipal, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { archivedPages, conversation, ledgerRows, staticReader } from './helpers/transcript-archive.ts';

const SYNTHETIC_ANTHROPIC = ['sk', 'ant', 'api03', 'SYNTHETIC'.repeat(4) + '0000000000-AAAAAAAA'].join('-');
const FIX = join(import.meta.dir, 'fixtures', 'openclaw-gateway');
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as Record<string, unknown>;

/** Serves the recorded pages by method, offset and session key. */
function recordedTransport(opts: { list: Array<Record<string, unknown>>; history: Record<string, Array<Record<string, unknown>>> }): GatewayTransport & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'sessions.list') {
        const offset = Number(params.offset ?? 0);
        return opts.list.find(p => (p.__offset ?? 0) === offset) ?? opts.list[0];
      }
      if (method === 'chat.history') {
        const pages = opts.history[String(params.sessionKey)] ?? [];
        const offset = Number(params.offset ?? 0);
        return pages.find(p => (p.__offset ?? 0) === offset) ?? { sessionKey: params.sessionKey, messages: [], hasMore: false };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const recorded = () => recordedTransport({
  list: [load('sessions-list-page1.json'), { ...load('sessions-list-page2.json'), __offset: 2 }],
  history: {
    'agent:dev:example-scratch-alpha': [load('chat-history-scratch-alpha-page1.json'), { ...load('chat-history-scratch-alpha-page2.json'), __offset: 2 }],
    'agent:dev:example-scratch-3': [load('chat-history-scratch-3.json')],
    'agent:dev:telegram:group:example-group-9': [load('chat-history-group-shaped-key.json')],
  },
});

const docShaped = () => recordedTransport({
  list: [load('sessions-list-group-docshape.json')],
  history: {
    'agent:main:telegram:group:example-group-1': [load('chat-history-group-docshape.json')],
    'agent:main:webhook:example-legacy-row': [load('chat-history-legacy-row.json')],
  },
});

describe('openclaw gateway reader (recorded fixtures)', () => {
  test('pages sessions.list by nextOffset and chat.history backward, oldest first, user and assistant text only', async () => {
    const transport = recorded();
    const convs = await openclawGatewayReader({ transport }).list({});
    expect(transport.calls.filter(([m]) => m === 'sessions.list').map(([, p]) => p.offset ?? 0)).toEqual([0, 2]);
    expect(convs.map(c => c.conversationKey)).toEqual(['agent:dev:example-scratch-alpha', 'agent:dev:telegram:group:example-group-9']);
    const alpha = convs[0]!;
    expect(alpha.harness).toBe('openclaw');
    expect(alpha.session.meta.sessionId).toBe('318c6a69-4cfa-4aba-bda5-8babbb465c4e');
    expect(alpha.session.messages.map(m => [m.role, m.text])).toEqual([
      ['assistant', 'hello from synthetic user'], ['user', 'what is the capital of acme-example land']]);
    expect(alpha.session.messages[0]!.timestamp).toBe(new Date(1794721281750).toISOString());
  });

  test('chatType mapping: only the row chatType counts, never the key shape or kind', async () => {
    const [, groupShaped] = await openclawGatewayReader({ transport: recorded() }).list({});
    expect(groupShaped!.channel).toEqual({ chatType: 'direct', verified: true });
    const doc = await openclawGatewayReader({ transport: docShaped() }).list({});
    expect(doc.map(c => c.channel)).toEqual([{ chatType: 'group', verified: true }, { verified: false }]);
    expect(gatewayChannel({ key: 'agent:main:cron:nightly-digest', chatType: 'direct' })).toEqual({ chatType: 'direct', verified: true, cronJob: 'nightly-digest' });
    expect(gatewayChannel({ key: 'x', chatType: 'channel' })).toEqual({ verified: false });
  });

  test('the CLI error envelopes map to the stable codes, and an error body is redacted before it is shown', () => {
    const codeOf = (name: string) => { try { parseGatewayCliOutput(JSON.stringify(load(name)), 1); return null; } catch (e) { return (e as { code?: string }).code; } };
    expect(codeOf('error-auth.json')).toBe('archive_gateway_auth');
    expect(codeOf('error-credentials-required.json')).toBe('archive_gateway_auth');
    expect(codeOf('error-unreachable.json')).toBe('archive_gateway_unreachable');
    const leaky = JSON.stringify({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: 'unauthorized: token ' + SYNTHETIC_ANTHROPIC + ' rejected', details: { code: 'AUTH_TOKEN_MISMATCH' } } });
    let message = '';
    try { parseGatewayCliOutput(leaky, 1); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('<REDACTED:');
    expect(message).not.toContain('SYNTHETICSYNTHETIC');
    expect(parseGatewayCliOutput(JSON.stringify(load('sessions-list-page2.json')), 0)).toMatchObject({ hasMore: false });
  });
});

describe('gateway reader inside the archive (pglite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    await setArchiveEnabled(engine, true);
  });

  test('on a shared brain the verified group gets owner plus its existing group; the unknown channel resolves owner only', async () => {
    await engine.setConfig('brain.audience', 'shared');
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    await setOwner(engine, 'alice-example');
    const groupKey = 'agent:main:telegram:group:example-group-1';
    await addGroup(engine, archiveGroupPrincipal('openclaw', groupKey), ['bob-example']);
    const result = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-14', to: '2026-11-15', readers: [openclawGatewayReader({ transport: docShaped() })], now: new Date('2026-11-20T00:00:00Z') });
    expect(result.held).toBe(0);
    const pages = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/openclaw/'));
    const group = pages.find(p => (p.frontmatter.transcript_archive as Record<string, unknown>).chat_type === 'group')!;
    expect(group.slug).toMatch(/\/group-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(group.frontmatter.readable_by).toEqual(['alice-example', `group:${archiveGroupPrincipal('openclaw', groupKey)}`]);
    const unknown = pages.find(p => p !== group)!;
    expect(unknown.frontmatter.readable_by).toEqual(['alice-example']);
    expect(unknown.slug).not.toContain('legacy-row');
  }, 60_000);

  test('auth and unreachable failures carry their codes, leave the ledger unchanged and do not stop other readers', async () => {
    const failing = (code: 'archive_gateway_auth' | 'archive_gateway_unreachable') => openclawGatewayReader({ transport: {
      async call() { return parseGatewayCliOutput(JSON.stringify(load(code === 'archive_gateway_auth' ? 'error-auth.json' : 'error-unreachable.json')), 1); },
    } });
    const other = staticReader('codex', [conversation('codex', 'rollout-ok', [['user', '2026-11-14T10:00:00.000Z', 'still archived']])]);
    const opts = { mode: 'backfill' as const, from: '2026-11-13', to: '2026-11-15', now: new Date('2026-11-20T00:00:00Z') };
    await runTranscriptArchive(engine, { ...opts, readers: [other] });
    const before = await ledgerRows(engine);
    for (const code of ['archive_gateway_auth', 'archive_gateway_unreachable'] as const) {
      const result = await runTranscriptArchive(engine, { ...opts, readers: [failing(code), other] });
      expect(result.errors.map(e => [e.harness, e.code])).toEqual([['openclaw', code]]);
      expect(result.errors[0]!.fix?.argv?.[0]).toBe('openclaw');
      expect(await ledgerRows(engine)).toEqual(before);
    }
  }, 60_000);
});
