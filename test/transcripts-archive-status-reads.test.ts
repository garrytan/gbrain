/**
 * gbrain transcripts archive status (and the doctor check built on it) reads the archive's own records only: the
 * ledger, the config and what the last run recorded about each reader. It never runs a reader, so a slow Gateway or a
 * large session folder cannot slow it down. PGLite, synthetic sessions only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveStatus, runTranscriptArchive, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { cliGatewayTransport, openclawGatewayReader } from '../src/core/transcripts/openclaw-gateway.ts';
import { conversation } from './helpers/transcript-archive.ts';
import { gatewayStub } from './helpers/openclaw-gateway-stub.ts';

const dir = mkdtempSync(join(tmpdir(), 'archive-status-'));
const NOW = new Date('2026-11-10T09:00:00Z');
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig('brain.audience', 'personal');
  await setArchiveEnabled(engine, true);
});

function counting(harness: 'codex' | 'grok', fail?: Error): ArchiveReader & { reads: number } {
  const reader = {
    harness, name: harness, reads: 0,
    async list() {
      reader.reads++;
      if (fail) throw fail;
      return [conversation(harness, harness + '-a', [['user', '2026-11-09T08:00:00.000Z', 'first'], ['assistant', '2026-11-10T08:00:00.000Z', 'second']])];
    },
  };
  return reader;
}

describe('archive status reads no reader', () => {
  test('it reports what the last run read, as of that run, without reading again', async () => {
    const codex = counting('codex');
    await runTranscriptArchive(engine, { mode: 'run', readers: [codex], now: NOW });
    expect(codex.reads).toBe(1);
    const status = await archiveStatus(engine, { readers: [codex] });
    expect(codex.reads).toBe(1);
    expect(status.harnesses).toEqual([expect.objectContaining({
      harness: 'codex', reader: 'codex', conversations: 1, newest_session_day: '2026-11-10', newest_archived_day: '2026-11-10', read_mode: 'run',
    })]);
    expect(Date.parse(status.harnesses[0]!.read_at!)).toBeGreaterThan(0);
    expect(status.errors).toEqual([]);
  }, 60_000);

  test('a reader no run has read yet is listed as not read, and still not read', async () => {
    const grok = counting('grok');
    const status = await archiveStatus(engine, { readers: [grok, { harness: 'hermes', name: 'hermes', unavailable: 'no Hermes sessions on this machine' }] });
    expect(grok.reads).toBe(0);
    expect(status.harnesses.map(h => [h.reader, h.read_at, h.conversations, h.newest_session_day, h.info ?? null])).toEqual([
      ['grok', null, 0, null, null],
      ['hermes', null, 0, null, 'no Hermes sessions on this machine'],
    ]);
  });

  test('a reader that failed on the last run is reported with its code and when it failed, keeping the newest day it read before', async () => {
    await runTranscriptArchive(engine, { mode: 'run', readers: [counting('codex')], now: NOW });
    const failing = counting('codex', Object.assign(new Error('synthetic gateway refusal'), { code: 'archive_gateway_auth' }));
    await runTranscriptArchive(engine, { mode: 'run', readers: [failing], now: NOW });
    const status = await archiveStatus(engine, { readers: [failing] });
    expect(failing.reads).toBe(1);
    expect(status.errors).toEqual([expect.objectContaining({ reader: 'codex', code: 'archive_gateway_auth', message: 'synthetic gateway refusal' })]);
    expect(Date.parse(status.errors[0]!.at!)).toBeGreaterThan(0);
    expect(status.harnesses[0]).toMatchObject({ newest_session_day: '2026-11-10' });
  }, 60_000);

  test('a dry run records nothing about its reads', async () => {
    await runTranscriptArchive(engine, { mode: 'run', readers: [counting('codex')], now: NOW, dryRun: true });
    const status = await archiveStatus(engine, { readers: [counting('codex')] });
    expect(status.harnesses[0]).toMatchObject({ read_at: null, conversations: 0 });
  }, 60_000);

  test('status with the OpenClaw Gateway reader starts no openclaw process', async () => {
    const stub = gatewayStub({ dir, sessions: [{ key: 'agent:main:example-status', sessionId: 'status-1', messages: 4, updatedAt: NOW.getTime() }], delayMs: 50 });
    const gateway = openclawGatewayReader({ transport: cliGatewayTransport({ bin: stub.bin, timeoutMs: 10_000 }) });
    await runTranscriptArchive(engine, { mode: 'run', readers: [gateway], now: NOW });
    const started = stub.calls().length;
    expect(started).toBeGreaterThan(0);
    const status = await archiveStatus(engine, { readers: [gateway] });
    expect(stub.calls().length).toBe(started);
    expect(status.harnesses[0]).toMatchObject({ harness: 'openclaw', reader: 'openclaw-gateway', conversations: 1, newest_session_day: '2026-11-10' });
  }, 60_000);
});
