/**
 * Onboarding coaching over stdio MCP (src/core/onboard/mcp-onboarding.ts):
 * the affinity map, per-class result predicates, the cache (cold, persisted,
 * TTL), dedupe/budget/mute through dispatch's ledger, the first-run bundle
 * on the second call, HTTP silence, and the stdio mute fix (mute_notice over
 * stdio, `gbrain notices unmute`, a fresh process).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operations } from '../src/core/operations.ts';
import { allowedOpNames, isReadOnlyOperation, STARTER_OPS } from '../src/mcp/surface.ts';
import { dispatchToolCall, dispatchRenderContext, __resetBackupNoticeForTests, type ToolResult } from '../src/mcp/dispatch.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import {
  ONBOARD_CALL_AFFINITY, collectOnboardOpportunities, mcpOnboardingNotices, startOnboardingRefresher,
  __awaitOnboardingRefreshForTests, __resetMcpOnboardingForTests, __warmOnboardingCacheForTests,
} from '../src/core/onboard/mcp-onboarding.ts';
import { processNoticeLedger, setNoticeMuted } from '../src/core/notice-ledger.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  // Onboarding state is process-wide: leave a fresh process for the next file in this shard,
  // or its stdio dispatches inherit this file's warm snapshot and first-run bundle.
  newProcess();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  newProcess();
});

/** A fresh stdio process: onboarding state and the per-process notice ledger. */
function newProcess(now: () => number = Date.now): void {
  __resetMcpOnboardingForTests(now);
  __resetBackupNoticeForTests();
}

async function inHome<T>(fn: () => Promise<T>, env: Record<string, string | undefined> = {}): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gb-onboard-mcp-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_NO_ONBOARD_NUDGE: undefined, ...env }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const PEOPLE = ['alice-example', 'bob-example', 'charlie-example', 'dana-example', 'erin-example', 'frank-example'];

/** Six people pages with no links or timeline, one note, unembedded chunks, no takes. */
async function seedGaps(): Promise<void> {
  for (const p of PEOPLE) {
    await engine.putPage(`people/${p}`, { type: 'person', title: p, compiled_truth: `${p} works at acme-example.` });
  }
  await engine.putPage('notes/standup', { type: 'note', title: 'standup', compiled_truth: 'Weekly standup notes.' });
  await engine.upsertChunks('notes/standup', [{ chunk_index: 0, chunk_text: 'Weekly standup notes.', chunk_source: 'compiled_truth' }]);
}

const STARTER = new Set(STARTER_OPS);
const stdio = (allowedOps: ReadonlySet<string> | null = STARTER) => ({
  remote: true, transport: 'stdio' as const, sourceId: 'default',
  ...(allowedOps ? { allowedOps, surface: 'starter' as const } : {}),
});
const call = (name: string, params: Record<string, unknown>, opts = stdio()) => dispatchToolCall(engine as never, name, params, opts);
const notices = (r: ToolResult) => ((r._meta?.gbrain_notices ?? []) as Array<{ code: string; kind: string; why: string; user_message?: string; fix?: { next: string; mcp?: { tool: string }; command?: string }; decisions?: Array<{ id: string }> }>);
const codes = (r: ToolResult) => notices(r).map(n => n.code);
const onboard = (r: ToolResult) => codes(r).filter(c => c.startsWith('onboard_'));

describe('affinity map', () => {
  test('every op exists in the catalogue and every class reaches the verbs and starter surfaces', () => {
    const names = new Set(operations.map(o => o.name));
    const verbs = allowedOpNames(operations, 'verbs');
    for (const [cls, ops] of Object.entries(ONBOARD_CALL_AFFINITY)) {
      for (const op of ops) expect(names.has(op), `${cls}: ${op}`).toBe(true);
      expect(ops.some(op => verbs.has(op)), `${cls} on verbs`).toBe(true);
      expect(ops.some(op => STARTER_OPS.has(op)), `${cls} on starter`).toBe(true);
    }
  });
});

