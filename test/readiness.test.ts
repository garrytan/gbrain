/**
 * A7 readiness (src/core/readiness.ts): the config-plane state/reason table per
 * capability, the one embedding-enablement fix, harness_wiring by state, the
 * exclusive two-step plan and the HTTP view.
 *
 * Protects: every surface (doctor, MCP initialize, whoami, receipts) reads one
 * answer for "what can this install do and what is the fix". A regression that
 * coaches a keyless-by-choice brain, routes an exclusive fix past a running
 * serve, registers a bare `gbrain` binary or reintroduces a wipe recipe fails here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  BACKUP_REASONS, CHAT_LLM_REASONS, EMBEDDINGS_REASONS, HARNESS_WIRING_REASONS, MIGRATIONS_REASONS, SYNC_REASONS,
  TOOL_SURFACE_REASONS, WORKER_REASONS, WRITEBACK_REASONS,
  __setLockPeekForTests, configReadiness, embeddingEnablement, exclusiveFix, harnessWiringEntry, readinessHttpView,
  type LockOwner, type ReadinessEntry,
} from '../src/core/readiness.ts';
import { renderAction, cliRenderContext, type Action } from '../src/core/agent-output.ts';
import { listRecipes } from '../src/core/ai/recipes/index.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const PROVIDER_ENVS = [...new Set(listRecipes().flatMap(r => r.auth_env?.required ?? []))];

/** Run with every provider key cleared, then `keys` set (no ambient key can leak into a pick). */
function withKeys<T>(keys: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const env: Record<string, string | undefined> = { GBRAIN_MODEL: undefined, GBRAIN_BRAIN_ID: undefined };
  for (const k of PROVIDER_ENVS) env[k] = undefined;
  return withEnv({ ...env, ...keys }, async () => fn());
}

const VOCAB: Record<string, readonly string[]> = {
  embeddings: EMBEDDINGS_REASONS, chat_llm: CHAT_LLM_REASONS, worker: WORKER_REASONS, writeback: WRITEBACK_REASONS,
  backup: BACKUP_REASONS, tool_surface: TOOL_SURFACE_REASONS, sync: SYNC_REASONS, migrations: MIGRATIONS_REASONS,
  harness_wiring: HARNESS_WIRING_REASONS,
};

function entry(entries: ReadinessEntry[], capability: string): ReadinessEntry {
  const found = entries.find(e => e.capability === capability);
  if (!found) throw new Error(`no ${capability} entry`);
  return found;
}

function pglite(extra: Partial<GBrainConfig> = {}): GBrainConfig {
  return { engine: 'pglite', database_path: '/brains/main.pglite', ...extra } as GBrainConfig;
}

afterEach(() => __setLockPeekForTests(null));

