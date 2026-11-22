import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { telemetryEndpoint } from '../src/core/telemetry/endpoint.ts';
import {
  MAX_BATCH_BYTES, MAX_BATCH_EVENTS, buildBatch, countCommand, countCrash, countErrorCode, countOperation, deploymentOf, fetchPulse,
  flushCounts, forgetInstallation, noteRunVersion, readSettings, recordDoctor, recordEvent, sanitize, scoreBand, setTier, shouldSpawnSync,
  sizeBand, syncTelemetry, telemetryDir, telemetryStatus,
} from '../src/core/telemetry/client.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'gbrain-telemetry-client-'));
let n = 0;

/** Each test gets its own GBRAIN_HOME and no endpoint override. */
const it = (name: string, fn: () => unknown) =>
  test(name, () => withEnv({ GBRAIN_HOME: join(ROOT, `h${++n}`), GBRAIN_TELEMETRY_URL: undefined, GBRAIN_TELEMETRY: undefined }, fn));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const queue = () => (existsSync(join(telemetryDir(), 'events.jsonl')) ? readFileSync(join(telemetryDir(), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** A local stand-in for the ingest and pulse functions, answering with the given statuses in order. */
function standIn(statuses: number[], body: (path: string) => unknown = () => ({ accepted: 1, rejected: 0 })) {
  const posts: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'POST') posts.push(await req.json());
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return Response.json(body(path), { status });
    },
  });
  return { posts, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe('gbrain telemetry client: off by default', () => {
  it('with no answer, recording and counting write no file at all', () => {
    recordEvent({ event_type: 'setup', outcome: 'success' });
    countCommand('doctor');
    flushCounts();
    expect(existsSync(telemetryDir())).toBe(false);
    expect(readSettings().tier).toBe('off');
  });

  it('GBRAIN_TELEMETRY=off forces off over a community answer', async () => {
    setTier('community');
    const before = queue().length;
    await withEnv({ GBRAIN_TELEMETRY: 'off' }, () => {
      recordEvent({ event_type: 'setup', outcome: 'success' });
      expect(queue().length).toBe(before);
      expect(telemetryStatus().tier).toBe('off');
    });
  });

  it('off deletes the queue and the counts', () => {
    setTier('community');
    countCommand('doctor');
    flushCounts();
    expect(queue().length).toBe(1);
    setTier('off');
    expect(existsSync(join(telemetryDir(), 'events.jsonl'))).toBe(false);
    expect(existsSync(join(telemetryDir(), 'counts'))).toBe(false);
  });
});

describe('gbrain telemetry client: what is kept', () => {
  it('a yes records one consent event; files are 0600 under GBRAIN_HOME', () => {
    const s = setTier('community');
    expect(s.installation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(queue().map(e => e.event_type)).toEqual(['consent']);
    expect(queue()[0].answer).toBe('community');
    if (process.platform !== 'win32') {
      for (const f of ['settings.json', 'events.jsonl']) expect(statSync(join(telemetryDir(), f)).mode & 0o777).toBe(0o600);
    }
  });

  it('sanitize keeps only allowlisted fields with allowed values', () => {
    const row = sanitize({
      event_type: 'setup', gbrain_version: '0.61.2.0', harness: 'claude_code', step: 'done', slug: 'people/alice-example',
      error_code: 'Not a code: /home/x', failing_checks: ['embedding_coverage', 'has space', 'people/alice'], os: 'plan9',
      command_counts: { query: 3, 'people/alice-example': 1, Bad: 2 }, duration_s: 1.5,
    });
    expect(row).toEqual({ event_type: 'setup', gbrain_version: '0.61.2.0', harness: 'claude_code', step: 'done', failing_checks: ['embedding_coverage'], os: 'other', command_counts: { query: 3 } });
    expect(sanitize({ event_type: 'nope', gbrain_version: '1.0.0' })).toBeNull();
  });

  it('anonymous sends no install id; community sends it', () => {
    setTier('community');
    const id = readSettings().installation_id;
    expect(buildBatch().events.every(e => e.installation_id === id && e.tier === 'community')).toBe(true);
    setTier('anonymous');
    const events = buildBatch().events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => !('installation_id' in e) && e.tier === 'anonymous')).toBe(true);
  });

  it('counts fold into one daily_rollup per transport for finished days only', () => {
    setTier('anonymous');
    countCommand('query');
    countCommand('query');
    countErrorCode('page_not_found');
    countCrash('TypeError');
    countCrash('WeirdCustomError');
    countOperation('search', 'stdio');
    flushCounts();
    expect(buildBatch().events.filter(e => e.event_type === 'daily_rollup')).toEqual([]);
    const counts = join(telemetryDir(), 'counts');
    const today = readdirSync(counts)[0];
    writeFileSync(join(counts, `${yesterday()}.json`), readFileSync(join(counts, today)));
    rmSync(join(counts, today));
    const rollups = buildBatch().events.filter(e => e.event_type === 'daily_rollup');
    expect(rollups.map(e => e.transport).sort()).toEqual(['none', 'stdio']);
    const none = rollups.find(e => e.transport === 'none')!;
    expect(none.command_counts).toEqual({ query: 2 });
    expect(none.error_code_counts).toEqual({ page_not_found: 1 });
    expect(none.crash_counts).toEqual({ TypeError: 1, other: 1 });
    expect(rollups.find(e => e.transport === 'stdio')!.operation_counts).toEqual({ search: 1 });
  });

  it('a batch holds at most 100 events and 45,000 bytes', () => {
    setTier('community');
    for (let i = 0; i < 150; i++) recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
    expect(buildBatch().events.length).toBe(MAX_BATCH_EVENTS);
    setTier('off');
    setTier('community');
    const counts = join(telemetryDir(), 'counts');
    mkdirSync(counts, { recursive: true });
    const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`command-${'x'.repeat(50)}-${i}`, 9999]));
    for (let d = 1; d < 20; d++) {
      const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      writeFileSync(join(counts, `${day}.json`), JSON.stringify({ none: { command_counts: big }, stdio: { operation_counts: big } }));
    }
    const batch = buildBatch();
    expect(batch.bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(Buffer.byteLength(JSON.stringify(batch.events))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(batch.events.length).toBeLessThan(40);
  });

  it('the first run of a new version records an upgrade event', () => {
    setTier('community');
    const p = join(telemetryDir(), 'settings.json');
    writeFileSync(p, JSON.stringify({ ...readSettings(), last_run_version: '0.1.0' }));
    noteRunVersion('stable');
    const up = queue().filter(e => e.event_type === 'upgrade');
    expect(up.length).toBe(1);
    expect(up[0]).toMatchObject({ from_version: '0.1.0', outcome: 'success', channel: 'stable' });
    noteRunVersion('stable');
    expect(queue().filter(e => e.event_type === 'upgrade').length).toBe(1);
  });

  it('doctor records at most once a day, with bands instead of numbers', () => {
    setTier('anonymous');
    recordDoctor({ score: 72, failing: ['embedding_coverage', 'Has Space'], pages: 1234 });
    recordDoctor({ score: 10, failing: [], pages: 0 });
    const docs = queue().filter(e => e.event_type === 'doctor');
    expect(docs.length).toBe(1);
    expect(docs[0]).toMatchObject({ score_band: '70-89', failing_checks: ['embedding_coverage'], brain_size_band: '1k-9.9k', mode: 'manual' });
    expect([scoreBand(0), scoreBand(49), scoreBand(100), sizeBand(99), sizeBand(10_000), sizeBand(null)]).toEqual(['0-29', '30-49', '90-100', '1-99', '10k+', undefined]);
  });

  it('deployment: repo-less PGLite, Postgres, and thin clients', () => {
    expect(deploymentOf({ engine: 'pglite' } as GBrainConfig)).toBe('local_pglite');
    expect(deploymentOf({ engine: 'postgres' } as GBrainConfig)).toBe('local_postgres');
    expect(deploymentOf({ remote_mcp: { mcp_url: 'https://gbrain.io/mcp' } } as GBrainConfig)).toBe('thin_client_hosted');
    expect(deploymentOf({ remote_mcp: { mcp_url: 'https://brain.acme-example.com/mcp' } } as GBrainConfig)).toBe('thin_client_self_hosted');
    expect(deploymentOf(null, 'http')).toBe('self_hosted_http');
    expect(deploymentOf(null)).toBe('unknown');
  });
});

