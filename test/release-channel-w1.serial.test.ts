/**
 * GBRA-224 W1: stable and alpha channels with stable as the default (client side).
 *
 * Covers: the evidence record and its generations, the typed stable codes in the background check (report only, never
 * an alpha fallback), the update cache partitioned by channel and evidence policy (legacy entries never read, the
 * warm-cache default flip, reversed refresh completion), never downgrading and the known_bad move, the per-channel
 * time-based snooze across alpha releases and a stable rollback, the one-time channel notice, and the check-only and
 * doctor surfaces. Every flow runs on a repo-less brain and on a repo brain: channel state is file-plane under
 * GBRAIN_HOME and never reads the repository.
 *
 * Serial: stubs globalThis.fetch and process-global env.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERSION } from '../src/version.ts';
import { parseSemver } from '../src/core/semver.ts';
import {
  STABLE_EVIDENCE_POLICY,
  offeredVersion,
  parseMarker,
  pendingUpgradeVersion,
  readSnooze,
  readUpdateCache,
  snoozeHolds,
  writeSnooze,
  writeUpdateCache,
} from '../src/core/self-upgrade.ts';
import { STABLE_RECORD_URL, fetchStableRecord, parseStableRecord, requiredEvidenceKeys, sanitizeCause } from '../src/core/stable-channel.ts';
import { refreshUpdateCache } from '../src/commands/check-update.ts';
import { runSelfUpgrade } from '../src/commands/self-upgrade.ts';
import { CHANNEL_NOTICE_TEXT, maybeEmitChannelNotice } from '../src/core/release-channel-notice.ts';
import { checkSelfUpgradeHealth } from '../src/commands/doctor/checks/upgrade-health.ts';

const v = parseSemver(VERSION)!;
const AHEAD = `${v[0]}.${v[1]}.${v[2] + 5}.0`;
const AHEAD2 = `${v[0]}.${v[1]}.${v[2] + 9}.0`;
const BEHIND = `${v[0]}.${v[1]}.${Math.max(0, v[2] - 5)}.0`;
const SOAK = 'https://github.com/garrytan/gbrain/actions/runs/42';
const MATRIX = 'https://github.com/garrytan/gbrain/actions/runs/43';
const record = (version: string, over: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, channel: 'stable', version, commit: 'a'.repeat(40), tree: 'b'.repeat(40), soak_run: SOAK, known_bad: [], ...over });

const realFetch = globalThis.fetch;
const realLog = console.log;
let home: string;
let saved: Record<string, string | undefined>;
let fetched: string[];

function serve(routes: { record?: string | null; recordStatus?: number; version?: string }): void {
  fetched = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    fetched.push(u);
    if (u === STABLE_RECORD_URL) {
      if (routes.record === null) throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
      return new Response(routes.record ?? 'Not Found', { status: routes.record === undefined ? 404 : routes.recordStatus ?? 200 });
    }
    if (u.endsWith('/latest-stable/VERSION')) return new Response(`${routes.version ?? AHEAD2}\n`);
    return new Response('', { status: 200 });
  }) as typeof fetch;
}

const dotG = () => join(home, '.gbrain');
function writeConfig(extra: Record<string, unknown> = {}, brain: 'repo-less' | 'repo' = 'repo-less'): void {
  mkdirSync(dotG(), { recursive: true });
  const base: Record<string, unknown> = { engine: 'pglite', database_path: join(home, 'brain.pglite') };
  if (brain === 'repo') {
    const repo = join(home, 'brain-repo');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', repo]);
    base.sync = { repo_path: repo };
  }
  writeFileSync(join(dotG(), 'config.json'), JSON.stringify({ ...base, ...extra }));
}

beforeEach(() => {
  saved = { GBRAIN_HOME: process.env.GBRAIN_HOME, GBRAIN_RELEASE_CHANNEL: process.env.GBRAIN_RELEASE_CHANNEL, GBRAIN_SELF_UPGRADE_MODE: process.env.GBRAIN_SELF_UPGRADE_MODE };
  home = mkdtempSync(join(tmpdir(), 'gbrain-w1-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_RELEASE_CHANNEL;
  delete process.env.GBRAIN_SELF_UPGRADE_MODE;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  for (const [k, val] of Object.entries(saved)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  rmSync(home, { recursive: true, force: true });
});

describe('evidence record generations', () => {
  test('generation 1 (soak only) is valid until the matrix cutover; from the cutover on matrix_run is required', () => {
    expect(STABLE_EVIDENCE_POLICY).toBe('stable-record-v1;matrix-from=none');
    expect(requiredEvidenceKeys('0.60.900.0')).toEqual(['soak_run']);
    expect(parseStableRecord(record('0.60.900.0'))).toMatchObject({ ok: true });
    const cut = '0.60.500.0';
    expect(requiredEvidenceKeys('0.60.499.0', cut)).toEqual(['soak_run']);
    expect(requiredEvidenceKeys('0.60.500.0', cut)).toEqual(['soak_run', 'matrix_run']);
    expect(parseStableRecord(record('0.60.499.0'), cut)).toMatchObject({ ok: true, record: { matrix_run: null } });
    expect(parseStableRecord(record('0.60.500.0'), cut)).toEqual({ ok: false, cause: 'the record for 0.60.500.0 lacks the evidence key matrix_run (a run of garrytan/gbrain)' });
    expect(parseStableRecord(record('0.60.501.0', { matrix_run: MATRIX }), cut)).toMatchObject({ ok: true, record: { matrix_run: MATRIX } });
  });

  test('a record is rejected for a missing or foreign soak run, bad commit or tree, bad known_bad, or listing itself as known_bad', () => {
    for (const over of [{ soak_run: undefined }, { soak_run: 'https://github.com/acme-example/gbrain/actions/runs/1' }, { commit: 'abc' }, { tree: undefined }, { known_bad: 'x' }, { known_bad: ['0.60.900.0'] }, { schema: 2 }]) {
      expect(parseStableRecord(record('0.60.900.0', over)).ok).toBe(false);
    }
    expect(parseStableRecord('not json')).toEqual({ ok: false, cause: 'the record is not JSON' });
  });

  test('fetch: 404 is stable_missing, other statuses and network failures stable_unreadable, a bad body stable_invalid; causes are sanitized', async () => {
    serve({});
    expect(await fetchStableRecord()).toMatchObject({ ok: false, code: 'stable_missing' });
    serve({ record: 'x', recordStatus: 500 });
    expect(await fetchStableRecord()).toMatchObject({ ok: false, code: 'stable_unreadable', cause: 'the stable record answered HTTP 500' });
    serve({ record: null });
    expect(await fetchStableRecord()).toMatchObject({ ok: false, code: 'stable_unreadable' });
    serve({ record: '{"schema":1}' });
    expect(await fetchStableRecord()).toMatchObject({ ok: false, code: 'stable_invalid' });
    expect(sanitizeCause('fetch https://user:hunter2@example.com/x failed\n token ghp_ABCDEFGHIJKLMNOP')).toBe('fetch https://example.com/x failed token [redacted]');
    expect(sanitizeCause('x'.repeat(500))).toHaveLength(200);
  });
});

for (const brain of ['repo-less', 'repo'] as const) {
  describe(`background check and cache (${brain} brain)`, () => {
    test('the default is stable: the check reads only the evidence record and writes the stable partition', async () => {
      writeConfig({}, brain);
      serve({ record: record(AHEAD) });
      await refreshUpdateCache();
      expect(fetched).toEqual([STABLE_RECORD_URL]);
      expect(readUpdateCache('stable')).toMatchObject({ channel: 'stable', policy: STABLE_EVIDENCE_POLICY, latest: AHEAD, marker: { kind: 'upgrade_available', latest: AHEAD }, error: null });
      expect(readUpdateCache('alpha')).toBeNull();
      expect(pendingUpgradeVersion(VERSION)).toBe(AHEAD);
    });

    test('missing, invalid and unreadable stable are recorded and reported, never offered and never replaced by alpha', async () => {
      writeConfig({}, brain);
      serve({ record: record(AHEAD) });
      await refreshUpdateCache();
      serve({ record: null });
      await refreshUpdateCache();
      expect(readUpdateCache('stable')).toMatchObject({ error: { code: 'stable_unreadable' }, marker: { latest: AHEAD } });
      serve({});
      await refreshUpdateCache();
      expect(readUpdateCache('stable')).toMatchObject({ error: { code: 'stable_missing' }, marker: null, latest: null });
      expect(pendingUpgradeVersion(VERSION)).toBeNull();
      serve({ record: record(AHEAD, { soak_run: undefined }) });
      await refreshUpdateCache();
      expect(readUpdateCache('stable')).toMatchObject({ error: { code: 'stable_invalid', cause: expect.stringContaining('soak_run') } });
      expect(fetched.some(u => u.includes('latest-stable'))).toBe(false);
      expect(readUpdateCache('alpha')).toBeNull();
    });

    test('warm-cache default flip: a legacy unpartitioned cache from the old latest default is never read', async () => {
      writeConfig({}, brain);
      writeFileSync(join(dotG(), 'last-update-check'), `UPGRADE_AVAILABLE ${VERSION} ${AHEAD2}\n`);
      writeFileSync(join(dotG(), 'update-snoozed'), `${AHEAD2} 1 ${Date.now()}\n`);
      expect(readUpdateCache()).toBeNull();
      expect(pendingUpgradeVersion(VERSION)).toBeNull();
      serve({ record: record(AHEAD) });
      await refreshUpdateCache();
      expect(pendingUpgradeVersion(VERSION)).toBe(AHEAD);
      expect(existsSync(join(dotG(), 'last-update-check'))).toBe(false);
    });

    test('partitions: switching channel reads that channel\'s answer; another policy\'s entry is invalid; an older refresh never overwrites a newer one', async () => {
      writeConfig({}, brain);
      writeUpdateCache({ kind: 'upgrade_available', current: VERSION, latest: AHEAD }, { channel: 'stable', checkedAt: 2_000 });
      writeUpdateCache({ kind: 'upgrade_available', current: VERSION, latest: AHEAD2 }, { channel: 'alpha', checkedAt: 2_000 });
      expect(pendingUpgradeVersion(VERSION)).toBe(AHEAD);
      process.env.GBRAIN_RELEASE_CHANNEL = 'latest';
      expect(pendingUpgradeVersion(VERSION)).toBe(AHEAD2);
      delete process.env.GBRAIN_RELEASE_CHANNEL;
      writeConfig({ self_upgrade: { channel: 'alpha' } }, brain);
      expect(pendingUpgradeVersion(VERSION)).toBe(AHEAD2);
      writeUpdateCache({ kind: 'up_to_date', current: VERSION }, { channel: 'alpha', checkedAt: 1_000 });
      expect(readUpdateCache('alpha')?.latest).toBe(AHEAD2);
      const path = join(dotG(), 'update-check.stable.json');
      writeFileSync(path, readFileSync(path, 'utf8').replace(STABLE_EVIDENCE_POLICY, 'stable-record-v1;matrix-from=0.60.1.0'));
      expect(readUpdateCache('stable')).toBeNull();
    });

    test('an invalid configured channel checks and offers nothing', async () => {
      writeConfig({ self_upgrade: { channel: 'nightly' } }, brain);
      writeUpdateCache({ kind: 'upgrade_available', current: VERSION, latest: AHEAD }, { channel: 'stable' });
      serve({ record: record(AHEAD2) });
      await refreshUpdateCache();
      expect(fetched).toEqual([]);
      expect(pendingUpgradeVersion(VERSION)).toBeNull();
    });

    test('never downgrade: an install ahead of stable is offered nothing until stable passes it; a withdrawn install is offered stable', async () => {
      writeConfig({}, brain);
      expect(offeredVersion(VERSION, BEHIND, [])).toBeNull();
      expect(offeredVersion(VERSION, VERSION, [VERSION])).toBeNull();
      expect(offeredVersion(VERSION, BEHIND, [VERSION])).toBe(BEHIND);
      serve({ record: record(BEHIND) });
      await refreshUpdateCache();
      expect(pendingUpgradeVersion(VERSION)).toBeNull();
      serve({ record: record(BEHIND, { known_bad: [VERSION] }) });
      await refreshUpdateCache();
      expect(readUpdateCache('stable')).toMatchObject({ latest: BEHIND, knownBad: [VERSION], marker: { kind: 'upgrade_available', latest: BEHIND } });
      expect(pendingUpgradeVersion(VERSION)).toBe(BEHIND);
    });

    test('snooze holds its full window across any number of alpha releases; a stable rollback below the snoozed version clears it', () => {
      writeConfig({}, brain);
      const now = Date.now();
      writeSnooze(AHEAD, now, 'alpha');
      for (let i = 1; i <= 30; i++) expect(snoozeHolds(`${v[0]}.${v[1]}.${v[2] + 5 + i}.0`, now + i * 3_600_000 * 0.7, 'alpha')).toBe(true);
      expect(snoozeHolds(AHEAD2, now + 25 * 3_600_000, 'alpha')).toBe(false);
      writeSnooze(AHEAD2, now, 'stable');
      expect(snoozeHolds(AHEAD2, now + 1000, 'stable')).toBe(true);
      expect(snoozeHolds(AHEAD, now + 2000, 'stable')).toBe(false);
      expect(readSnooze('stable')).toBeNull();
      expect(readSnooze('alpha')).not.toBeNull();
    });

    test('the one-time notice prints once per GBRAIN_HOME on stderr, never as a marker, never under --json or MCP, and not when a channel was chosen', () => {
      writeConfig({}, brain);
      const lines: string[] = [];
      const write = (l: string) => { lines.push(l); };
      expect(maybeEmitChannelNotice({ command: 'search', args: ['search', 'x', '--json'], cfg: null, write })).toBe(false);
      expect(maybeEmitChannelNotice({ command: 'serve', args: ['serve'], cfg: null, write })).toBe(false);
      expect(maybeEmitChannelNotice({ command: 'mcp', args: ['mcp'], cfg: null, write })).toBe(false);
      expect(maybeEmitChannelNotice({ command: 'search', args: ['search'], cfg: { self_upgrade: { channel: 'stable' } }, write })).toBe(false);
      expect(maybeEmitChannelNotice({ command: 'search', args: ['search'], cfg: null, env: 'alpha', write })).toBe(false);
      expect(lines).toEqual([]);
      expect(maybeEmitChannelNotice({ command: 'search', args: ['search'], cfg: null, write })).toBe(true);
      expect(maybeEmitChannelNotice({ command: 'query', args: ['query'], cfg: null, write })).toBe(false);
      expect(lines).toEqual([`${CHANNEL_NOTICE_TEXT}\n`]);
      expect(lines[0]).toStartWith('[gbrain notice release_channel] ');
      expect(lines[0]).toContain('stable channel');
      expect(lines[0]).toContain('gbrain config set self_upgrade.channel alpha');
      expect(parseMarker(lines[0]!)).toBeNull();
      expect(lines[0]).not.toContain('UPGRADE_AVAILABLE');
    });

    test('self-upgrade --check-only --json names the channel, its source and the typed error; --snooze writes the channel snooze', async () => {
      writeConfig({}, brain);
      const out: string[] = [];
      console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
      serve({});
      await runSelfUpgrade(['--check-only', '--json']);
      expect(JSON.parse(out.pop()!)).toMatchObject({ channel: 'stable', channel_source: 'default', update_available: false, error: { code: 'stable_missing', fix: expect.stringContaining('gbrain config set self_upgrade.channel alpha') } });
      serve({ record: record(BEHIND, { known_bad: [VERSION] }) });
      await runSelfUpgrade(['--check-only', '--json']);
      expect(JSON.parse(out.pop()!)).toMatchObject({ channel: 'stable', update_available: true, latest_version: BEHIND, withdrawn: true });
      serve({ record: record(AHEAD) });
      await runSelfUpgrade(['--check-only', '--json', '--channel', 'latest']);
      expect(JSON.parse(out.pop()!)).toMatchObject({ channel: 'alpha', channel_source: 'flag', latest_version: AHEAD2 });
      serve({ record: record(AHEAD) });
      await runSelfUpgrade(['--check-only', '--json']);
      await runSelfUpgrade(['--snooze', '--json']);
      expect(JSON.parse(out.pop()!)).toMatchObject({ snoozed: true, channel: 'stable', version: AHEAD, level: 1 });
      expect(readSnooze('stable')).toMatchObject({ version: AHEAD, level: 1 });
    });

    test('doctor names a channel that was set and its source (the default stays mode=notify), and warns with the code when stable failed', async () => {
      writeConfig({}, brain);
      expect(checkSelfUpgradeHealth().message).toBe('mode=notify');
      process.env.GBRAIN_RELEASE_CHANNEL = 'latest';
      expect(checkSelfUpgradeHealth().message).toContain('channel=alpha (env)');
      delete process.env.GBRAIN_RELEASE_CHANNEL;
      serve({});
      await refreshUpdateCache();
      const failing = checkSelfUpgradeHealth();
      expect(failing.status).toBe('warn');
      expect(failing.message).toContain('stable_missing');
      expect(failing.message).toContain('gbrain config set self_upgrade.channel alpha');
      writeConfig({ self_upgrade: { channel: 'nightly' } }, brain);
      expect(checkSelfUpgradeHealth()).toMatchObject({ status: 'warn', message: expect.stringContaining("self_upgrade.channel is 'nightly'") });
    });
  });
}