describe('config plane: state and reason per capability', () => {
  test('keyless-by-choice brain: embeddings disabled_by_choice, still carrying the enable fix', async () => {
    await withKeys({}, () => {
      __setLockPeekForTests(() => ({ held: false }));
      const { entries } = configReadiness(pglite({ embedding_disabled: true }), { transport: 'cli' });
      const e = entry(entries, 'embeddings');
      expect(e.state).toBe('disabled_by_choice');
      expect(e.reason).toBe('embedding_disabled');
      expect(e.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'init', '--force', '--embedding-model']);
    });
  });

  test('every entry uses its capability\'s closed vocabulary and declares requires_exclusive on fixes', async () => {
    await withKeys({}, () => {
      __setLockPeekForTests(() => ({ held: false }));
      const cfgs = [pglite({ embedding_disabled: true }), pglite(), pglite({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 }),
        pglite({ embedding_model: 'nope:model' }), pglite({ memory: { auto_writeback: 'off' } }), pglite({ memory: { auto_writeback: 'bogus' } }),
        pglite({ mcp_surface: 'verbs' }), { engine: 'postgres', database_url: 'postgres://x/y', remote_mcp: { mcp_url: 'https://h/mcp' } } as unknown as GBrainConfig];
      for (const cfg of cfgs) {
        for (const transport of ['cli', 'stdio'] as const) {
          for (const e of configReadiness(cfg, { transport }).entries) {
            expect(VOCAB[e.capability]).toContain(e.reason);
            expect(e.tier).toBe('config');
            if (e.fix) expect(typeof e.fix.requires_exclusive).toBe('boolean');
          }
        }
      }
    });
  });

  test('embeddings: not_configured, key_missing, unknown_model, ok', async () => {
    await withKeys({}, () => {
      expect(entry(configReadiness(pglite(), { transport: 'stdio' }).entries, 'embeddings')).toMatchObject({ state: 'missing', reason: 'not_configured' });
      const keyless = entry(configReadiness(pglite({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 }), { transport: 'stdio' }).entries, 'embeddings');
      expect(keyless).toMatchObject({ state: 'degraded', reason: 'key_missing' });
      expect(keyless.fix).toMatchObject({ actor: 'user', consent: ['credentials'] });
      expect(keyless.fix?.inputs?.[0]?.name).toBe('OPENAI_API_KEY');
      expect(entry(configReadiness(pglite({ embedding_model: 'nope:model' }), { transport: 'stdio' }).entries, 'embeddings').reason).toBe('unknown_model');
    });
    await withKeys({ OPENAI_API_KEY: 'sk-test' }, () => {
      expect(entry(configReadiness(pglite({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 }), { transport: 'stdio' }).entries, 'embeddings'))
        .toMatchObject({ state: 'ok', reason: 'configured' });
    });
  });

  test('chat, writeback, tool surface and thin-client rows', async () => {
    await withKeys({}, () => {
      const entries = configReadiness(pglite({ mcp_surface: 'verbs', memory: { auto_writeback: 'off' } }), { transport: 'stdio' }).entries;
      expect(entry(entries, 'chat_llm')).toMatchObject({ state: 'missing', reason: 'not_configured' });
      expect(entry(entries, 'writeback')).toMatchObject({ state: 'disabled_by_choice', reason: 'off_by_choice' });
      expect(entry(entries, 'tool_surface')).toMatchObject({ state: 'ok', reason: 'surface_verbs' });
      expect(entry(configReadiness(pglite(), { transport: 'stdio' }).entries, 'writeback')).toMatchObject({ state: 'missing', reason: 'not_configured' });
      const thin = configReadiness({ engine: 'postgres', remote_mcp: { mcp_url: 'https://h/mcp' } } as unknown as GBrainConfig, { transport: 'cli' });
      for (const cap of ['embeddings', 'chat_llm', 'writeback', 'sync']) expect(entry(thin.entries, cap).state).toBe('not_applicable');
      expect(thin.lock_owner).toBeNull();
    });
    await withKeys({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () => {
      expect(entry(configReadiness(pglite(), { transport: 'stdio' }).entries, 'chat_llm')).toMatchObject({ state: 'ok', reason: 'configured' });
    });
  });
});

