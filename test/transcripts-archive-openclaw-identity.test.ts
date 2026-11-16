/**
 * GST-2768 PR 2: one OpenClaw conversation has one identity, its sessionId, whichever path read it. A backfill from
 * the session files while the Gateway is down, then a run with the Gateway up over the same days, leaves one page per
 * conversation-day: the Gateway's session key only labels and scopes the page. Synthetic values. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { fileReader } from '../src/core/transcripts/archive-readers.ts';
import { openclawGatewayReader, parseGatewayCliOutput } from '../src/core/transcripts/openclaw-gateway.ts';
import { archivedPages } from './helpers/transcript-archive.ts';

const root = mkdtempSync(join(tmpdir(), 'openclaw-identity-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

const SID = 'example-session-id-0001';
const KEY = 'agent:main:telegram:group:example-group-7';
const TURNS: Array<[string, string, string]> = [
  ['user', '2026-11-09T08:00:00.000Z', 'monday question'], ['assistant', '2026-11-09T08:01:00.000Z', 'monday answer'],
  ['user', '2026-11-10T08:00:00.000Z', 'tuesday question'], ['assistant', '2026-11-10T08:01:00.000Z', 'tuesday answer'],
];
const lines = [{ type: 'session', version: 3, id: SID, timestamp: TURNS[0]![1], cwd: '/home/alice-example/agent-workspace' },
  ...TURNS.map(([role, timestamp, text], i) => ({ type: 'message', id: 'm' + i, parentId: i ? 'm' + (i - 1) : null, timestamp, message: { role, timestamp, content: [{ type: 'text', text }] } }))];
writeFileSync(join(root, SID + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

const down = openclawGatewayReader({ transport: { async call() {
  return parseGatewayCliOutput(JSON.stringify({ ok: false, error: { type: 'gateway_transport_error', message: 'connect ECONNREFUSED 127.0.0.1:18789', details: { kind: 'closed' } } }), 1);
} } }) as unknown as ArchiveReader;
const up = openclawGatewayReader({ transport: { async call(method: string) {
  if (method === 'sessions.list') return { sessions: [{ key: KEY, sessionId: SID, chatType: 'group', updatedAt: Date.parse('2026-11-10T08:01:00.000Z') }], hasMore: false };
  return { sessionKey: KEY, sessionId: SID, messages: TURNS.map(([role, ts, text], i) => ({ role, content: [{ type: 'text', text }], timestamp: Date.parse(ts), __openclaw: { id: 'm' + i, seq: i } })), hasMore: false };
} } }) as unknown as ArchiveReader;
const files = () => fileReader({ format: 'openclaw', root, extension: '.jsonl' });
const NOW = new Date('2026-11-10T23:00:00Z');
const dayPages = async () => (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/openclaw/')).map(p => p.slug);

describe('one identity for an OpenClaw conversation (pglite)', () => {
  test('files-only backfill with the Gateway down, then a Gateway run over the same days: one page per day, no duplicates', async () => {
    const backfill = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-01', readers: [files(), down], now: NOW });
    expect(backfill.days.filter(d => d.status === 'written').map(d => d.day).sort()).toEqual(['2026-11-09', '2026-11-10']);
    const run = await runTranscriptArchive(engine, { mode: 'run', readers: [files(), up], now: NOW });
    expect(run.errors).toEqual([]);
    const slugs = await dayPages();
    expect(slugs.length).toBe(2);
    expect(slugs.map(s => s.split('/')[2]).sort()).toEqual(['2026-11-09', '2026-11-10']);
    const again = await runTranscriptArchive(engine, { mode: 'run', readers: [files(), up], now: NOW });
    expect(again.written).toBe(0);
    expect(await dayPages()).toEqual(slugs);
  }, 60_000);
});
