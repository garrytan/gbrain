import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { telemetryEndpoint } from '../src/core/telemetry/endpoint.ts';
import {
  MAX_BATCH_BYTES, MAX_BATCH_EVENTS, buildBatch, countCommand, countCrash, countErrorCode, countOperation, deploymentOf, fetchPulse,
  flushCounts, forgetInstallation, heldEvents, noteRunVersion, readSettings, recordDoctor, recordEvent, sanitize, scoreBand, setTier, shouldSpawnSync,
  sizeBand, syncTelemetry, telemetryDir, telemetryStatus,
} from '../src/core/telemetry/client.ts';
import { telemetryAfterCli } from '../src/cli/telemetry-hook.ts';
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
        for (const want of ['kept', 'kept', 'kept', 'kept', 'dropped'] as const) {
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

/**
 * Coverage audit additions (gstack /ship Step 7).
 */
describe('gbrain telemetry client: queue bounds and locks', () => {
  // Value: protects=queued events expire after 30 days and the queue keeps at most 500; fails_when=the TTL filter or the 500 cap in recordEvent is removed; why_new=no test ages or overfills the queue; seam=none; no_claim=none beyond protects
  it('recording drops events older than 30 days and keeps at most 500', () => {
    setTier('anonymous');
    const p = join(telemetryDir(), 'events.jsonl');
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    const rows = [{ qid: 'old', ts: old, event_type: 'setup', gbrain_version: '0.1.0' }];
    for (let i = 0; i < 520; i++) rows.push({ qid: `f${i}`, ts: fresh, event_type: 'setup', gbrain_version: '0.1.0' });
    writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    recordEvent({ event_type: 'setup', outcome: 'success' });
    const q = queue();
    expect(q.length).toBe(500);
    expect(q.some(e => e.qid === 'old')).toBe(false);
    expect(q.at(-1).outcome).toBe('success');
  });

  // Value: protects=a stale queue.lock is broken and a live one makes recording skip without throwing; fails_when=stale-lock recovery or the never-throw guard breaks; why_new=no test holds the lock; seam=none; no_claim=no real cross-process race (one process, file lock simulated)
  it('a stale queue lock is broken; a fresh one skips the write without throwing', () => {
    setTier('anonymous');
    const lock = join(telemetryDir(), 'queue.lock');
    const before = queue().length;
    writeFileSync(lock, '');
    expect(() => recordEvent({ event_type: 'setup', outcome: 'success' })).not.toThrow();
    expect(queue().length).toBe(before);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    recordEvent({ event_type: 'setup', outcome: 'success' });
    expect(queue().length).toBe(before + 1);
    expect(existsSync(lock)).toBe(false);
  });

  // Value: protects=a community settings file without an id gets one minted at send time and sent; fails_when=the mint-on-sync branch in syncTelemetry is removed; why_new=setTier always mints, so this branch is untested; seam=none; no_claim=server acceptance (local stand-in)
  it('community without an install id mints one at sync and sends it', async () => {
    const s = standIn([200]);
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: s.url }, async () => {
        setTier('community');
        const p = join(telemetryDir(), 'settings.json');
        const { installation_id: _drop, ...rest } = readSettings();
        writeFileSync(p, JSON.stringify(rest));
        expect(await syncTelemetry({ force: true })).toMatchObject({ status: 'sent' });
        const id = readSettings().installation_id;
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect((s.posts[0] as Array<Record<string, unknown>>).every(e => e.installation_id === id)).toBe(true);
      });
    } finally {
      s.stop();
    }
  });

  // Value: protects=a failed upgrade records an upgrade error event and an unknown command records nothing; fails_when=the UPGRADE_COMMANDS branch or the known-command guard in telemetryAfterCli breaks; why_new=CLI tests cover setup only; seam=none; no_claim=no spawned child or real upgrade (direct call)
  it('the CLI seam records a failed upgrade and ignores unknown commands', () => {
    setTier('anonymous');
    const before = queue().length;
    telemetryAfterCli(0, undefined, ['zz-not-a-command']);
    expect(queue().length).toBe(before);
    expect(existsSync(join(telemetryDir(), 'counts'))).toBe(false);
    telemetryAfterCli(1, undefined, ['apply-migrations']);
    const up = queue().filter(e => e.event_type === 'upgrade');
    expect(up.length).toBe(1);
    expect(up[0]).toMatchObject({ outcome: 'error' });
    telemetryAfterCli(1, undefined, ['apply-migrations', '--dry-run']);
    expect(queue().filter(e => e.event_type === 'upgrade').length).toBe(1);
  });
});

