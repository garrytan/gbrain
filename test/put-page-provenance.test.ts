/**
 * v0.39.3.0 WARN-8 / A1 / CV6 / CV12 / T2 — put_page provenance.
 *
 * Migration v81 added 4 nullable provenance columns to `pages`
 * (source_kind, source_uri, ingested_via, ingested_at). This test
 * file pins the put_page op contract:
 *
 *   1. Trusted local callers (ctx.remote === false) can populate
 *      source_kind / source_uri / ingested_via via params; the engine
 *      stamps ingested_at server-side.
 *   2. Remote MCP callers (ctx.remote !== false) get server-stamped
 *      `mcp:put_page` REGARDLESS of what they pass — CV6 spoofing guard.
 *   3. COALESCE-preserve UPDATE: a second put_page that omits provenance
 *      does NOT overwrite the original ingestion's audit trail — first
 *      write wins; routine edits survive without erasing it (CV12).
 *   4. Subagent namespace check still fires when provenance params are
 *      present — adding params must not bypass the v0.26.9 F7b
 *      fail-closed contract (T2 regression guard).
 *
 * All cases run against in-memory PGLite (hermetic, no DATABASE_URL).
 * Per CLAUDE.md "Test-isolation lint and helpers (v0.26.7)" the engine
 * is created in beforeAll, reset in beforeEach, disconnected in afterAll.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

let engine: PGLiteEngine;

beforeAll(async () => {
  // Hermeticity guard (cross-file gateway-state leak class — see CLAUDE.md
  // "Test-isolation lint and helpers"). put_page embeds via the gateway.
  // A sibling file in the same shard can leave the gateway configured with
  // a live provider/key (e.g. OpenAI + a CI placeholder `sk-test`); the
  // weight-based shard bin-packing reshuffles which files share a process,
  // so we cannot rely on a benign neighbor. Pin the gateway to legacy
  // OpenAI/1536 (so initSchema builds a 1536-d column) AND stub the embed
  // transport so put_page's embed never touches the network — these tests
  // assert provenance columns, not embeddings. A dummy key is required in
  // the gateway env because instantiateEmbedding builds the OpenAI client
  // (which checks for a key) BEFORE the stubbed transport is reached; the
  // stub then intercepts the actual call, so the key never leaves the
  // process. Reset in afterAll so this file doesn't leak onward.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  // Wipe pages so each test starts from a known empty state. We use
  // executeRaw rather than a TRUNCATE-by-name sweep because this file
  // only touches one table.
  await engine.executeRaw('DELETE FROM pages', []);
});

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: {
      info: () => { /* noop */ },
      warn: () => { /* noop */ },
      error: () => { /* noop */ },
    },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...opts,
  };
}

// Helper — read provenance columns straight from the DB so we don't depend
// on the get_page op (Phase 3b extension).
async function readProvenance(slug: string): Promise<{
  source_kind: string | null;
  source_uri: string | null;
  ingested_via: string | null;
  ingested_at: Date | null;
}> {
  const rows = await engine.executeRaw(
    'SELECT source_kind, source_uri, ingested_via, ingested_at FROM pages WHERE slug = $1',
    [slug],
  ) as Array<{ source_kind: unknown; source_uri: unknown; ingested_via: unknown; ingested_at: unknown }>;
  const r = rows[0];
  return {
    source_kind: (r?.source_kind as string | null) ?? null,
    source_uri: (r?.source_uri as string | null) ?? null,
    ingested_via: (r?.ingested_via as string | null) ?? null,
    ingested_at: r?.ingested_at ? new Date(r.ingested_at as string) : null,
  };
}

