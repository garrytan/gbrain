/**
 * Refusal-swallow site 6 (triage row src/core/minions/handlers/subagent-oneshot.ts runSubagentOneshot): the wikilink
 * validation reads which pages exist, and a catch turned any failure of that read into "no pages exist" with a strict
 * sample, so a refused read rejected valid pages with nothing naming the engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the slug membership read is the typed listLinkPageMetadataForSlugs and the page sample is the bounded raw
 *    probe (it stops after 5 live pages); a capability refusal from either surfaces instead of becoming strict
 *    validation, and any other read error still validates strictly.
 *  - Reachability: site 6 is unreachable on a Rust brain. runSubagentOneshot acquires a rate lease first
 *    (rate-leases.ts: `pg_advisory_xact_lock` raw SQL inside a transaction), which the Rust engine refuses before any
 *    page validation or provider call; the Rust test below pins that, so a typed bounded probe would serve no Rust caller yet.
 *  - Regression: the old catch answered existingSlugs = {} and pageSample = 5 on a refusal, and a count of the whole source
 *    replaced the old LIMIT 5 probe in the first fix of this site.
 *  - Why existing coverage misses it: test/minions/subagent-oneshot.test.ts runs PGLite only, where the reads never fail.
 *  - Seam: a PGLite engine wrapped so `executeRaw` throws the real refusal (test/helpers/refusing-engine.ts); the Rust
 *    case needs the addon and is skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { refusingEngine } from '../helpers/refusing-engine.ts';
import { existsSync } from 'node:fs';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from '../engine-parity/rust-arm.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { MinionJobContext, SubagentHandlerData } from '../../src/core/minions/types.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import {
  runSubagentOneshot,
  parseOneshotResponse,
  extractWikilinkTargets,
  ONESHOT_SYSTEM,
  ONESHOT_REASK,
  type OneshotArgs,
} from '../../src/core/minions/handlers/subagent-oneshot.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const PREFIXES = ['wiki/personal/reflections/*', 'wiki/originals/*', 'wiki/people/*'];
const SUFFIX = 'abc123';
const GOOD_SLUG_A = `wiki/personal/reflections/2026-08-16-topic-${SUFFIX}`;
const GOOD_SLUG_B = `wiki/originals/ideas/2026-08-16-idea-${SUFFIX}`;

function chatStub(
  text: string,
  stopReason: ChatResult['stopReason'] = 'end',
  outputTokens = 50,
): OneshotArgs['_chat'] {
  return (async () => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 100, output_tokens: outputTokens, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  })) as OneshotArgs['_chat'];
}

async function makeCtx(data: SubagentHandlerData): Promise<MinionJobContext> {
  const job = await queue.add('subagent', data as unknown as Record<string, unknown>, {}, { allowProtectedSubmit: true });
  const ac = new AbortController();
  const shutdown = new AbortController();
  return {
    id: job.id,
    name: job.name,
    data: data as unknown as Record<string, unknown>,
    attempts_made: 0,
    idempotency_key: null,
    signal: ac.signal,
    deadlineAtMs: null,
    shutdownSignal: shutdown.signal,
    async updateProgress() {},
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  };
}

function makeArgs(
  ctx: MinionJobContext,
  data: SubagentHandlerData,
  chatText: string,
  stop: ChatResult['stopReason'] = 'end',
  outputTokens = 50,
): OneshotArgs {
  const tools = buildBrainTools({
    subagentId: ctx.id,
    engine,
    config: { engine: 'pglite' } as unknown as GBrainConfig,
    allowedSlugPrefixes: data.allowed_slug_prefixes,
    sourceId: data.source_id,
    deferEmbeds: true,
  });
  return {
    engine,
    ctx,
    data,
    model: 'anthropic:claude-sonnet-4-6',
    maxOutputTokens: 8192,
    putPageTool: tools.find(t => t.name === 'brain_put_page'),
    leaseKey: 'anthropic:messages',
    maxConcurrent: 32,
    leaseTtlMs: 120_000,
    _chat: chatStub(chatText, stop, outputTokens),
  };
}

const DATA: SubagentHandlerData = {
  prompt: 'CONTEXT ... TRANSCRIPT ...',
  allowed_slug_prefixes: PREFIXES,
  oneshot_slug_suffix: SUFFIX,
  mode: 'oneshot',
  require_writes: true,
};

/** chatStub usage as the runner reports it on post-call fallbacks (CX-P2b). */
const FB_TOKENS = { in: 100, out: 50, cache_read: 0, cache_create: 0 };