/**
 * Pre-landing review fixes (gstack /ship Step 9, pass 1).
 */
describe('gbrain telemetry client: review fixes', () => {
  it('an older build running after a newer one records no upgrade and keeps the newer version', () => {
    setTier('anonymous');
    writeFileSync(join(telemetryDir(), 'settings.json'), JSON.stringify({ ...readSettings(), last_run_version: '999.0.0' }));
    noteRunVersion('stable');
    expect(queue().filter(e => e.event_type === 'upgrade')).toEqual([]);
    expect(readSettings().last_run_version).toBe('999.0.0');
  });

  it('a queue holding only expired data is cleared and stops asking for a send', async () => {
    const s = standIn([200]);
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: s.url }, async () => {
        setTier('anonymous');
        const old = new Date(Date.now() - 31 * 86_400_000);
        writeFileSync(join(telemetryDir(), 'events.jsonl'), `${JSON.stringify({ qid: 'old', ts: old.toISOString(), event_type: 'setup', gbrain_version: '0.1.0' })}\n`);
        const counts = join(telemetryDir(), 'counts');
        mkdirSync(counts, { recursive: true });
        writeFileSync(join(counts, `${old.toISOString().slice(0, 10)}.json`), JSON.stringify({ none: { command_counts: { doctor: 1 } } }));
        expect(shouldSpawnSync()).toBe(true);
        expect((await syncTelemetry({ force: true })).status).toBe('empty');
        expect(s.posts).toEqual([]);
        expect(shouldSpawnSync()).toBe(false);
      });
    } finally {
      s.stop();
    }
  });

  it('forget refuses while a send is in flight, and afterwards drops what was queued under the old id', async () => {
    const ok = standIn([200], () => ({ forgotten: true, events_cleared: 1 }));
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: ok.url }, async () => {
        setTier('community');
        countCommand('doctor');
        flushCounts();
        const lock = join(telemetryDir(), 'sync.lock');
        writeFileSync(lock, '');
        expect((await forgetInstallation()).status).toBe('busy');
        expect(ok.posts).toEqual([]);
        rmSync(lock);
        expect((await forgetInstallation()).status).toBe('forgotten');
        expect(queue()).toEqual([]);
        expect(existsSync(join(telemetryDir(), 'counts'))).toBe(false);
      });
    } finally {
      ok.stop();
    }
  });
});

describe('gbrain telemetry client: an opt-out is never undone', () => {
  it('a telemetry off written between the version check and the version write survives', () => {
    setTier('anonymous');
    writeFileSync(join(telemetryDir(), 'settings.json'), JSON.stringify({ ...readSettings(), last_run_version: '0.0.1' }));
    const realRead = fs.readFileSync;
    let reads = 0;
    let injected = false;
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const out = (realRead as (...a: unknown[]) => unknown)(path, ...rest);
      if (!injected && String(path).endsWith('settings.json') && ++reads === 2) {
        injected = true;
        setTier('off');
      }
      return out;
    }) as typeof fs.readFileSync);
    try {
      noteRunVersion('stable');
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(readSettings().tier).toBe('off');
    expect(queue()).toEqual([]);
  });

  it('a held queue lock makes the version note wait for the next run, and a telemetry off still lands', () => {
    setTier('anonymous');
    writeFileSync(join(telemetryDir(), 'settings.json'), JSON.stringify({ ...readSettings(), last_run_version: '0.0.1' }));
    const lock = join(telemetryDir(), 'queue.lock');
    writeFileSync(lock, '');
    try {
      noteRunVersion('stable');
      expect(readSettings().last_run_version).toBe('0.0.1');
      setTier('off');
      expect(readSettings().tier).toBe('off');
    } finally {
      rmSync(lock, { force: true });
    }
  });

  // Value: protects=a telemetry off that lands while a send mints the community install id stays off; fails_when=the id mint writes stale settings outside the settings lock; why_new=the version-note race test covers noteRunVersion only; seam=none; no_claim=no real cross-process race (the second settings read is where the other process's off is simulated)
  it('a telemetry off written while a send mints the community install id survives, and nothing is sent', async () => {
    const ok = standIn([200]);
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: ok.url }, async () => {
        setTier('community');
        recordEvent({ event_type: 'setup', outcome: 'success' });
        const { installation_id: _drop, ...rest } = readSettings();
        writeFileSync(join(telemetryDir(), 'settings.json'), JSON.stringify(rest));
        const realRead = fs.readFileSync;
        let reads = 0;
        let injected = false;
        const spy = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...more: unknown[]) => {
          const out = (realRead as (...a: unknown[]) => unknown)(path, ...more);
          if (!injected && String(path).endsWith('settings.json') && ++reads === 2) {
            injected = true;
            setTier('off');
          }
          return out;
        }) as typeof fs.readFileSync);
        try {
          await syncTelemetry({ force: true });
        } finally {
          spy.mockRestore();
        }
        expect(injected).toBe(true);
        expect(readSettings().tier).toBe('off');
        expect(ok.posts).toEqual([]);
      });
    } finally {
      ok.stop();
    }
  });
});