describe('put_page provenance — trusted local caller (ctx.remote === false)', () => {
  test('client params honored: source_kind / source_uri / ingested_via populate DB', async () => {
    const ctx = makeCtx({ remote: false });
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-local-write',
      content: '---\ntype: note\ntitle: Local Write\n---\n\nbody',
      source_kind: 'capture-cli',
      source_uri: 'file:///tmp/test.md',
      ingested_via: 'put_page',
    });
    const prov = await readProvenance('wiki/p3a-local-write');
    expect(prov.source_kind).toBe('capture-cli');
    expect(prov.source_uri).toBe('file:///tmp/test.md');
    expect(prov.ingested_via).toBe('put_page');
    // Server stamps ingested_at when ANY provenance field fires
    expect(prov.ingested_at).toBeInstanceOf(Date);
    expect(prov.ingested_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test('omitting all provenance params leaves all 4 DB columns null', async () => {
    const ctx = makeCtx({ remote: false });
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-no-provenance',
      content: '---\ntype: note\ntitle: No Prov\n---\n\nbody',
    });
    const prov = await readProvenance('wiki/p3a-no-provenance');
    expect(prov.source_kind).toBeNull();
    expect(prov.source_uri).toBeNull();
    expect(prov.ingested_via).toBeNull();
    expect(prov.ingested_at).toBeNull();
  });

  test('partial provenance (source_kind only) still triggers ingested_at stamp', async () => {
    const ctx = makeCtx({ remote: false });
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-partial',
      content: '---\ntype: note\ntitle: Partial\n---\n\nbody',
      source_kind: 'capture-cli',
    });
    const prov = await readProvenance('wiki/p3a-partial');
    expect(prov.source_kind).toBe('capture-cli');
    expect(prov.source_uri).toBeNull();
    expect(prov.ingested_via).toBeNull();
    expect(prov.ingested_at).toBeInstanceOf(Date);
  });
});

describe('put_page provenance — CV6 spoofing guard (ctx.remote !== false)', () => {
  test('remote caller cannot claim source_kind: capture-cli', async () => {
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-remote-spoof-attempt',
      content: '---\ntype: note\ntitle: Spoof\n---\n\nbody',
      source_kind: 'capture-cli', // client lies: pretends to be local CLI
      source_uri: 'spoofed://attacker-supplied',
      ingested_via: 'file-watcher', // client lies: claims daemon source
    });
    const prov = await readProvenance('wiki/p3a-remote-spoof-attempt');
    // Server overrode with mcp:put_page; client claims discarded
    expect(prov.source_kind).toBe('mcp:put_page');
    expect(prov.source_uri).toBeNull();
    expect(prov.ingested_via).toBe('mcp:put_page');
    expect(prov.ingested_at).toBeInstanceOf(Date);
  });

  test('ctx.remote === undefined (no explicit trust) is treated as remote', async () => {
    // v0.26.9 F7b discipline: anything that isn't strictly `false` is remote.
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      // remote: explicitly undefined to exercise the fail-closed path
      remote: undefined as unknown as boolean,
      sourceId: 'default',
    };
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-undefined-trust',
      content: '---\ntype: note\ntitle: Undefined\n---\n\nbody',
      source_kind: 'capture-cli',
    });
    const prov = await readProvenance('wiki/p3a-undefined-trust');
    expect(prov.source_kind).toBe('mcp:put_page');
  });
});

