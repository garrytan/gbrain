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
 * reads it without recording anything.
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
  BEHAVIOR_NOTICE_ID,
  BEHAVIOR_NOTICE_SINCE,
  HTTP_SHOWN_CAP,
  HTTP_SHOWN_KEY,
  __resetBehaviorNoticeForTests,
  behaviorBrainKey,
  recordHttpShown,
  takeHttpBehaviorNotice,
  takeLocalBehaviorNotice,
} from '../src/core/behavior-change-notice.ts';
import { checkBehaviorChanges } from '../src/commands/doctor/checks/behavior-changes.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
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
        expect(readFileSync(join(noticeDir(home), 'fresh.baseline'), 'utf8').trim()).toBe(BEHAVIOR_NOTICE_SINCE);
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
        expect((await checkBehaviorChanges(engine, { cfg: null, brainKey: 'doctor' })).details).toMatchObject({ shown: { cli: true, stdio: false } });
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
  test('keeps the newest HTTP_SHOWN_CAP clients and resets for a new notice id', () => {
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