const VALID_RESPONSE = JSON.stringify({
  pages: [
    { slug: GOOD_SLUG_A, title: 'Topic', type: 'note', body: `A reflection. See [[${GOOD_SLUG_B}]] for the idea.` },
    { slug: GOOD_SLUG_B, title: 'Idea', type: 'note', body: `An idea. Related: [[${GOOD_SLUG_A}]].` },
  ],
  skipped: false,
  skip_reason: null,
});

describe('runSubagentOneshot existing-page reads', () => {
  test('S6 a capability refusal from the typed slug membership read surfaces instead of becoming strict validation', async () => {
    const resp = JSON.stringify({ pages: [{ slug: GOOD_SLUG_A, body: 'links [[concepts/future-page]]' }], skipped: false });
    for (const member of ['listLinkPageMetadataForSlugs']) {
      const data = { ...DATA, prompt: `${DATA.prompt} ${member}` };
      const ctx = await makeCtx(data);
      const args = makeArgs(ctx, data, resp);
      await expect(runSubagentOneshot({ ...args, engine: refusingEngine(engine, { members: [member], needle: null }) }))
        .rejects.toMatchObject({ code: 'engine_capability_missing' });
    }
  });

  test('S6 bounded probe: the page sample stops after 5 live pages instead of counting the whole source', async () => {
    const statements: string[] = [];
    let counted = 0;
    const spy = new Proxy(engine as unknown as Record<string, unknown>, {
      get(target, property) {
        if (property === 'executeRaw') return async (sql: string, ...rest: unknown[]) => { statements.push(sql); return (engine.executeRaw as (...a: unknown[]) => Promise<unknown>).call(engine, sql, ...rest); };
        if (property === 'countSourcePages') return async () => { counted++; return 0; };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(engine) : value;
      },
    }) as unknown as typeof engine;
    const resp = JSON.stringify({ pages: [{ slug: GOOD_SLUG_A, body: 'first page ever, links [[concepts/future-page]]' }], skipped: false });
    const ctx = await makeCtx(DATA);
    const args = makeArgs(ctx, DATA, resp);
    expect((await runSubagentOneshot({ ...args, engine: spy })).kind).toBe('done');
    expect(counted).toBe(0);
    expect(statements.filter((sql) => /FROM pages WHERE source_id = \$1 AND deleted_at IS NULL LIMIT 5/.test(sql))).toHaveLength(1);
  });

  test('S6 a capability refusal from the bounded page sample surfaces instead of becoming strict validation', async () => {
    const resp = JSON.stringify({ pages: [{ slug: GOOD_SLUG_A, body: 'links [[concepts/future-page]]' }], skipped: false });
    const data = { ...DATA, prompt: `${DATA.prompt} sample refusal` };
    const ctx = await makeCtx(data);
    const args = makeArgs(ctx, data, resp);
    await expect(runSubagentOneshot({ ...args, engine: refusingEngine(engine, { needle: 'LIMIT 5' }) })).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  const rustRun = existsSync(rustArmAddonPath()) || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' ? test : test.skip;
  rustRun('S6 finding: a Rust brain never reaches the page validation; the rate-lease transaction (raw advisory-lock SQL) is refused first and the provider is not called', async () => {
    const { engine: rust, dir } = await openRustBrain();
    try {
      let chatCalls = 0;
      const ctx = await makeCtx(DATA);
      const args = makeArgs(ctx, DATA, VALID_RESPONSE);
      const inner = args._chat!;
      const outcome = await runSubagentOneshot({ ...args, engine: rust as unknown as typeof engine, _chat: (async (o: Parameters<typeof inner>[0]) => { chatCalls++; return inner(o); }) as typeof inner })
        .then(() => null, (e: unknown) => e);
      expect(outcome).toMatchObject({ code: 'engine_capability_missing' });
      expect(String((outcome as Error).message)).toContain('raw_sql');
      expect(chatCalls).toBe(0);
    } finally {
      await rust.disconnect();
      removeBrainDir(dir);
    }
  }, 30_000);
});