describe('gbrain telemetry client: before the person answers', () => {
  const held = () => (existsSync(join(telemetryDir(), 'pending.jsonl')) ? readFileSync(join(telemetryDir(), 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const home = () => mkdirSync(join(process.env.GBRAIN_HOME!, '.gbrain'), { recursive: true });

  it('setup and upgrade events wait in the pending file; counts, doctor and the queue stay empty', () => {
    home();
    recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
    recordEvent({ event_type: 'upgrade', from_version: '0.1.0', outcome: 'error' });
    recordDoctor({ score: 80, failing: [], pages: 5 });
    countCommand('query');
    flushCounts();
    expect(held().map(e => e.event_type)).toEqual(['setup', 'upgrade']);
    expect(readdirSync(telemetryDir()).sort()).toEqual(['pending.jsonl']);
    expect(buildBatch().events).toEqual([]);
    expect(telemetryStatus()).toMatchObject({ tier: 'off', answered: false, held_events: 2, queued_events: 0 });
  });

  it('with no gbrain home yet, nothing is held and no directory is created', () => {
    recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'error' });
    expect(existsSync(join(process.env.GBRAIN_HOME!, '.gbrain'))).toBe(false);
  });

  it('at most 50 events and 7 days are held', () => {
    home();
    const old = { qid: 'old', ts: new Date(Date.now() - 8 * 86_400_000).toISOString(), event_type: 'setup', gbrain_version: '0.1.0' };
    mkdirSync(telemetryDir(), { recursive: true });
    writeFileSync(join(telemetryDir(), 'pending.jsonl'), `${JSON.stringify(old)}\n`);
    for (let i = 0; i < 60; i++) recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
    const rows = held();
    expect(rows.length).toBe(50);
    expect(rows.some(e => e.qid === 'old')).toBe(false);
  });

  it('a yes moves the held events into the queue; they are then sent with the tier', () => {
    home();
    recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
    setTier('anonymous');
    expect(existsSync(join(telemetryDir(), 'pending.jsonl'))).toBe(false);
    expect(queue().map(e => e.event_type)).toEqual(['setup', 'consent']);
    expect(buildBatch().events.find(e => e.event_type === 'setup')).toMatchObject({ harness: 'codex', tier: 'anonymous' });
  });

  it('off deletes the held events, and nothing is held after an answer of off', () => {
    home();
    recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
    setTier('off');
    expect(existsSync(join(telemetryDir(), 'pending.jsonl'))).toBe(false);
    recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
    expect(held()).toEqual([]);
    expect(queue()).toEqual([]);
  });

  it('a pending file left behind after an answer is never listed as waiting', () => {
    home();
    setTier('off');
    const leftover = { qid: 'late', ts: new Date().toISOString(), event_type: 'setup', gbrain_version: '0.1.0' };
    writeFileSync(join(telemetryDir(), 'pending.jsonl'), `${JSON.stringify(leftover)}\n`);
    expect(heldEvents()).toEqual([]);
    expect(telemetryStatus().held_events).toBe(0);
  });

  it('GBRAIN_TELEMETRY=off holds nothing', async () => {
    home();
    await withEnv({ GBRAIN_TELEMETRY: 'off' }, () => {
      recordEvent({ event_type: 'setup', harness: 'codex', outcome: 'success' });
      expect(existsSync(telemetryDir())).toBe(false);
    });
  });

  // Value: protects=while unanswered the CLI seam holds a failed upgrade, but not a dry run or other commands' counts; fails_when=the waiting branch in telemetryAfterCli drops outcomes or counts commands; why_new=CLI test covers only init's held setup event; seam=none; no_claim=no spawned child or real upgrade (direct call)
  it('the CLI seam holds a failed upgrade and counts nothing else while unanswered', () => {
    home();
    telemetryAfterCli(0, undefined, ['query', 'x']);
    telemetryAfterCli(1, undefined, ['apply-migrations', '--dry-run']);
    expect(existsSync(telemetryDir())).toBe(false);
    telemetryAfterCli(1, undefined, ['apply-migrations']);
    expect(held().map(e => [e.event_type, e.outcome])).toEqual([['upgrade', 'error']]);
    expect(readdirSync(telemetryDir())).toEqual(['pending.jsonl']);
  });
});

describe('gbrain telemetry client: a consent change is final for what came before it', () => {
  const dir = (name: string) => join(telemetryDir(), name);
  const today = () => new Date().toISOString().slice(0, 10);

  it('telemetry off during an in-flight send leaves no queue and no record of the send behind', async () => {
    setTier('anonymous');
    recordEvent({ event_type: 'setup', outcome: 'success' });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let arrived!: () => void;
    const posted = new Promise<void>((r) => { arrived = r; });
    const server = Bun.serve({ port: 0, async fetch() { arrived(); await held; return Response.json({ accepted: 2, rejected: 0 }); } });
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: `http://127.0.0.1:${server.port}` }, async () => {
        const sending = syncTelemetry({ force: true });
        await posted;
        setTier('off');
        release();
        await sending;
        for (const f of ['events.jsonl', 'sent.jsonl', 'counts']) expect(existsSync(dir(f))).toBe(false);
      });
    } finally {
      server.stop(true);
    }
  });

  it('switching from anonymous to community sends nothing recorded under anonymous', () => {
    setTier('anonymous');
    recordEvent({ event_type: 'setup', outcome: 'success' });
    mkdirSync(dir('counts'), { recursive: true });
    writeFileSync(join(dir('counts'), `${yesterday()}.json`), JSON.stringify({ [`none|0.1.0.0|live`]: { command_counts: { doctor: 1 } } }));
    setTier('community');
    const events = buildBatch().events;
    expect(events.map(e => [e.event_type, e.answer])).toEqual([['consent', 'community']]);
  });

  it('forget deletes the record of past sends and drops counts taken before it', async () => {
    setTier('community');
    recordEvent({ event_type: 'setup', outcome: 'success' });
    const s = standIn([200], (path) => (path.endsWith('ingest') ? { accepted: 2, rejected: 0, forgotten: true, events_cleared: 2 } : {}));
    try {
      await withEnv({ GBRAIN_TELEMETRY_URL: s.url }, async () => {
        expect((await syncTelemetry({ force: true })).status).toBe('sent');
        expect(existsSync(dir('sent.jsonl'))).toBe(true);
        countCommand('doctor');
        expect((await forgetInstallation()).status).toBe('forgotten');
        flushCounts();
        expect(existsSync(dir('sent.jsonl'))).toBe(false);
        expect(existsSync(dir('counts'))).toBe(false);
      });
    } finally {
      s.stop();
    }
  });

  it('a daily rollup carries the build and traffic source that counted it, not the sender', () => {
    setTier('anonymous');
    mkdirSync(dir('counts'), { recursive: true });
    writeFileSync(join(dir('counts'), `${yesterday()}.json`), JSON.stringify({ [`none|0.1.0.0|test`]: { command_counts: { doctor: 2 } } }));
    const rollup = buildBatch().events.find(e => e.event_type === 'daily_rollup');
    expect(rollup).toMatchObject({ gbrain_version: '0.1.0.0', source: 'test', transport: 'none', command_counts: { doctor: 2 } });
  });

  it('the CLI seam reads the command after global flags and the setup harness after its value flags', () => {
    setTier('anonymous');
    telemetryAfterCli(0, undefined, ['--brain', 'sync', 'doctor']);
    const counts = JSON.parse(readFileSync(join(dir('counts'), `${today()}.json`), 'utf8')) as Record<string, { command_counts?: Record<string, number> }>;
    expect(Object.values(counts).map(b => b.command_counts)).toEqual([{ doctor: 1 }]);
    telemetryAfterCli(0, undefined, ['setup', '--workspace', '/tmp/w', 'claude-code']);
    expect(queue().filter(e => e.event_type === 'setup').map(e => e.harness)).toEqual(['claude_code']);
  });
});