describe('embeddingEnablement', () => {
  const run = (cfg: GBrainConfig, keys: Record<string, string>, env: Record<string, string> = {}) =>
    withKeys({ ...keys, ...env }, () => embeddingEnablement(cfg));

  test('default path: keyed provider, in-place init with the resolved datastore and width', async () => {
    const a = await run({ engine: 'pglite', embedding_disabled: true } as GBrainConfig, { VOYAGE_API_KEY: 'v' }, { GBRAIN_HOME: '/home/u' });
    expect(a.argv).toEqual(['gbrain', 'init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024', '--path', '/home/u/.gbrain/brain.pglite']);
    expect(a).toMatchObject({ actor: 'agent', consent: ['credentials', 'paid'], requires_exclusive: true });
    expect(a.why).toContain('Pages, facts and keyword search are kept');
    expect(a.why).toContain('queued for vectors');
    expect(a.argv?.join(' ')).not.toContain('mv ');
  });

  test('custom path and Postgres target their own datastore', async () => {
    expect((await run(pglite({ embedding_disabled: true }), { VOYAGE_API_KEY: 'v' })).argv?.slice(-2)).toEqual(['--path', '/brains/main.pglite']);
    const pg = await run({ engine: 'postgres', database_url: 'postgres://x/y', embedding_disabled: true } as GBrainConfig, { VOYAGE_API_KEY: 'v' });
    expect(pg.argv).toEqual(['gbrain', 'init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024']);
  });

  test('mounted brain routes through `embeddings enable --brain`, never init --path', async () => {
    const a = await run(pglite({ embedding_disabled: true }), { VOYAGE_API_KEY: 'v' }, { GBRAIN_BRAIN_ID: 'team' });
    expect(a.argv).toEqual(['gbrain', 'embeddings', 'enable', '--brain', 'team', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024']);
  });

  test('multiple providers: the canonical default wins; legacy width picks a provider that fits', async () => {
    expect((await run(pglite({ embedding_disabled: true }), { VOYAGE_API_KEY: 'v', OPENAI_API_KEY: 'o' })).argv?.[4]).toBe('voyage:voyage-4');
    const legacy = await run(pglite({ embedding_disabled: true, embedding_dimensions: 1536 }), { VOYAGE_API_KEY: 'v', OPENAI_API_KEY: 'o' });
    expect(legacy.argv?.[4]).toMatch(/^openai:/);
    expect(legacy.argv?.slice(5, 7)).toEqual(['--embedding-dimensions', '1536']);
  });

  test('no key: the fix asks the user for one (actor user, credentials+paid, inputs)', async () => {
    const a = await run(pglite({ embedding_disabled: true }), {});
    expect(a).toMatchObject({ actor: 'user', consent: ['credentials', 'paid'], requires_exclusive: true });
    expect(a.inputs?.map(i => i.name)).toEqual(['VOYAGE_API_KEY']);
    expect(renderAction(a, cliRenderContext()).next).toBe('tell_user_to_run');
  });

  test('width mismatch refuses to rebuild: names a provider that fits instead', async () => {
    const a = await run(pglite({ embedding_disabled: true, embedding_dimensions: 1536 }), { VOYAGE_API_KEY: 'v' });
    expect(a.actor).toBe('user');
    expect(a.inputs?.map(i => i.name)).toEqual(['OPENAI_API_KEY']);
    expect(a.why).toContain('cannot produce');
    const none = await run(pglite({ embedding_disabled: true, embedding_dimensions: 7 }), { VOYAGE_API_KEY: 'v' });
    expect(none.argv).toEqual(['gbrain', 'migrate', 'embeddings', '--status', '--json']);
    expect(none.requires_exclusive).toBe(false);
  });

  test('an explicitly requested model is honoured', async () => {
    const a = await run(pglite({ embedding_disabled: true, embedding_model: 'openai:text-embedding-3-small' }), { VOYAGE_API_KEY: 'v' });
    expect(a.argv?.[4]).toBe('openai:text-embedding-3-small');
    expect(a.inputs?.map(i => i.name)).toEqual(['OPENAI_API_KEY']);
  });
});

describe('harness_wiring by state', () => {
  const BIN = '/opt/gbrain/bin/gbrain';
  const owner = (transport: 'stdio' | 'http', is_self = false): LockOwner => ({ pid: 4242, transport, is_self });

  test('one harness, no serve: harness-native stdio registration with the absolute binary and --surface full', () => {
    const claude = harnessWiringEntry({ transport: 'cli', harnesses: ['claude-code'], lockOwner: null, gbrainBin: BIN });
    expect(claude.fix?.argv).toEqual(['claude', 'mcp', 'add', 'gbrain', '--', BIN, 'serve', '--surface', 'full']);
    expect(claude.fix?.consent).toEqual(['persistent_install']);
    expect(claude.fix?.why).toContain('~/.claude.json');
    expect(harnessWiringEntry({ transport: 'cli', harnesses: ['codex'], lockOwner: null, gbrainBin: BIN }).fix?.argv)
      .toEqual(['codex', 'mcp', 'add', 'gbrain', '--', BIN, 'serve', '--surface', 'full']);
    expect(harnessWiringEntry({ transport: 'cli', harnesses: ['opencode'], lockOwner: null, gbrainBin: BIN }).fix?.argv)
      .toEqual(['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--no-hooks']);
  });

  test('never a bare gbrain binary: unresolved binary yields no registration', () => {
    const e = harnessWiringEntry({ transport: 'cli', harnesses: ['claude-code'], lockOwner: null, gbrainBin: null });
    expect(e.reason).toBe('binary_unresolved');
    expect(e.fix?.argv).toBeUndefined();
  });

  test('serve --http running or a second session: shared HTTP wiring, credentials disclosed', () => {
    const http = harnessWiringEntry({ transport: 'cli', harnesses: ['codex'], lockOwner: owner('http'), gbrainBin: BIN });
    expect(http.reason).toBe('http_serve_running');
    expect(http.fix?.argv).toEqual(['gbrain', 'bootstrap', 'harness', '--harness', 'codex', '--yes']);
    expect(http.fix?.consent).toEqual(['persistent_install', 'credentials']);
    expect(http.fix?.why).toContain('bearer token');
    expect(http.fix?.why).toContain('permissions.allow');
    const second = harnessWiringEntry({ transport: 'cli', harnesses: ['claude-code'], lockOwner: owner('stdio'), gbrainBin: BIN });
    expect(second).toMatchObject({ state: 'degraded', reason: 'multiple_sessions' });
    expect(second.fix?.argv).toEqual(['gbrain', 'bootstrap', 'harness', '--harness', 'claude-code', '--yes']);
    expect(harnessWiringEntry({ transport: 'cli', harnesses: ['claude-code', 'codex'], lockOwner: null, gbrainBin: BIN }).fix?.argv?.[4]).toBe('all');
  });

  test('no harness: per-harness install docs; stdio is wired; http is not applicable', () => {
    const none = harnessWiringEntry({ transport: 'cli', harnesses: [], lockOwner: null, gbrainBin: BIN });
    expect(none.reason).toBe('no_harness_detected');
    expect(none.fix?.docs).toContain('docs/protocol/MEMORY_VERBS_v1.md#');
    expect(harnessWiringEntry({ transport: 'stdio', harnesses: [], lockOwner: null, gbrainBin: null })).toMatchObject({ state: 'ok', reason: 'wired_running' });
    expect(harnessWiringEntry({ transport: 'http', harnesses: [], lockOwner: null, gbrainBin: null }).state).toBe('not_applicable');
  });
});

describe('exclusive fixes and lock ownership', () => {
  const action: Action = { argv: ['gbrain', 'init', '--force', '--embedding-model', 'voyage:voyage-4'], consent: ['credentials', 'paid'], actor: 'agent', why: 'w', requires_exclusive: true };

  test('no owner or a non-exclusive fix: unchanged; an owner-delegating command stays one step', () => {
    expect(exclusiveFix(action, null)).toBe(action);
    const plain = { ...action, requires_exclusive: false };
    expect(exclusiveFix(plain, { pid: 1, transport: 'stdio', is_self: false })).toBe(plain);
    const reindex = { ...action, argv: ['gbrain', 'reindex-code', '--yes'] };
    expect(exclusiveFix(reindex, { pid: 1, transport: 'stdio', is_self: false })).toBe(reindex);
  });

  test('a live serve owner: two-step plan, step one (actor user) stops it, then the command', () => {
    const plan = exclusiveFix(action, { pid: 4242, transport: 'http', is_self: false });
    expect(plan).toMatchObject({ actor: 'user', argv: ['kill', '4242'], requires_exclusive: false, then: action });
    expect(plan.why).toContain('gbrain serve --http');
    const rendered = renderAction(plan, cliRenderContext());
    expect(rendered.next).toBe('tell_user_to_run');
    expect(rendered.then?.next).toBe('ask_user');
  });

  test('config plane reads the lock once, derives the owner transport, and wraps exclusive fixes', async () => {
    await withKeys({ VOYAGE_API_KEY: 'v' }, () => {
      let peeks = 0;
      __setLockPeekForTests(() => { peeks++; return { held: true, isServe: true, pid: 999_999, http: false, acquiredAt: 1_700_000_000_000 }; });
      const cfg = pglite({ embedding_disabled: true });
      const r = configReadiness(cfg, { transport: 'stdio' });
      configReadiness(cfg, { transport: 'cli' });
      expect(peeks).toBe(1);
      expect(r.lock_owner).toEqual({ pid: 999_999, transport: 'stdio', started_at: new Date(1_700_000_000_000).toISOString(), is_self: false });
      const fix = entry(r.entries, 'embeddings').fix!;
      expect(fix.argv).toEqual(['kill', '999999']);
      expect(fix.then?.argv?.[1]).toBe('init');
    });
  });

  test('a non-serve holder is not a lock owner', async () => {
    await withKeys({}, () => {
      __setLockPeekForTests(() => ({ held: true, isServe: false, pid: 77 }));
      expect(configReadiness(pglite(), { transport: 'stdio' }).lock_owner).toBeNull();
    });
  });
});

describe('HTTP view', () => {
  test('http_visible:false entries are stripped and paths redacted; no lock owner', async () => {
    await withKeys({ VOYAGE_API_KEY: 'v' }, () => {
      __setLockPeekForTests(() => ({ held: true, isServe: true, pid: 31337, http: true }));
      const view = configReadiness(pglite({ embedding_disabled: true, database_path: '/home/u/.gbrain/brain.pglite' }), { transport: 'http' });
      expect(view.lock_owner).toBeNull();
      expect(view.entries.every(e => e.http_visible)).toBe(true);
      expect(view.entries.map(e => e.capability)).not.toContain('writeback');
      expect(view.entries.map(e => e.capability)).not.toContain('harness_wiring');
      expect(JSON.stringify(view)).not.toContain('/home/u');
      expect(JSON.stringify(view)).not.toContain('31337');
      expect(readinessHttpView([{ capability: 'backup', state: 'ok', reason: 'covered', why: 'x', tier: 'probed', http_visible: false }])).toEqual([]);
    });
  });
});
