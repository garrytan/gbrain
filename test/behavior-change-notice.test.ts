/**
 * The one-time `behavior_changes` safety notice (fix wave lane B3, W-A3).
 *
 * Protects: an existing brain (recorded upgrade from an older release, an
 * older recorded baseline, or a brain created before the grace window with no
 * upgrade history) gets the disclosure once per notice × brain × channel, and
 * once per authenticated client over HTTP; a fresh install never does, even
 * after the grace window; markers survive a restart; a home that cannot be
 * written still delivers (once per process); concurrent processes deliver it
 * once; the chain section appears only when a chain is set, and the HTTP view
 * never names entries or providers; failed tool responses carry it; doctor
 * reads it without recording anything. The #6188 fence rows (inline
 * normalization, automatic repair) reach an upgraded brain with their opt-out
 * commands, the first-run sweep disclosure and undo guidance, and never a
 * fresh install.
 * Fails when: eligibility, marker identity, the HTTP per-client store, the
 * remote redaction or dispatch delivery regress.
 * Seams: per-test GBRAIN_HOME; `__resetBehaviorNoticeForTests` stands in for a
 * new process; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  BEHAVIOR_CHANGES,
  BEHAVIOR_NOTICE_ID,
  BEHAVIOR_NOTICE_SINCE,
  HTTP_SHOWN_CAP,
  HTTP_SHOWN_KEY,
  __resetBehaviorNoticeForTests,
  behaviorBrainKey,
  behaviorChangesNotice,
  compareReleases,
  recordHttpShown,
  takeHttpBehaviorNotice,
  takeLocalBehaviorNotice,
} from '../src/core/behavior-change-notice.ts';
import { VERSION } from '../src/version.ts';
import { checkBehaviorChanges } from '../src/commands/doctor/checks/behavior-changes.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

// Expectations derive from the BEHAVIOR_CHANGES table, so adding a release's
// rows does not require re-pinning every count; each release's own content is
// still asserted by text below.
const NEWEST = BEHAVIOR_NOTICE_SINCE;
const NEXT_PATCH = NEWEST.replace(/^(\d+\.\d+\.)(\d+)(.*)$/, (_m, a: string, b: string, c: string) => `${a}${Number(b) + 1}${c}`);
const NEWEST_TEXT = (BEHAVIOR_CHANGES.find(c => c.since === NEWEST && typeof c.text === 'string')!.text as string).slice(0, 48);
function noticeHeader(after: string, withChain = false): string {
  const rows = BEHAVIOR_CHANGES.filter(c => compareReleases(c.since, after) > 0 && (withChain || typeof c.text === 'string'));
  const releases = [...new Set(rows.map(c => `v${c.since}`))];
  const list = releases.length > 1 ? `${releases.slice(0, -1).join(', ')} and ${releases.at(-1)}` : releases[0];
  return `gbrain ${list} changed ${rows.length} behavior${rows.length === 1 ? '' : 's'}`;
}
import { NoticeLedger, __resetProcessNoticeLedgerForTests } from '../src/core/notice-ledger.ts';
import { _resetDbPlaneMergeMemoForTests } from '../src/core/config-db-merge.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DAY = 24 * 60 * 60 * 1000;
const NO_CHAIN = { GBRAIN_CHAT_FALLBACK_CHAIN: undefined, GBRAIN_CHAT_FALLBACK_ON_REFUSAL: undefined };
const freshHome = () => mkdtempSync(join(tmpdir(), 'gbrain-behavior-home-'));
const noticeDir = (home: string) => join(home, '.gbrain', 'notices', 'behavior-changes');
let seq = 0;
const config = (): GBrainConfig => ({ engine: 'pglite', database_path: join(tmpdir(), `behavior-brain-${process.pid}-${++seq}`) } as GBrainConfig);

async function setCreated(engine: BrainEngine, agoMs: number): Promise<void> {
  await engine.executeRaw(`UPDATE sources SET created_at = $1::timestamptz`, [new Date(Date.now() - agoMs).toISOString()]);
}

function noticeBlocks(res: { content: Array<{ text: string }> }): string[] {
  return res.content.map(c => c.text).filter(t => t.startsWith('[gbrain notice behavior_changes kind=safety]'));
}

for (const backend of testBackends()) {
  describe(`${backend}: behavior_changes notice`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engine = pg.engine;
        close = pg.close;
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      __resetBehaviorNoticeForTests();
      __resetProcessNoticeLedgerForTests();
      _resetDbPlaneMergeMemoForTests();
      await engine.unsetConfig(HTTP_SHOWN_KEY);
      await engine.unsetConfig('chat_fallback_chain');
      await setCreated(engine, 0);
    });

    test('a fresh install sees nothing, and stays fresh after the grace window', async () => {
      const home = freshHome();
      await withEnv({ GBRAIN_HOME: home, ...NO_CHAIN }, async () => {
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'fresh' })).toBeNull();
        expect(readFileSync(join(noticeDir(home), 'fresh.baseline'), 'utf8').trim()).toBe(VERSION);
        await setCreated(engine, 2 * DAY);
        __resetBehaviorNoticeForTests();
        expect(await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'fresh' })).toBeNull();
      });
    });

    test('an existing brain with no upgrade history sees it once per channel, and a restart does not repeat it', async () => {
      await setCreated(engine, 2 * DAY);
      await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
        const first = await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'old' });
        expect(first?.code).toBe('behavior_changes');
        expect(first?.kind).toBe('safety');
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'old' })).toBeNull();
        __resetBehaviorNoticeForTests();
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'old' })).toBeNull();
        expect((await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'old' }))?.code).toBe('behavior_changes');
        expect(await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'old' })).toBeNull();
      });
    });

    test('a skipped-release install still sees it: upgrade history from an older release, or an older recorded baseline', async () => {
      const home = freshHome();
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'upgrade-state.json'), JSON.stringify({ last_upgrade: { from: '0.50.0.0', to: '99.0.0.0' } }));
      await withEnv({ GBRAIN_HOME: home, ...NO_CHAIN }, async () => {
        expect((await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'upgraded' }))?.code).toBe('behavior_changes');
      });
      const baselineHome = freshHome();
      mkdirSync(noticeDir(baselineHome), { recursive: true });
      writeFileSync(join(noticeDir(baselineHome), 'older.baseline'), '0.59.0.0\n');
      writeFileSync(join(noticeDir(baselineHome), 'current.baseline'), `${BEHAVIOR_NOTICE_SINCE}\n`);
      await withEnv({ GBRAIN_HOME: baselineHome, ...NO_CHAIN }, async () => {
        expect((await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'older' }))?.code).toBe('behavior_changes');
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'current' })).toBeNull();
      });
    });

    test('each brain gets its own disclosure', async () => {
      await setCreated(engine, 2 * DAY);
      await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
        const a = behaviorBrainKey(config());
        const b = behaviorBrainKey(config());
        expect(a).not.toBe(b);
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: a })).not.toBeNull();
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: b })).not.toBeNull();
      });
    });

    test('the chain section appears only when a chain is set, with entries, providers and refusal behavior', async () => {
      await setCreated(engine, 2 * DAY);
      await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
        const plain = (await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'no-chain' }))!;
        expect(plain.why).not.toContain('chat_fallback_chain is live');
        expect(plain.why).toContain('cycle.lint_fix false');
        expect(plain.why).toContain('about 6.75x');
        expect(plain.why).toContain('mention linker');
        expect(plain.why).toContain('`setsid`');
        expect(plain.why).toContain('autopilot.auto_drain.enabled false');
        expect(plain.why).toContain('at most 90 days');
        expect(plain.why).toContain('local_process_ingress');
        expect(plain.why).toContain('exits 0 after a SIGTERM drain (was 143) and 17');
        expect(plain.why).toContain('gbrain sweep --once --budget-ms 600000');
        expect(plain.why).toContain('think.quote_verify false');
        expect(plain.why).toContain('decide.slots.conflict.review_withdraw false');
        expect(plain.why).toContain('no longer send text to an embedding provider');
        expect(plain.why).toContain('not a request for consent');
        expect(plain.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'behavior_changes', '--json']);
      });
      await withEnv({ GBRAIN_HOME: freshHome(), GBRAIN_CHAT_FALLBACK_CHAIN: 'openai:gpt-5.6-luna', GBRAIN_CHAT_FALLBACK_ON_REFUSAL: undefined, OPENAI_API_KEY: 'fake-openai' }, async () => {
        const chained = (await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'chain' }))!;
        expect(chained.why).toContain('chat_fallback_chain is live');
        expect(chained.why).toContain('openai:gpt-5.6-luna');
        expect(chained.why).toContain('so openai receive');
        expect(chained.why).toContain('on refusals as well as errors');
        expect(chained.fix?.argv).toEqual(['unset', 'GBRAIN_CHAT_FALLBACK_CHAIN']);
        expect(chained.fix?.actor).toBe('user');
      });
      await withEnv({ GBRAIN_HOME: freshHome(), GBRAIN_CHAT_FALLBACK_CHAIN: 'openai:gpt-5.6-luna', GBRAIN_CHAT_FALLBACK_ON_REFUSAL: 'false', OPENAI_API_KEY: 'fake-openai' }, async () => {
        expect((await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'chain-no-refusal' }))!.why).toContain('falls back on errors only');
      });
    });

    test('a home that cannot be written still gets the notice, once per process', async () => {
      await setCreated(engine, 2 * DAY);
      const blocker = join(freshHome(), 'not-a-dir');
      writeFileSync(blocker, 'x');
      await withEnv({ GBRAIN_HOME: join(blocker, 'home'), ...NO_CHAIN }, async () => {
        expect(await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'ro' })).not.toBeNull();
        expect(await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'ro' })).toBeNull();
        __resetBehaviorNoticeForTests();
        expect(await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'ro' })).not.toBeNull();
      });
    });

    test('HTTP: once per authenticated client, kept in the brain across restarts, never naming entries or providers', async () => {
      await setCreated(engine, 2 * DAY);
      await withEnv({ GBRAIN_HOME: freshHome(), GBRAIN_CHAT_FALLBACK_CHAIN: 'openai:gpt-5.6-luna', OPENAI_API_KEY: 'fake-openai' }, async () => {
        const a = await takeHttpBehaviorNotice(engine, 'client-a', { cfg: null, brainKey: 'http' });
        expect(a?.code).toBe('behavior_changes');
        expect(a!.why).toContain('A chat fallback chain is configured on this brain host');
        expect(a!.why).not.toContain('gpt-5.6-luna');
        expect(a!.why).not.toContain('openai');
        expect(a!.fix?.actor).toBe('host_admin');
        expect(await takeHttpBehaviorNotice(engine, 'client-a', { cfg: null, brainKey: 'http' })).toBeNull();
        expect(await takeHttpBehaviorNotice(engine, 'client-b', { cfg: null, brainKey: 'http' })).not.toBeNull();
        __resetBehaviorNoticeForTests();
        expect(await takeHttpBehaviorNotice(engine, 'client-a', { cfg: null, brainKey: 'http' })).toBeNull();
        expect(await takeHttpBehaviorNotice(engine, undefined, { cfg: null, brainKey: 'http' })).toBeNull();
        const stored = JSON.parse((await engine.getConfig(HTTP_SHOWN_KEY))!);
        expect(stored.id).toBe(BEHAVIOR_NOTICE_ID);
        expect(Object.keys(stored.clients).sort()).toEqual(['client-a', 'client-b']);
      });
    });

    test('HTTP: a store that cannot be written still delivers', async () => {
      await setCreated(engine, 2 * DAY);
      const readOnly = new Proxy(engine, {
        get(target, prop, receiver) {
          if (prop === 'setConfig') return async () => { throw new Error('read-only brain'); };
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
        expect(await takeHttpBehaviorNotice(readOnly, 'client-ro', { cfg: null, brainKey: 'http-ro' })).not.toBeNull();
      });
    });

    test('doctor shows the disclosure and records nothing', async () => {
      await setCreated(engine, 2 * DAY);
      const home = freshHome();
      await withEnv({ GBRAIN_HOME: home, ...NO_CHAIN }, async () => {
        const c = await checkBehaviorChanges(engine, { cfg: null, brainKey: 'doctor' });
        expect(c.status).toBe('ok');
        expect(c.message).toContain('one-time disclosure');
        expect(c.details).toMatchObject({ shown: { cli: false, stdio: false } });
        expect(existsSync(noticeDir(home))).toBe(false);
        expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'doctor' })).not.toBeNull();
        const again = await checkBehaviorChanges(engine, { cfg: null, brainKey: 'doctor' });
        expect(again.details).toMatchObject({ shown: { cli: true, stdio: false } });
        expect(again.message).toContain(noticeHeader('0'));
      });
    });

    test('stdio dispatch: the first tool result carries it, later ones do not, and a failed first call carries it too', async () => {
      await setCreated(engine, 2 * DAY);
      await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
        const cfg = config();
        const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', config: cfg };
        const first = await dispatchToolCall(engine as never, 'list_pages', {}, opts);
        expect(noticeBlocks(first)).toHaveLength(1);
        const second = await dispatchToolCall(engine as never, 'list_pages', {}, opts);
        expect(noticeBlocks(second)).toHaveLength(0);

        __resetProcessNoticeLedgerForTests();
        const failCfg = config();
        const failed = await dispatchToolCall(engine as never, 'get_page', { slug: 'missing/acme-example' }, { ...opts, config: failCfg });
        expect(failed.isError).toBe(true);
        const envelope = JSON.parse(failed.content[0]!.text) as { notices?: Array<{ code: string }> };
        expect(envelope.notices?.map(n => n.code)).toContain('behavior_changes');
        const after = await dispatchToolCall(engine as never, 'list_pages', {}, { ...opts, config: failCfg });
        expect(noticeBlocks(after)).toHaveLength(0);
      });
    }, 60_000);

    test('HTTP dispatch: each client gets it on its first tool result', async () => {
      await setCreated(engine, 2 * DAY);
      await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
        const cfg = config();
        const ledger = new NoticeLedger();
        const httpOpts = (clientId: string) => ({ remote: true, transport: 'http' as const, sourceId: 'default', config: cfg, noticeLedger: ledger,
          auth: { token: 't', clientId, clientName: clientId, scopes: ['read'], expiresAt: Date.now() / 1000 + 3600 } as never });
        expect(noticeBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, httpOpts('http-a')))).toHaveLength(1);
        expect(noticeBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, httpOpts('http-a')))).toHaveLength(0);
        expect(noticeBlocks(await dispatchToolCall(engine as never, 'list_pages', {}, httpOpts('http-b')))).toHaveLength(1);
      });
    }, 60_000);
  });
}

describe('HTTP per-client store', () => {
  test('keeps the newest HTTP_SHOWN_CAP clients', () => {
    let raw: string | null = JSON.stringify({ id: 'behavior_changes@0.0.1', clients: { stale: '2020-01-01T00:00:00.000Z' } });
    for (let i = 0; i < HTTP_SHOWN_CAP + 25; i++) raw = recordHttpShown(raw, `client-${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
    const stored = JSON.parse(raw!) as { id: string; clients: Record<string, string> };
    expect(stored.id).toBe(BEHAVIOR_NOTICE_ID);
    expect(Object.keys(stored.clients)).toHaveLength(HTTP_SHOWN_CAP);
    expect(stored.clients.stale).toBeUndefined();
    expect(stored.clients['client-0']).toBeUndefined();
    expect(stored.clients[`client-${HTTP_SHOWN_CAP + 24}`]).toBeDefined();
  });
});

describe('per-release content', () => {
  test('a client from an older build\'s row keeps the release it was shown', () => {
    const raw = recordHttpShown(JSON.stringify({ id: 'behavior_changes@0.60.68.0', clients: { old: '2026-10-05T00:00:00.000Z' } }), 'new', '2026-10-06T00:00:00.000Z');
    const stored = JSON.parse(raw) as { id: string; clients: Record<string, { since: string; at: string }> };
    expect(stored.id).toBe(BEHAVIOR_NOTICE_ID);
    expect(stored.clients.old).toEqual({ since: '0.60.68.0', at: '2026-10-05T00:00:00.000Z' });
    expect(stored.clients.new).toEqual({ since: BEHAVIOR_NOTICE_SINCE, at: '2026-10-06T00:00:00.000Z' });
  });

  test('the notice id is the newest change\'s release, and only newer changes are listed', () => {
    expect(BEHAVIOR_NOTICE_SINCE).toBe(BEHAVIOR_CHANGES.map(c => c.since).sort(compareReleases).at(-1)!);
    expect(BEHAVIOR_NOTICE_ID).toBe(`behavior_changes@${BEHAVIOR_NOTICE_SINCE}`);
    expect(behaviorChangesNotice(null, { after: BEHAVIOR_NOTICE_SINCE })).toBeNull();
    const chain = { plane: 'env' as const, entries: ['openai:gpt-5.6-luna'], providers: ['openai'], onRefusal: true, filePath: '' };
    const later = behaviorChangesNotice(chain, { after: '0.60.68.0' })!;
    expect(later.why).not.toContain('chat_fallback_chain is live');
    expect(later.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'behavior_changes', '--json']);
    const all = behaviorChangesNotice(chain)!;
    expect(all.why).toContain(noticeHeader('0', true));
    expect(all.fix?.argv).toEqual(['unset', 'GBRAIN_CHAT_FALLBACK_CHAIN']);
  });
});

describe('concurrent initializations', () => {
  test('processes racing on one brain and channel deliver it exactly once', async () => {
    const home = freshHome();
    const script = join(home, 'race.ts');
    const modulePath = join(import.meta.dir, '..', 'src', 'core', 'behavior-change-notice.ts');
    writeFileSync(script, `
      const { takeLocalBehaviorNotice } = await import(${JSON.stringify(modulePath)});
      const old = new Date(Date.now() - 3 * 86400000).toISOString();
      const engine = { executeRaw: async () => [{ at: old }], getConfig: async () => null };
      const n = await takeLocalBehaviorNotice(engine, 'stdio', { cfg: null, brainKey: 'race' });
      console.log(JSON.stringify({ delivered: n !== null }));
    `);
    const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_CHAT_FALLBACK_CHAIN: '' } as Record<string, string>;
    const procs = Array.from({ length: 6 }, () => Bun.spawn(['bun', script], { env, stdout: 'pipe', stderr: 'pipe' }));
    const outs = await Promise.all(procs.map(async p => { await p.exited; return new Response(p.stdout).text(); }));
    const delivered = outs.map(o => JSON.parse(o.trim().split('\n').pop()!).delivered as boolean);
    expect(delivered.filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(noticeDir(home), 'race.baseline'), 'utf8').trim()).toBe('0');
  }, 60_000);
});

describe('upgrades across releases (each step a new process pinned to a gbrain VERSION)', () => {
  const modulePath = join(import.meta.dir, '..', 'src', 'core', 'behavior-change-notice.ts');
  const WAVE9 = '`setsid`';
  const OPT_OUT = 'no longer send text to an embedding provider';
  const V68 = 'cycle.lint_fix false';

  /** One gbrain process at `version`: takes the notice on `channel` (`http:<client>` for an HTTP client) for brain `key`. */
  async function runAt(home: string, version: string, key: string, channel: string, opts: { createdAgoMs?: number } = {}): Promise<string | null> {
    const script = join(home, `step-${++seq}.ts`);
    writeFileSync(script, `
      Bun.plugin({ setup(b) { b.onLoad({ filter: /[\\\\/]src[\\\\/]version\\.ts$/ }, () => ({ contents: ${JSON.stringify(`export const VERSION = '${version}';`)}, loader: 'ts' })); } });
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
      const { takeLocalBehaviorNotice, takeHttpBehaviorNotice } = await import(${JSON.stringify(modulePath)});
      const storePath = ${JSON.stringify(join(home, 'brain-config.json'))};
      const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
      const created = new Date(Date.now() - ${opts.createdAgoMs ?? 3 * DAY}).toISOString();
      const engine = {
        executeRaw: async () => [{ at: created }],
        getConfig: async (k) => store[k] ?? null,
        setConfig: async (k, v) => { store[k] = v; writeFileSync(storePath, JSON.stringify(store)); },
      };
      const channel = ${JSON.stringify(channel)};
      const n = channel.startsWith('http:')
        ? await takeHttpBehaviorNotice(engine, channel.slice(5), { cfg: null, brainKey: ${JSON.stringify(key)} })
        : await takeLocalBehaviorNotice(engine, channel, { cfg: null, brainKey: ${JSON.stringify(key)} });
      console.log(JSON.stringify({ why: n?.why ?? null }));
    `);
    const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_CHAT_FALLBACK_CHAIN: '' } as Record<string, string>;
    const p = Bun.spawn(['bun', script], { env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const last = out.trim().split('\n').pop();
    if (!last) throw new Error(`step at ${version} printed nothing: ${err}`);
    return JSON.parse(last).why as string | null;
  }

  test('a brain that saw the notice gets nothing from a later release that adds no behavior changes', async () => {
    const home = freshHome();
    for (const channel of ['cli', 'http:client-a']) {
      expect(await runAt(home, NEWEST, 'seen', channel)).toContain(NEWEST_TEXT);
      expect(await runAt(home, NEWEST, 'seen', channel)).toBeNull();
      expect(await runAt(home, '0.60.99.0', 'seen', channel)).toBeNull();
    }
  }, 60_000);

  test('a brain at baseline 0.60.68 that saw the 0.60.68 notice sees only the later items, once', async () => {
    const home = freshHome();
    mkdirSync(noticeDir(home), { recursive: true });
    writeFileSync(join(noticeDir(home), 'b68.baseline'), '0.60.68.0\n');
    writeFileSync(join(noticeDir(home), 'behavior_changes_0.60.68.0.b68.cli.shown'), '2026-10-05T00:00:00.000Z\n');
    writeFileSync(join(home, 'brain-config.json'), JSON.stringify({ [HTTP_SHOWN_KEY]: JSON.stringify({ id: 'behavior_changes@0.60.68.0', clients: { 'client-a': '2026-10-05T00:00:00.000Z' } }) }));
    for (const channel of ['cli', 'http:client-a']) {
      const why = await runAt(home, NEWEST, 'b68', channel);
      expect(why).toContain(noticeHeader('0.60.68.0'));
      expect(why).toContain(WAVE9);
      expect(why).toContain(OPT_OUT);
      expect(why).not.toContain(V68);
      expect(why).not.toContain('v0.60.68.0');
      expect(await runAt(home, NEWEST, 'b68', channel)).toBeNull();
      expect(await runAt(home, NEXT_PATCH, 'b68', channel)).toBeNull();
    }
  }, 60_000);

  test('a brain older than 0.60.68 sees every item, labeled with its release, once', async () => {
    const home = freshHome();
    for (const channel of ['cli', 'stdio', 'http:client-a']) {
      const why = await runAt(home, NEWEST, 'old', channel);
      expect(why).toContain(noticeHeader('0'));
      expect(why).toContain(`v0.60.68.0: (1) On a managed brain`);
      expect(why).toContain(`v0.60.74.0: (4) A shell job`);
      expect(why).toContain(`v0.60.77.0: (10) think answers`);
      expect(why).toContain(`v0.60.78.0: (12) On a brain with embedding turned off`);
      expect(why).toContain(`v0.60.79.0: (13) Frontmatter is parsed as YAML 1.2`);
      expect(await runAt(home, NEWEST, 'old', channel)).toBeNull();
      expect(await runAt(home, '0.60.99.0', 'old', channel)).toBeNull();
    }
    expect(readFileSync(join(noticeDir(home), 'old.baseline'), 'utf8').trim()).toBe('0');
  }, 60_000);

  test('a fresh brain sees nothing, then or after later upgrades', async () => {
    const home = freshHome();
    for (const channel of ['cli', 'http:client-a']) {
      expect(await runAt(home, NEWEST, 'new', channel, { createdAgoMs: 0 })).toBeNull();
      expect(await runAt(home, '0.60.99.0', 'new', channel, { createdAgoMs: 2 * DAY })).toBeNull();
    }
    expect(readFileSync(join(noticeDir(home), 'new.baseline'), 'utf8').trim()).toBe(NEWEST);
  }, 60_000);
});