describe('opportunity notices on stdio', () => {
  test('a cold cache delivers nothing', async () => {
    await inHome(async () => {
      await seedGaps();
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual([]);
    });
  });

  test('a notice rides an affine call, none rides an unrelated call, and the second matching call is deduped', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('list_pages', {}))).toEqual([]);
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual(['onboard_link_coverage']);
      expect(onboard(await call('get_backlinks', { slug: 'people/bob-example' }))).toEqual([]);
    });
  });

  test('two classes are both delivered: stale chunks on search, then link coverage on get_backlinks', async () => {
    const key = ['sk', 'test', String(Date.now())].join('-');
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const config = { engine: 'pglite', embedding_model: 'openai:text-embedding-3-small' } as GBrainConfig;
      const stale = await mcpOnboardingNotices({ engine: engine as never, op: 'search', result: [], meta: { retrieval: { degraded: [] } }, config, render: dispatchRenderContext(stdio()) });
      const admitted = processNoticeLedger().admit(stale, { transport: 'stdio' });
      expect(admitted.map(n => n.code)).toEqual(['onboard_stale_chunks']);
      expect(admitted[0].why).toContain('gbrain embed --stale');
      expect(admitted[0].why).toContain('ask the user first');
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual(['onboard_link_coverage']);
    }, { OPENAI_API_KEY: key });
  });

  test('a keyless brain and a search whose vector arm did not run get no stale-chunk notice', async () => {
    const key = ['sk', 'test', String(Date.now())].join('-');
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const render = dispatchRenderContext(stdio());
      const keyless = { engine: 'pglite', embedding_disabled: true } as GBrainConfig;
      const staleOnly = async (meta: Record<string, unknown>, config: GBrainConfig) =>
        (await mcpOnboardingNotices({ engine: engine as never, op: 'search', result: [], meta, config, render })).filter(n => n.code === 'onboard_stale_chunks');
      expect(await staleOnly({}, keyless)).toEqual([]);
      const configured = { engine: 'pglite', embedding_model: 'openai:text-embedding-3-small' } as GBrainConfig;
      const degraded = { retrieval: { degraded: [{ stage: 'embed_unavailable', reason: 'no_provider' }] } };
      expect(await staleOnly(degraded, configured)).toEqual([]);
      expect((await staleOnly({ retrieval: { degraded: [] } }, configured)).length).toBe(1);
    }, { OPENAI_API_KEY: key });
  });

  test('the coaching budget caps a session at two coaching notices', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const first = await call('get_backlinks', { slug: 'people/alice-example' });
      expect(notices(first).filter(n => n.kind === 'coaching').map(n => n.code).sort()).toEqual(['features_auto_fix', 'onboard_link_coverage']);
      const second = await call('entity', { name: 'people/charlie-example' });
      expect(notices(second).filter(n => n.kind === 'coaching')).toEqual([]);
    });
  });

  test('features_auto_fix rides link-graph calls only', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      expect(codes(await call('entity', { name: 'people/alice-example' }))).not.toContain('features_auto_fix');
      __resetBackupNoticeForTests();
      expect(codes(await call('traverse_graph', { slug: 'people/alice-example' }))).toContain('features_auto_fix');
    });
  });

  test('timeline coverage: an entity page without timeline gets the notice, a note page does not', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('get_page', { slug: 'notes/standup' }))).toEqual([]);
      expect(onboard(await call('get_page', { slug: 'people/alice-example' }))).toEqual(['onboard_timeline_coverage']);
    });
  });

  test('zero takes rides recall', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('recall', { query: 'acme-example' }))).toEqual(['onboard_no_takes']);
    });
  });

  test('an empty brain emits nothing', async () => {
    await inHome(async () => {
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('recall', { query: 'anything' }))).toEqual([]);
      expect(onboard(await call('get_backlinks', { slug: 'people/nobody-example' }))).toEqual([]);
    });
  });

  test('GBRAIN_NO_ONBOARD_NUDGE=1 silences notices and the first-run bundle', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      for (const name of ['list_pages', 'get_backlinks', 'recall']) {
        const r = await call(name, name === 'recall' ? { query: 'x' } : name === 'get_backlinks' ? { slug: 'people/alice-example' } : {});
        expect(codes(r).filter(c => c.startsWith('onboard_') || c === 'first_run_decisions' || c === 'features_auto_fix')).toEqual([]);
      }
    }, { GBRAIN_NO_ONBOARD_NUDGE: '1' });
  });

  test('a rendered notice tells an MCP-only agent to relay the CLI preview, or runs get_health where it is callable', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const starter = notices(await call('get_backlinks', { slug: 'people/alice-example' })).find(n => n.code === 'onboard_link_coverage')!;
      expect(starter.fix?.next).toBe('tell_user_to_run');
      expect(starter.fix?.command).toContain('gbrain onboard --check');
      expect(starter.user_message).toBeTruthy();
      expect(starter.why).toContain('gbrain extract links');
      newProcess();
      await __warmOnboardingCacheForTests(engine as never);
      const full = notices(await call('get_backlinks', { slug: 'people/alice-example' }, stdio(null))).find(n => n.code === 'onboard_link_coverage')!;
      expect(full.fix?.mcp?.tool).toBe('get_health');
      expect(full.fix?.next).toBe('run');
    });
  });

  test('read-only access names the CLI mute instead of mute_notice', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const readOnly = new Set(operations.filter(o => STARTER_OPS.has(o.name) && isReadOnlyOperation(o)).map(o => o.name));
      const ro = notices(await call('get_backlinks', { slug: 'people/alice-example' }, stdio(readOnly))).find(n => n.code === 'onboard_link_coverage')!;
      expect(ro.why).toContain('gbrain notices mute onboard_link_coverage');
      expect(ro.why).not.toContain('mute_notice');
      newProcess();
      await __warmOnboardingCacheForTests(engine as never);
      const rw = notices(await call('get_backlinks', { slug: 'people/alice-example' })).find(n => n.code === 'onboard_link_coverage')!;
      expect(rw.why).toContain('call mute_notice {"code":"onboard_link_coverage"}');
    });
  });

  test('a TTL refresh drops a gap the user fixed', async () => {
    let now = Date.now();
    await inHome(async () => {
      await seedGaps();
      newProcess(() => now);
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual(['onboard_link_coverage']);
      for (const p of PEOPLE) await engine.addLink('notes/standup', `people/${p}`, 'mentioned');
      now += 7 * 60 * 60 * 1000;
      await call('list_pages', {});
      await __awaitOnboardingRefreshForTests();
      __resetBackupNoticeForTests();
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual([]);
    });
  });

  test('persisted counts start a new session warm', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      newProcess();
      await startOnboardingRefresher(engine as never, { idle: () => false });
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual(['onboard_link_coverage']);
    });
  });

  test('HTTP dispatch emits no onboarding notices', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const http = { remote: true, transport: 'http' as const, sourceId: 'default', auth: { clientId: 'client-example', scopes: ['read'] } };
      for (const r of [await call('list_pages', {}, http as never), await call('get_backlinks', { slug: 'people/alice-example' }, http as never)]) {
        expect(codes(r).filter(c => c.startsWith('onboard_') || c === 'first_run_decisions' || c === 'features_auto_fix')).toEqual([]);
      }
    });
  });
});