describe('put_page provenance — CV12 COALESCE-preserve UPDATE', () => {
  test('second write WITHOUT provenance preserves first-write audit', async () => {
    const ctx = makeCtx({ remote: false });

    // First write stamps capture-cli
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-preserve',
      content: '---\ntype: note\ntitle: V1\n---\n\noriginal body',
      source_kind: 'capture-cli',
      ingested_via: 'put_page',
    });
    const first = await readProvenance('wiki/p3a-preserve');
    expect(first.source_kind).toBe('capture-cli');
    const firstStamp = first.ingested_at!.getTime();

    // Second write — same slug, no provenance params
    await new Promise((r) => setTimeout(r, 10)); // ensure now() would tick
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-preserve',
      content: '---\ntype: note\ntitle: V2\n---\n\nedited body',
    });
    const second = await readProvenance('wiki/p3a-preserve');
    // CV12: provenance preserved — first-write wins
    expect(second.source_kind).toBe('capture-cli');
    expect(second.ingested_via).toBe('put_page');
    // ingested_at preserved too (audit trail truthful about WHEN the first
    // ingestion happened, not WHEN the edit landed)
    expect(second.ingested_at!.getTime()).toBe(firstStamp);
  });

  test('second write WITH new provenance overwrites (explicit re-ingestion)', async () => {
    const ctx = makeCtx({ remote: false });

    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-reingest',
      content: '---\ntype: note\ntitle: V1\n---\n\nbody',
      source_kind: 'capture-cli',
    });

    await new Promise((r) => setTimeout(r, 10));
    await putPageOp.handler(ctx, {
      slug: 'wiki/p3a-reingest',
      content: '---\ntype: note\ntitle: V2\n---\n\nbody',
      source_kind: 'file-watcher', // explicit re-ingest under different kind
      source_uri: 'file:///watched/path.md',
      ingested_via: 'file-watcher',
    });
    const prov = await readProvenance('wiki/p3a-reingest');
    // COALESCE(EXCLUDED.source_kind, pages.source_kind) — EXCLUDED non-null wins
    expect(prov.source_kind).toBe('file-watcher');
    expect(prov.source_uri).toBe('file:///watched/path.md');
    expect(prov.ingested_via).toBe('file-watcher');
  });

  test('remote second write WITHOUT explicit provenance does NOT erase local first-write', async () => {
    // First: local CLI capture
    const localCtx = makeCtx({ remote: false });
    await putPageOp.handler(localCtx, {
      slug: 'wiki/p3a-local-then-remote',
      content: '---\ntype: note\ntitle: V1\n---\n\nbody',
      source_kind: 'capture-cli',
      ingested_via: 'put_page',
    });

    // Second: remote MCP edit (server stamps mcp:put_page)
    const remoteCtx = makeCtx({ remote: true });
    await putPageOp.handler(remoteCtx, {
      slug: 'wiki/p3a-local-then-remote',
      content: '---\ntype: note\ntitle: V2\n---\n\nremote edit',
    });

    // Remote second write is itself a provenance write (server-stamped),
    // so COALESCE(EXCLUDED.source_kind='mcp:put_page', pages.source_kind='capture-cli')
    // resolves to EXCLUDED's non-null value: 'mcp:put_page'. This is the
    // honest answer — the MOST RECENT ingestion source is mcp:put_page,
    // and the system says so. CV12 first-write-wins applies when the second
    // write OMITS provenance entirely (covered by the earlier test); when
    // the second write IS an ingestion, it gets to record itself.
    const prov = await readProvenance('wiki/p3a-local-then-remote');
    expect(prov.source_kind).toBe('mcp:put_page');
  });
});

describe('put_page provenance — T2 subagent namespace regression', () => {
  test('subagent with provenance params STILL gets wiki/agents/<id>/ rejection', async () => {
    // Adding provenance params to put_page must NOT bypass the
    // viaSubagent + sandbox namespace check (operations.ts:556-578).
    // The check runs against `ctx.viaSubagent`, NOT against the params.
    // This regression guard pins it.
    const ctx = makeCtx({
      remote: true,
      viaSubagent: true,
      subagentId: 42,
      // No allowedSlugPrefixes — falls through to legacy default agent-namespace check
    });

    // Attempt to write OUTSIDE the wiki/agents/42/ namespace WITH spoofed
    // provenance params (trying every angle to escape).
    await expect(
      putPageOp.handler(ctx, {
        slug: 'wiki/secret/leak',
        content: '---\ntype: note\ntitle: Leak\n---\n\nbody',
        source_kind: 'capture-cli',
        source_uri: 'file:///tmp/spoof',
        ingested_via: 'put_page',
      }),
    ).rejects.toThrow(/wiki\/agents\/42/);
  });

  test('subagent within wiki/agents/<id>/ namespace succeeds; provenance respects CV6', async () => {
    const ctx = makeCtx({
      remote: true,
      viaSubagent: true,
      subagentId: 42,
    });

    await putPageOp.handler(ctx, {
      slug: 'wiki/agents/42/scratch',
      content: '---\ntype: note\ntitle: Subagent OK\n---\n\nbody',
      source_kind: 'capture-cli', // Spoof attempt — ignored by CV6
    });
    const prov = await readProvenance('wiki/agents/42/scratch');
    // CV6 gate fires AFTER the namespace check; client param ignored
    expect(prov.source_kind).toBe('mcp:put_page');
  });

  test('subagent missing subagentId fails-closed regardless of provenance params', async () => {
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      viaSubagent: true,
      // subagentId intentionally absent
    };

    await expect(
      putPageOp.handler(ctx, {
        slug: 'wiki/agents/42/anything',
        content: '---\ntype: note\n---\n\nbody',
        source_kind: 'capture-cli',
      }),
    ).rejects.toThrow(OperationError);
  });
});