describe('fence rows (#6188 D25, D26)', () => {
  const NORMALIZE = 'Fixable facts and takes fences are now rewritten instead of held or refused';
  const REPAIR = 'Malformed facts and takes fences are now repaired automatically';
  const fenceRows = BEHAVIOR_CHANGES.filter(c => typeof c.text === 'string' && (c.text.startsWith(NORMALIZE) || c.text.startsWith(REPAIR)));
  const earliest = fenceRows.map(c => c.since).sort(compareReleases)[0]!;
  const before = BEHAVIOR_CHANGES.map(c => c.since).filter(v => compareReleases(v, earliest) < 0).sort(compareReleases).at(-1)!;
  const freshEngine = (createdAt: string) => ({ executeRaw: async () => [{ at: createdAt }], getConfig: async () => null }) as unknown as BrainEngine;

  test('an upgraded brain sees the never-block row and the automatic repair row, each with its opt-out, the sweep disclosure and undo guidance', async () => {
    expect(fenceRows.length).toBe(2);
    const home = freshHome();
    mkdirSync(noticeDir(home), { recursive: true });
    writeFileSync(join(noticeDir(home), 'upgraded.baseline'), `${before}\n`);
    __resetBehaviorNoticeForTests();
    await withEnv({ GBRAIN_HOME: home, ...NO_CHAIN }, async () => {
      const why = (await takeLocalBehaviorNotice(freshEngine(new Date().toISOString()), 'cli', { cfg: null, brainKey: 'upgraded' }))?.why ?? '';
      expect(why).toContain(NORMALIZE);
      expect(why).toContain(REPAIR);
      for (const command of ['gbrain config set fences.normalize false', 'gbrain config set fences.repair.llm false', 'gbrain config set fences.repair.enabled false']) {
        expect(why).toContain(command);
      }
      expect(why).toContain('its first run after upgrading repairs every malformed fence it finds in each source, rewriting and committing those files');
      expect(why).toContain('gbrain doctor --only fence_integrity');
      expect(why).toContain('`git revert` undoes it');
      expect(why).toContain('turning these settings off stops future repairs and does not undo past ones');
    });
  });

  test('a fresh install sees neither row', async () => {
    __resetBehaviorNoticeForTests();
    await withEnv({ GBRAIN_HOME: freshHome(), ...NO_CHAIN }, async () => {
      expect(await takeLocalBehaviorNotice(freshEngine(new Date().toISOString()), 'cli', { cfg: null, brainKey: 'fresh-fences' })).toBeNull();
    });
  });
});
