/**
 * The OpenClaw Gateway reader's process count and concurrency, against a stub `openclaw` that waits a start-up delay
 * per invocation and pages chat.history the way OpenClaw 2026.11.3 does. The large-install shape is 350 sessions, 40
 * of them active, whose history is 158 pages at the old 200-message page. Every value is synthetic.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliGatewayTransport, openclawGatewayReader } from '../src/core/transcripts/openclaw-gateway.ts';
import { gatewayStub, largeInstall, maxOverlap, type StubSession } from './helpers/openclaw-gateway-stub.ts';

const dir = mkdtempSync(join(tmpdir(), 'openclaw-pages-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-10T12:00:00Z');
const SINCE = NOW - 4 * 86_400_000;
const token = ['tok', 'synthetic', 'pages'].join('-');
const reader = (bin: string) => openclawGatewayReader({ transport: cliGatewayTransport({ bin, url: 'ws://127.0.0.1:18789', token, timeoutMs: 20_000 }) });
const expected = (s: StubSession) => Array.from({ length: s.messages }, (_, i) => 'synthetic message ' + i + ' in ' + s.key);

describe('openclaw gateway reader: pages and processes', () => {
  test('the large-install shape reads in 52 process starts instead of 162, at most 4 side by side, every message in order', async () => {
    const sessions = largeInstall(NOW);
    const stub = gatewayStub({ dir, sessions, delayMs: 100, answerMs: [0, 80] });
    const convs = await reader(stub.bin).list({ sinceMs: SINCE });
    const calls = stub.calls();
    expect(calls.filter(c => c.method === 'sessions.list')).toHaveLength(4);
    expect(calls.filter(c => c.method === 'chat.history')).toHaveLength(48);
    const overlap = maxOverlap(calls, 'chat.history');
    expect(overlap).toBeGreaterThan(1);
    expect(overlap).toBeLessThanOrEqual(4);
    for (const c of calls) expect(JSON.stringify(c.params)).not.toContain(token);
    const recent = sessions.filter(s => s.updatedAt >= SINCE);
    expect(convs.map(c => c.scopeKey)).toEqual(recent.map(s => s.key));
    for (const [i, conv] of convs.entries()) {
      expect(conv.conversationKey).toBe(recent[i]!.sessionId);
      expect(conv.session.messages.map(m => m.text)).toEqual(expected(recent[i]!));
      const stamps = conv.session.messages.map(m => m.timestamp);
      expect(stamps).toEqual([...stamps].sort());
    }
  }, 120_000);

  test('a Gateway from before 2026.10 that refuses maxBytes is read in full without it after the first refusals', async () => {
    const sessions: StubSession[] = Array.from({ length: 6 }, (_, i) => ({ key: 'agent:main:example-old-' + i, sessionId: 'old-' + i, messages: 500, updatedAt: NOW - 1000 * i }));
    const stub = gatewayStub({ dir, sessions, delayMs: 20, rejectMaxBytes: true, name: 'openclaw-old' });
    const convs = await reader(stub.bin).list({});
    expect(convs.map(c => c.session.messages.map(m => m.text))).toEqual(sessions.map(expected));
    const history = stub.calls().filter(c => c.method === 'chat.history');
    const refused = history.filter(c => c.params.maxBytes !== undefined);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThanOrEqual(4);
    expect(history.length - refused.length).toBe(6 * 3);
  }, 60_000);

  test('one failed session read fails the whole read, and no read is still running when it does', async () => {
    const sessions: StubSession[] = Array.from({ length: 12 }, (_, i) => ({ key: 'agent:main:example-fail-' + i, sessionId: 'fail-' + i, messages: 30, updatedAt: NOW - 1000 * i }));
    const stub = gatewayStub({ dir, sessions, delayMs: 150, failKey: 'agent:main:example-fail-2', name: 'openclaw-fail' });
    const err = await reader(stub.bin).list({}).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe('archive_gateway_auth');
    const settled = stub.calls().length;
    await new Promise(r => setTimeout(r, 600));
    expect(stub.calls().length).toBe(settled);
    expect(stub.calls().filter(c => c.method === 'chat.history').length).toBeLessThan(12);
  }, 60_000);
});