describe('gbrain telemetry client: sending', () => {
  it('in tests there is no live endpoint, and no path makes a network call', async () => {
    expect(telemetryEndpoint()).toBeNull();
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('network'); }) as unknown as typeof fetch;
    try {
      setTier('community');
      recordEvent({ event_type: 'setup', outcome: 'success' });
      expect(shouldSpawnSync()).toBe(false);
      expect((await syncTelemetry({ force: true })).status).toBe('blocked');
      expect((await forgetInstallation()).status).toBe('blocked');
      expect(await fetchPulse()).toEqual({ ok: false, reason: 'blocked' });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });

  it('a 2xx clears what was sent and records it; the next try waits 6 hours', async () => {
    const s = standIn([200]);
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: s.url }, async () => {
        setTier('community');
        recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
        expect(shouldSpawnSync()).toBe(true);
        expect(await syncTelemetry()).toMatchObject({ status: 'sent', http: 200, events: 2 });
        expect(s.posts.length).toBe(1);
        expect((s.posts[0] as unknown[]).length).toBe(2);
        expect(queue()).toEqual([]);
        expect(readFileSync(join(telemetryDir(), 'sent.jsonl'), 'utf8')).toContain('"http":200');
        recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
        expect((await syncTelemetry()).status).toBe('too_soon');
        expect(shouldSpawnSync()).toBe(false);
      });
    } finally {
      s.stop();
    }
  });

  it('a 5xx, a 429 and no connection keep the batch; a 4xx three times drops it', async () => {
    const s = standIn([500, 429, 400, 400, 400]);
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: s.url }, async () => {
        setTier('anonymous');
        for (const want of ['kept', 'kept', 'kept', 'kept', 'dropped']) {
          expect((await syncTelemetry({ force: true })).status).toBe(want);
        }
        expect(queue()).toEqual([]);
      });
    } finally {
      s.stop();
    }
    await withEnv({ GBRAIN_TELEMETRY_URL: 'http://127.0.0.1:9' }, async () => {
      setTier('anonymous');
      expect((await syncTelemetry({ force: true })).status).toBe('kept');
      expect(queue().length).toBe(1);
      expect(telemetryStatus().last_status).toBe('offline');
    });
  });

  it('forget deletes the local id only after the server confirms, and works while forced off', async () => {
    setTier('community');
    const id = readSettings().installation_id;
    const failing = standIn([503], () => ({ error: 'forget_failed' }));
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: failing.url }, async () => {
        expect((await forgetInstallation()).status).toBe('failed');
        expect(readSettings().installation_id).toBe(id);
      });
    } finally {
      failing.stop();
    }
    const ok = standIn([200], () => ({ forgotten: true, events_cleared: 3 }));
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: ok.url, GBRAIN_TELEMETRY: 'off' }, async () => {
        expect(await forgetInstallation()).toEqual({ status: 'forgotten', http: 200, events_cleared: 3 });
        expect(ok.posts).toEqual([{ forget: id }]);
        expect(readSettings().installation_id).toBeUndefined();
        expect((await forgetInstallation()).status).toBe('no_id');
      });
    } finally {
      ok.stop();
    }
  });

  it('pulse: a stale or failed answer is never a healthy one', async () => {
    const cases: Array<[number, Record<string, unknown>, unknown]> = [
      [200, { status: 'ok', setup: [] }, { ok: true, stale: false, data: { status: 'ok', setup: [] } }],
      [200, { status: 'ok', stale: true, setup: [] }, { ok: true, stale: true, data: { status: 'ok', stale: true, setup: [] } }],
      [503, { error: 'pulse_unavailable' }, { ok: false, reason: 'unavailable', http: 503 }],
    ];
    for (const [status, body, want] of cases) {
      const s = standIn([status], () => body);
      try {
        await withEnv({ GBRAIN_TELEMETRY_URL: s.url }, async () => expect(await fetchPulse()).toEqual(want as never));
      } finally {
        s.stop();
      }
    }
  });
});
