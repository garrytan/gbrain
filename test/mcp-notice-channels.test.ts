/**
 * Lane F notice producers on the MCP channel (agent operator contract v1,
 * F3 / F8 / F9): degraded recall, a source binding that narrowed an empty
 * read, and the keyless explanations. Pins the closed DEGRADED_STAGE_GUIDANCE
 * map, the wire shape (content[0] byte-identical, notices as prefixed extra
 * blocks + `_meta.gbrain_notices`), stdio once-per-session vs HTTP
 * every-call delivery, and the "never coach on a keyless-by-choice brain" rule.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall, __resetBackupNoticeForTests } from '../src/mcp/dispatch.ts';
import { DEGRADED_STAGES, RANKING_ONLY_DEGRADED_STAGES } from '../src/core/types.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import {
  DEGRADED_STAGE_GUIDANCE, degradedRecallNotice, sourceBindingNarrowedNotice, recallStagesFor,
  chatKeyFix, keylessThinkNotice, thinkNotSavedNotice, degradedDedupNotice,
} from '../src/core/interop-notices.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  __resetBackupNoticeForTests();
});

const NO_KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_EMBEDDING_MODEL: undefined };
const keylessByChoice = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;
const keylessUnchosen = { engine: 'pglite' } as unknown as GBrainConfig;

describe('DEGRADED_STAGE_GUIDANCE', () => {
  test('covers every recall-affecting stage and no ranking-only one', () => {
    for (const stage of DEGRADED_STAGES) {
      if (RANKING_ONLY_DEGRADED_STAGES.has(stage)) expect(stage in DEGRADED_STAGE_GUIDANCE).toBe(false);
      else expect(DEGRADED_STAGE_GUIDANCE[stage as keyof typeof DEGRADED_STAGE_GUIDANCE]).toBeDefined();
    }
  });

  test('every Lane F notice code is registered with its kind', () => {
    expect(NOTICE_CODES.degraded_recall.kind).toBe('degraded');
    for (const c of ['source_binding_narrowed', 'degraded_dedup', 'synthesis_keyless', 'think_not_saved', 'listing_truncated'] as const) {
      expect(NOTICE_CODES[c].kind).toBe('info');
    }
  });

  test('ranking-only degradation is no notice; recall-affecting stages are named and say "not absence"', () => {
    expect(degradedRecallNotice([{ stage: 'reranker_skipped' }], { config: keylessUnchosen, transport: 'stdio' })).toBeNull();
    const n = degradedRecallNotice([{ stage: 'expansion_failed', reason: 'timeout' }], { config: keylessUnchosen, transport: 'stdio' })!;
    expect(n.code).toBe('degraded_recall');
    expect(n.kind).toBe('degraded');
    expect(n.why).toContain('expansion_failed');
    expect(n.why).toContain('never as "the brain has nothing on this"');
    expect(n.fix?.argv).toEqual(['gbrain', 'doctor', '--json']);
  });

  test('keyword-only on a brain without a key: the enablement fix asks (credentials + paid)', async () => {
    await withEnv(NO_KEYS, async () => {
      const n = degradedRecallNotice([{ stage: 'embed_unavailable', reason: 'no_provider' }], { config: keylessUnchosen, transport: 'stdio' })!;
      expect(n.fix?.consent).toEqual(['credentials', 'paid']);
      expect(n.user_message).toBeTruthy();
    });
  });

  test('keyless by the user\'s choice: the notice states the limit but never coaches', async () => {
    await withEnv(NO_KEYS, async () => {
      const n = degradedRecallNotice(['keyword_only_no_embedding_provider'], { config: keylessByChoice, transport: 'stdio' })!;
      expect(n.fix).toBeUndefined();
      expect(n.user_message).toBeUndefined();
      expect(n.why).toContain("keyword-only by the user's choice");
      expect(degradedDedupNotice(keylessByChoice).fix).toBeUndefined();
    });
  });

  test('recallStagesFor reads each op\'s own degradation marker', () => {
    expect(recallStagesFor('search', [], { retrieval: { degraded: [{ stage: 'reranker_skipped' }, { stage: 'embed_unavailable' }] } })).toEqual(['embed_unavailable']);
    expect(recallStagesFor('recall', { facts: [], search_degraded: 'keyword_only_no_embedding_provider' }, {})).toEqual(['keyword_only_no_embedding_provider']);
    expect(recallStagesFor('context_pack', { degraded_reason: 'deadline' }, {})).toEqual(['deadline']);
    expect(recallStagesFor('think', { warnings: ['QUESTION_EMBED_FAILED'] }, {})).toEqual(['embed_unavailable']);
    expect(recallStagesFor('get_page', {}, {})).toEqual([]);
  });
});

describe('degraded recall over MCP dispatch (keyless PGLite)', () => {
  async function seedPage() {
    await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha', compiled_truth: 'Alpha body about widgets.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }

  test('stdio: content[0] unchanged, a prefixed degraded block + _meta.gbrain_notices, once per session', async () => {
    await withEnv(NO_KEYS, async () => {
      await seedPage();
      const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', config: keylessUnchosen };
      const first = await dispatchToolCall(engine as any, 'search', { query: 'widgets' }, opts);
      expect(first.isError).toBeUndefined();
      expect(Array.isArray(JSON.parse(first.content[0].text))).toBe(true);
      const block = first.content.find(c => c.text.startsWith('[gbrain notice degraded_recall kind=degraded]'));
      expect(block).toBeDefined();
      expect(block!.text).toContain('embed_unavailable');
      const meta = first._meta?.gbrain_notices as Array<{ code: string; contract_version: number }>;
      expect(meta.some(n => n.code === 'degraded_recall' && n.contract_version === 1)).toBe(true);
      // Process ledger: the stdio session saw it already.
      const second = await dispatchToolCall(engine as any, 'search', { query: 'widgets' }, opts);
      expect(second.content.some(c => c.text.startsWith('[gbrain notice degraded_recall'))).toBe(false);
    });
  }, 60_000);

  test('HTTP: degraded notices ride every affected call', async () => {
    await withEnv(NO_KEYS, async () => {
      await seedPage();
      const { NoticeLedger } = await import('../src/core/notice-ledger.ts');
      const opts = {
        remote: true, transport: 'http' as const, sourceId: 'default', config: keylessUnchosen, noticeLedger: new NoticeLedger(),
        auth: { token: 't', clientId: 'client-a', clientName: 'a', scopes: ['read'], expiresAt: Date.now() / 1000 + 3600 } as any,
      };
      for (let i = 0; i < 2; i++) {
        const res = await dispatchToolCall(engine as any, 'search', { query: 'widgets' }, opts);
        expect(res.content.some(c => c.text.startsWith('[gbrain notice degraded_recall kind=degraded]'))).toBe(true);
      }
    });
  }, 60_000);
});

describe('source_binding_narrowed', () => {
  const binding = { sourceId: 'work', via: 'GBRAIN_SOURCE' as const, sourceIds: ['work', 'personal'], optedOut: [] };

  test('an empty unqualified bound read names the binding and the explicit read', () => {
    const n = sourceBindingNarrowedNotice('search', { query: 'x' }, [], binding)!;
    expect(n.code).toBe('source_binding_narrowed');
    expect(n.why).toContain("bound to source 'work' by GBRAIN_SOURCE");
    expect(n.fix?.mcp).toEqual({ tool: 'search', arguments: { query: 'x', source_id: 'personal' } });
  });

  test('silent when the read named a source, found something, or nothing else is readable', () => {
    expect(sourceBindingNarrowedNotice('search', { query: 'x', source_id: 'work' }, [], binding)).toBeNull();
    expect(sourceBindingNarrowedNotice('search', { query: 'x' }, [{ slug: 'a' }], binding)).toBeNull();
    expect(sourceBindingNarrowedNotice('search', { query: 'x' }, [], { ...binding, sourceIds: ['work'] })).toBeNull();
    expect(sourceBindingNarrowedNotice('get_page', { slug: 'x' }, [], binding)).toBeNull();
  });

  test('opted-out sources are named without a fix', () => {
    const n = sourceBindingNarrowedNotice('recall', {}, { facts: [] }, { ...binding, sourceIds: ['work'], optedOut: ['private'] })!;
    expect(n.why).toContain('opted out of federated reads): private');
    expect(n.fix).toBeUndefined();
  });

  test('dispatch attaches it to an empty bound stdio read every time (per-call notice)', async () => {
    await withEnv(NO_KEYS, async () => {
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('work', 'work', '{}'::jsonb), ('personal', 'personal', '{}'::jsonb) ON CONFLICT DO NOTHING`);
      const opts = { remote: true, transport: 'stdio' as const, sourceId: 'work', explicitReadBinding: binding, config: keylessUnchosen };
      for (let i = 0; i < 2; i++) {
        const res = await dispatchToolCall(engine as any, 'list_pages', {}, opts);
        expect(JSON.parse(res.content[0].text)).toEqual([]);
        expect(res.content.some(c => c.text.startsWith('[gbrain notice source_binding_narrowed kind=info]'))).toBe(true);
      }
    });
  }, 60_000);
});

describe('keyless answers ask before spending (F8/F9)', () => {
  test('the chat-key fix names both providers, asks, and never puts a key on a command line', () => {
    const fix = chatKeyFix();
    expect(fix.consent).toEqual(['credentials', 'paid']);
    expect(fix.actor).toBe('user');
    expect(fix.why).toContain('ANTHROPIC_API_KEY');
    expect(fix.why).toContain('OPENAI_API_KEY');
    expect(fix.why).toContain('Free fallback');
    expect(fix.argv?.join(' ')).not.toMatch(/sk-|api_key/);
  });

  test('think keyless + not-saved notices are info and carry their reason', () => {
    expect(keylessThinkNotice().kind).toBe('info');
    expect(keylessThinkNotice().fix?.consent).toEqual(['credentials', 'paid']);
    expect(thinkNotSavedNotice().why).toContain('saved_slug: null');
  });
});

describe('F6 hidden-tool hint (owner stdio only)', () => {
  test('a tool outside the stdio surface names itself, its CLI equivalent and GBRAIN_SURFACE=full', async () => {
    // A1: the CLI fix names the served brain explicitly.
    const { STARTER_OPS } = await import('../src/mcp/surface.ts');
    const allowedOps = new Set(STARTER_OPS);
    const stdio = await dispatchToolCall(engine as any, 'get_health', {}, { remote: true, transport: 'stdio', sourceId: 'default', allowedOps, surface: 'starter' });
    const env = JSON.parse(stdio.content[0].text);
    expect(env.code).toBe('unknown_tool');
    expect(env.suggestion).toContain('get_health exists, but this server runs the starter tool surface');
    expect(env.suggestion).toContain('GBRAIN_SURFACE=full');
    expect(env.fix.command).toBe('gbrain doctor --json --brain host');
    expect(env.fix.next).toBe('tell_user_to_run');
    // HTTP keeps the opaque envelope (no existence oracle).
    const http = await dispatchToolCall(engine as any, 'get_health', {}, { remote: true, transport: 'http', sourceId: 'default', allowedOps, surface: 'starter' });
    const opaque = JSON.parse(http.content[0].text);
    expect(opaque.code).toBe('unknown_tool');
    expect(opaque.suggestion).not.toContain('exists');
    expect(opaque.fix?.command).not.toBe('gbrain doctor --json --brain host');
  });
});

describe('F7 coaching reaches agents', () => {
  test('the advisor is published on stdio by default; HTTP stays opt-in; explicit false and read failures hide it', async () => {
    const { readPublishGate } = await import('../src/mcp/publish-gates.ts');
    const unset = { getConfig: async () => null } as any;
    expect(await readPublishGate(unset, {} as any, 'mcp.publish_advisor', 'stdio')).toBe(true);
    expect(await readPublishGate(unset, {} as any, 'mcp.publish_advisor', 'http')).toBe(false);
    expect(await readPublishGate(unset, {} as any, 'mcp.publish_skills', 'stdio')).toBe(false);
    expect(await readPublishGate({ getConfig: async () => 'false' } as any, {} as any, 'mcp.publish_advisor', 'stdio')).toBe(false);
    expect(await readPublishGate(unset, { mcp: { publish_advisor: false } } as any, 'mcp.publish_advisor', 'stdio')).toBe(false);
    expect(await readPublishGate({ getConfig: async () => { throw new Error('down'); } } as any, {} as any, 'mcp.publish_advisor', 'stdio')).toBe(false);
  });

  test('post-upgrade: one safety notice per upgraded version on stdio, with contract_version and the behavior-table URL', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { VERSION } = await import('../src/version.ts');
    const { takePostUpgradeMcpNotice, __resetPostUpgradeNoticeForTests } = await import('../src/core/post-upgrade-notice.ts');
    const { renderNotice, cliRenderContext } = await import('../src/core/agent-output.ts');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-postup-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'upgrade-state.json'), JSON.stringify({ last_upgrade: { from: '0.0.1.0', to: VERSION } }));
      await withEnv({ HOME: home, GBRAIN_HOME: home, GBRAIN_NO_ONBOARD_NUDGE: undefined }, async () => {
        __resetPostUpgradeNoticeForTests();
        const n = takePostUpgradeMcpNotice()!;
        expect(n.code).toBe('post_upgrade');
        expect(n.kind).toBe('safety');
        const r = renderNotice(n, cliRenderContext());
        expect(r.contract_version).toBe(1);
        expect(r.fix?.docs).toMatch(/^https:\/\/.*CHANGELOG\.md#behavior-changes-for-scripts-and-agents$/);
        __resetPostUpgradeNoticeForTests();
        expect(takePostUpgradeMcpNotice()).toBeNull();
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      __resetPostUpgradeNoticeForTests();
    }
  });
});