describe('stdio mutes', () => {
  test('a stdio mute applies, and survives a fresh process', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      const muted = JSON.parse((await call('mute_notice', { code: 'onboard_link_coverage' })).content[0].text);
      expect(muted.muted).toBe(true);
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual([]);
      newProcess();
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual([]);
    });
  });

  test('an MCP mute, then `gbrain notices unmute`, then a fresh process shows the notice again', async () => {
    await inHome(async () => {
      await seedGaps();
      await call('mute_notice', { code: 'onboard_link_coverage' });
      const { run } = await import('../src/cli/commands/notices.ts');
      const write = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try { await run(['unmute', 'onboard_link_coverage']); } finally { process.stdout.write = write; }
      newProcess();
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual(['onboard_link_coverage']);
    });
  });

  test('the owner global mute applies on stdio', async () => {
    await inHome(async () => {
      await seedGaps();
      setNoticeMuted('onboard_link_coverage', true);
      await __warmOnboardingCacheForTests(engine as never);
      expect(onboard(await call('get_backlinks', { slug: 'people/alice-example' }))).toEqual([]);
    });
  });
});

describe('first-run decisions over stdio', () => {
  const firstRun = (r: ToolResult) => notices(r).find(n => n.code === 'first_run_decisions');

  test('the bundle rides the second successful call once per process, again in a new process', async () => {
    await inHome(async () => {
      await seedGaps();
      await __warmOnboardingCacheForTests(engine as never);
      expect(firstRun(await call('list_pages', {}))).toBeUndefined();
      const second = firstRun(await call('list_pages', {}));
      expect(second?.kind).toBe('ask');
      expect(second?.why).toContain("Finish the user's current request, then ask.");
      expect(second?.decisions?.map(d => d.id)).toContain('writeback');
      expect(second?.decisions?.map(d => d.id)).not.toContain('search_mode');
      expect(second?.decisions?.map(d => d.id)).not.toContain('harness_wiring');
      expect(firstRun(await call('list_pages', {}))).toBeUndefined();
      newProcess();
      await __warmOnboardingCacheForTests(engine as never);
      await call('list_pages', {});
      expect(firstRun(await call('list_pages', {}))?.decisions?.map(d => d.id)).toContain('writeback');
    });
  });

  test('the writeback decision is gone once memory.auto_writeback is set', async () => {
    await inHome(async () => {
      await seedGaps();
      await engine.setConfig('memory.auto_writeback', 'salient');
      await __warmOnboardingCacheForTests(engine as never);
      await call('list_pages', {});
      expect(firstRun(await call('list_pages', {}))?.decisions?.map(d => d.id) ?? []).not.toContain('writeback');
    });
  });

  test('the bundle is gone after mute_notice first_run_decisions', async () => {
    await inHome(async () => {
      await seedGaps();
      await call('mute_notice', { code: 'first_run_decisions' });
      newProcess();
      await __warmOnboardingCacheForTests(engine as never);
      await call('list_pages', {});
      expect(firstRun(await call('list_pages', {}))).toBeUndefined();
    });
  });
});

describe('stale-chunk count (#5256)', () => {
  test('counts only chunks the embedder would pick up: embed_skip and soft-deleted pages are not backlog', async () => {
    for (const slug of ['notes/stale-example', 'notes/skip-example', 'notes/deleted-example']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', token_count: 2 }]);
    }
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"embed_skip": true}'::jsonb WHERE slug = 'notes/skip-example'`);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted-example'`);
    const counts = await collectOnboardOpportunities(engine, new AbortController().signal);
    expect(counts.staleChunks).toBe(await engine.countStaleChunks());
    expect(counts.staleChunks).toBe(1);
  });
});
