/**
 * open_loops / loops_close / loops_mute op handlers
 * (src/core/ops/loops.ts) on PGLite with seeded loops.
 *
 * Trust posture under test: trusted local (remote:false) gets quotes + the
 * injectable text digest; remote (remote !== false) gets redacted views with
 * NO verbatim quotes and NO deep links anywhere in the payload.
 *
 * NOTE (suspected src bug, not pinned here): trusted GROUPED calls in these
 * tests deliberately avoid `due_at`, because renderText calls
 * `l.due_at.slice(0, 10)` on a value PGLite returns as a JS Date — see the
 * report accompanying this test wave. Ranking tests that need due_at use a
 * remote ctx (renderText is trusted-only).
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { toAgentError } from '../src/core/agent-output.ts';
import {
  closeOpenLoop,
  listOpenLoops,
  loadSuppressions,
  upsertOpenLoop,
  type OpenLoopUpsert,
} from '../src/core/loops/loops-store.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at)
     VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
  );
});

const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;
const loopsCloseOp = loopsOperations.find((o) => o.name === 'loops_close')!;
const loopsMuteOp = loopsOperations.find((o) => o.name === 'loops_mute')!;
const loopsUnmuteOp = loopsOperations.find((o) => o.name === 'loops_unmute')!;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'g1',
    ...over,
  } as OperationContext;
}

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: `thread:${over.threadId ?? '18c2f4a9b3d21e07'}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com',
    summary: 'Reply owed to bob@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

interface GroupsResult {
  groups: Array<{
    counterparty: string;
    loop_count: number;
    loops: Array<Record<string, unknown>>;
    context?: unknown;
  }>;
  count: number;
  stale: boolean;
  sources: Array<{ id: string; stale: boolean }>;
  redacted: boolean;
  text?: string;
}

describe('registration', () => {
  test('all three ops are registered in the contract with the right scopes', () => {
    expect(operationsByName['open_loops']).toBeDefined();
    expect(operationsByName['open_loops'].scope).toBe('read');
    expect(operationsByName['loops_close']).toBeDefined();
    expect(operationsByName['loops_close'].scope).toBe('write');
    expect(operationsByName['loops_close'].mutating).toBe(true);
    expect(operationsByName['loops_mute']).toBeDefined();
    expect(operationsByName['loops_mute'].scope).toBe('write');
    expect(operationsByName['loops_unmute']).toBeDefined();
    expect(operationsByName['loops_unmute'].scope).toBe('write');
    expect(operationsByName['loops_unmute'].mutating).toBe(true);
  });
});

describe('open_loops grouped', () => {
  async function seedRanked(): Promise<void> {
    // alice: 1 loop DUE TOMORROW → 10 + 30 (due<=3d) ≈ 40.
    await upsertOpenLoop(
      engine,
      loop({
        threadId: '18c2f4a9b3d21e01',
        counterpartyEmail: 'alice@example.com',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    // carol: 3 loops, brand new, no due → 30 + ε.
    for (const suffix of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) {
      await upsertOpenLoop(
        engine,
        loop({
          dedupKey: `commit:${suffix}`,
          loopType: 'commitment_owed_by_me',
          counterpartyEmail: 'carol@example.com',
          detector: 'llm_extract',
        }),
      );
    }
    // bob: 1 old loop (opened 10d ago), no due → 10 + 10 = 20.
    const bob = await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e02', counterpartyEmail: 'bob@example.com' }),
    );
    await engine.executeRaw(
      `UPDATE open_loops SET opened_at = now() - interval '10 days' WHERE id = $1`,
      [bob.id],
    );
  }

  test('ranking is deterministic: due-soon counterparty outranks the loop_count pile outranks the single old loop', async () => {
    await seedRanked();
    // remote ctx: ranking runs the same; renderText (trusted-only) is skipped,
    // which sidesteps the due_at Date/renderText incompatibility (see header).
    const run = async () =>
      (await openLoopsOp.handler(ctx({ remote: true }), {})) as GroupsResult;
    const first = await run();
    expect(first.groups.map((g) => g.counterparty)).toEqual([
      'alice@example.com',
      'carol@example.com',
      'bob@example.com',
    ]);
    expect(first.groups.map((g) => g.loop_count)).toEqual([1, 3, 1]);
    expect(first.count).toBe(5);
    // Determinism: a second call ranks identically.
    const second = await run();
    expect(second.groups.map((g) => g.counterparty)).toEqual(
      first.groups.map((g) => g.counterparty),
    );
  });

  test('N7-5: as_of pins the ranking clock, so the same rows give the same order at any wall-clock time', async () => {
    const T = Date.parse('2026-10-01T12:00:00Z');
    const D = 86_400_000;
    await upsertOpenLoop(engine, loop({ dedupKey: 'a', loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.org', detector: 'llm_extract', dueAt: new Date(T + 8 * D).toISOString() }));
    await upsertOpenLoop(engine, loop({ dedupKey: 'b', loopType: 'commitment_owed_to_me', counterpartyEmail: 'b@example.org', detector: 'llm_extract' }));
    await engine.executeRaw(
      `UPDATE open_loops SET opened_at = CASE dedup_key WHEN 'a' THEN $1::timestamptz ELSE $2::timestamptz END`,
      [new Date(T).toISOString(), new Date(T - 10 * D).toISOString()],
    );
    const order = async (asOf: string) =>
      ((await openLoopsOp.handler(ctx({ remote: true }), { as_of: asOf })) as GroupsResult & { as_of: string });
    const atT = await order(new Date(T).toISOString());
    const later = await order(new Date(T + 2 * D).toISOString());
    expect(atT.groups.map((g) => g.counterparty)).not.toEqual(later.groups.map((g) => g.counterparty));
    expect((await order(new Date(T).toISOString())).groups.map((g) => g.counterparty)).toEqual(atT.groups.map((g) => g.counterparty));
    expect(atT.as_of).toBe(new Date(T).toISOString());
    await expect(openLoopsOp.handler(ctx(), { as_of: 'yesterday' })).rejects.toThrow('as_of');
  });

  test('limit caps GROUPS (default 3) while count reports total loops', async () => {
    await seedRanked();
    // A fourth counterparty that ranks last.
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e03', counterpartyEmail: 'dave@example.com' }),
    );
    const res = (await openLoopsOp.handler(ctx({ remote: true }), {})) as GroupsResult;
    expect(res.groups).toHaveLength(3); // default group limit
    expect(res.count).toBe(6);
    expect(res.groups.map((g) => g.counterparty)).not.toContain('dave@example.com');

    const limited = (await openLoopsOp.handler(
      ctx({ remote: true }),
      { limit: 2 },
    )) as GroupsResult;
    expect(limited.groups).toHaveLength(2);
    expect(limited.count).toBe(6);
  });

  test('trusted local: loops carry quote and the result carries the injectable text', async () => {
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e01', counterpartyEmail: 'alice@example.com' }),
    );
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e02', counterpartyEmail: 'bob@example.com' }),
    );
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(res.redacted).toBe(false);
    expect(res.text).toBeDefined();
    expect(res.text!).toContain('people are waiting on you');
    expect(res.text!).toContain('Can you review the plan?'); // the quote line
    for (const g of res.groups) {
      expect(g.loops[0].quote).toBe('Can you review the plan?');
    }
  });

  test('REGRESSION: trusted grouped output survives a due-dated loop (timestamptz Date normalization)', async () => {
    // due_at comes back from the engine as a JS Date; normalizeRow must
    // string-ify it or renderText's `due_at.slice(0, 10)` crashes the
    // default CLI path the moment the LLM extractor sets a due date.
    await upsertOpenLoop(
      engine,
      loop({
        threadId: '18c2f4a9b3d21e0f',
        loopType: 'commitment_owed_by_me',
        dedupKey: 'commit:duedated1',
        detector: 'llm_extract',
        dueAt: '2026-09-01T23:59:59Z',
        summary: 'Send the deck',
      }),
    );
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(res.text).toBeDefined();
    expect(res.text!).toContain('due 2026-09-01');
    const withDue = res.groups.flatMap((g) => g.loops).find((l) => l.due_at);
    expect(typeof withDue!.due_at).toBe('string');
  });

  test('trusted local zero-loop case: text says you are clean', async () => {
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(res.groups).toEqual([]);
    expect(res.count).toBe(0);
    expect(res.text).toContain('You are clean');
  });

  test('remote: redacted, and NO quote/deep_link/text fields anywhere in the payload', async () => {
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e01', counterpartyEmail: 'alice@example.com' }),
    );
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e02', counterpartyEmail: 'bob@example.com' }),
    );
    const res = (await openLoopsOp.handler(ctx({ remote: true }), {})) as GroupsResult;
    expect(res.redacted).toBe(true);
    expect('text' in res).toBe(false);
    const json = JSON.stringify(res);
    expect(json).not.toContain('"quote"');
    expect(json).not.toContain('"deep_link"');
    expect(json).not.toContain('Can you review the plan?');
  });
});

describe('open_loops deep links + context (trusted local)', () => {
  const EMAIL_SLUG = 'emails/2026/08/2026-08-20-plan-review-abcd1234';

  test('deep_link regenerates from the page account + hex message-id evidence', async () => {
    // The thread page carries the account in frontmatter; the loop points at
    // it via page_slug and carries a hex message_id in evidence.
    await engine.putPage(
      EMAIL_SLUG,
      {
        type: 'email',
        title: 'Plan review',
        compiled_truth: 'Synthetic thread body.',
        frontmatter: { account: 'a@example.com', thread_id: '18c2f4a9b3d21e07' },
      },
      { sourceId: 'g1' },
    );
    await upsertOpenLoop(
      engine,
      loop({ counterpartyEmail: 'bob@example.com', pageSlug: EMAIL_SLUG }),
    );
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(res.groups).toHaveLength(1);
    const view = res.groups[0].loops[0] as { deep_link?: string; quote?: string };
    expect(view.deep_link).toBeDefined();
    // Code-generated Gmail deep link: the evidence message id + authuser account.
    expect(view.deep_link!).toContain('#inbox/18c2f4a9b3d21e07');
    expect(view.deep_link!).toContain('authuser=a%40example.com');
    // The injectable text digest carries the link too.
    expect(res.text!).toContain('mail.google.com');
  });

  test('no deep_link without a page account (link degrades to none, loop still lands)', async () => {
    await upsertOpenLoop(
      engine,
      loop({ counterpartyEmail: 'bob@example.com', pageSlug: 'emails/never-imported.md' }),
    );
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    const view = res.groups[0].loops[0] as { deep_link?: string; quote?: string };
    expect(view.deep_link).toBeUndefined();
    expect(view.quote).toBe('Can you review the plan?'); // quote is independent of the link
  });

  test('include_context attaches the counterparty entity card when the person page exists', async () => {
    await engine.putPage(
      'people/bob-example',
      { type: 'person', title: 'Bob Example', compiled_truth: 'A synthetic person page for context.' },
      { sourceId: 'g1' },
    );
    await upsertOpenLoop(
      engine,
      loop({ counterpartyEmail: 'bob@example.com', counterpartySlug: 'people/bob-example' }),
    );
    const withCtx = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(withCtx.groups).toHaveLength(1);
    expect(withCtx.groups[0].context).toBeDefined();
    // include_context: false omits the card.
    const without = (await openLoopsOp.handler(
      ctx({ remote: false }),
      { include_context: false },
    )) as GroupsResult;
    expect(without.groups[0].context).toBeUndefined();
  });
});

describe('open_loops unscoped remote read (fail-closed)', () => {
  test('remote ctx with NO sourceId and NO allowedSources is denied (permission_denied)', async () => {
    // The CLAUDE.md "Trust is fail-closed" invariant, enforced at the op
    // layer: an untrusted caller with no resolved scope must see NOTHING —
    // shipped transports refuse unscoped remote calls upstream, but the op
    // does not rely on them. Before this guard, {} from sourceScopeOpts()
    // spanned EVERY source in the brain (redacted but cross-source).
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('g2', 'g2', '{"kind":"google"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e01', counterpartyEmail: 'alice@example.com' }),
    ); // lands in g1
    await upsertOpenLoop(
      engine,
      loop({
        sourceId: 'g2',
        threadId: '18c2f4a9b3d21e02',
        counterpartyEmail: 'eve@example.com',
      }),
    );
    await expect(
      openLoopsOp.handler(ctx({ remote: true, sourceId: undefined }), { group_by: 'none' }),
    ).rejects.toThrow(/resolved source scope/);
    // A scoped remote caller still reads (redacted) within its grant.
    const scoped = (await openLoopsOp.handler(
      ctx({ remote: true, sourceId: 'g2' }),
      { group_by: 'none' },
    )) as { loops: Array<{ counterparty_email: string }>; count: number; redacted: boolean; sources: Array<{ id: string }> };
    expect(scoped.count).toBe(1);
    expect(scoped.loops[0].counterparty_email).toBe('eve@example.com');
    expect(scoped.redacted).toBe(true);
    expect(scoped.sources.map((s) => s.id)).toEqual(['g2']);
  });
});

describe('open_loops google-source freshness', () => {
  test('google source with last_sync_at 3 days old → stale: true', async () => {
    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = now() - interval '3 days' WHERE id = 'g1'`,
    );
    const res = (await openLoopsOp.handler(ctx(), {})) as GroupsResult;
    expect(res.stale).toBe(true);
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].id).toBe('g1');
    expect(res.sources[0].stale).toBe(true);
    expect(res.text).toContain('out of date');
  });

  test('freshly synced google source → stale: false', async () => {
    const res = (await openLoopsOp.handler(ctx(), {})) as GroupsResult;
    expect(res.stale).toBe(false);
    expect(res.sources[0].stale).toBe(false);
  });

  test('non-google sources are ignored by the freshness check', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at)
       VALUES ('plain', 'plain', '{}'::jsonb, now() - interval '30 days')
       ON CONFLICT (id) DO NOTHING`,
    );
    const res = (await openLoopsOp.handler(ctx({ sourceId: 'plain' }), {})) as GroupsResult;
    expect(res.sources).toEqual([]);
    expect(res.stale).toBe(false);
  });
});

describe('open_loops group_by none (flat)', () => {
  test('flat list respects limit, count reports total', async () => {
    for (let i = 1; i <= 5; i++) {
      await upsertOpenLoop(
        engine,
        loop({
          threadId: `18c2f4a9b3d21e0${i}`,
          counterpartyEmail: `p${i}@example.com`,
          lastActivityAt: new Date(Date.now() - i * 3_600_000).toISOString(),
        }),
      );
    }
    const res = (await openLoopsOp.handler(ctx(), { group_by: 'none', limit: 2 })) as {
      loops: Array<{ counterparty_email: string; quote?: string }>;
      count: number;
      redacted: boolean;
    };
    expect(res.loops).toHaveLength(2);
    expect(res.count).toBe(5);
    // Ordered by last_activity_at DESC → the two newest.
    expect(res.loops.map((l) => l.counterparty_email)).toEqual([
      'p1@example.com',
      'p2@example.com',
    ]);
    // Trusted flat view still carries quotes.
    expect(res.loops[0].quote).toBe('Can you review the plan?');
    expect(res.redacted).toBe(false);
  });

  test('remote flat view is redacted', async () => {
    await upsertOpenLoop(engine, loop());
    const res = (await openLoopsOp.handler(ctx({ remote: true }), { group_by: 'none' })) as {
      loops: Array<Record<string, unknown>>;
      redacted: boolean;
    };
    expect(res.redacted).toBe(true);
    expect(JSON.stringify(res)).not.toContain('"quote"');
  });
});

describe('open_loops no_google_sources honesty', () => {
  test('scope with NO google source + zero loops → no_google_sources:true and the honest "nothing to read" digest, never "You are clean"', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('plain', 'plain', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    const res = (await openLoopsOp.handler(ctx({ sourceId: 'plain' }), {})) as GroupsResult & {
      no_google_sources: boolean;
    };
    expect(res.groups).toEqual([]);
    expect(res.no_google_sources).toBe(true);
    expect(res.text).toContain('No google source is connected');
    expect(res.text).not.toContain('You are clean');
    // The empty-scope freshness set must not read as stale either.
    expect(res.sources).toEqual([]);
    expect(res.stale).toBe(false);
  });

  test('no_google_sources reflects the SOURCES in scope, not the loop count: loops in a non-google source still set it true', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('plain', 'plain', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertOpenLoop(engine, loop({ sourceId: 'plain' }));
    const res = (await openLoopsOp.handler(ctx({ sourceId: 'plain' }), {})) as GroupsResult & {
      no_google_sources: boolean;
    };
    expect(res.groups).toHaveLength(1);
    expect(res.no_google_sources).toBe(true);
    // Non-empty groups render the normal digest; the flag stays for callers.
    expect(res.text).toContain('waiting on you');
  });

  test('google source present + zero loops → no_google_sources:false and "You are clean"', async () => {
    const res = (await openLoopsOp.handler(ctx(), {})) as GroupsResult & {
      no_google_sources: boolean;
    };
    expect(res.no_google_sources).toBe(false);
    expect(res.text).toContain('You are clean');
    expect(res.text).not.toContain('No google source is connected');
  });
});

describe('open_loops per-call scope (source_id / all_sources)', () => {
  interface FlatResult {
    loops: Array<{ counterparty_email: string | null }>;
    count: number;
    sources: Array<{ id: string }>;
    redacted: boolean;
  }

  async function seedTwoGoogleSources(): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at)
       VALUES ('g2', 'g2', '{"kind":"google"}'::jsonb, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e01', counterpartyEmail: 'alice@example.com' }),
    ); // g1
    await upsertOpenLoop(
      engine,
      loop({ sourceId: 'g2', threadId: '18c2f4a9b3d21e02', counterpartyEmail: 'eve@example.com' }),
    );
  }

  test('trusted local source_id narrows to that source (loops AND freshness)', async () => {
    await seedTwoGoogleSources();
    const res = (await openLoopsOp.handler(ctx(), {
      source_id: 'g2',
      group_by: 'none',
    })) as FlatResult;
    expect(res.count).toBe(1);
    expect(res.loops[0].counterparty_email).toBe('eve@example.com');
    expect(res.sources.map((s) => s.id)).toEqual(['g2']);
    expect(res.redacted).toBe(false);
  });

  test('remote out-of-grant source_id → permission_denied, nothing returned', async () => {
    await seedTwoGoogleSources();
    await expect(
      openLoopsOp.handler(
        ctx({
          remote: true,
          sourceId: undefined,
          auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['g1'] },
        }),
        { source_id: 'g2', group_by: 'none' },
      ),
    ).rejects.toThrow(/outside your granted sources/);
  });

  test('remote SCALAR-scoped caller: source_id outside the scalar grant → permission_denied; same-source allowed', async () => {
    // Tighter than the shared resolveRequestedScope (whose other consumers
    // apply page-visibility filtering): loop summaries derive from private
    // email, so a scalar-scoped remote caller must not widen via source_id.
    await seedTwoGoogleSources();
    await expect(
      openLoopsOp.handler(
        ctx({ remote: true, sourceId: 'g1' }),
        { source_id: 'g2', group_by: 'none' },
      ),
    ).rejects.toThrow(/outside your granted sources/);
    const same = (await openLoopsOp.handler(
      ctx({ remote: true, sourceId: 'g1' }),
      { source_id: 'g1', group_by: 'none' },
    )) as { count: number; redacted: boolean };
    expect(same.redacted).toBe(true);
    expect(same.count).toBeGreaterThanOrEqual(0);
  });

  test('remote source_id INSIDE the grant narrows to it (redacted)', async () => {
    await seedTwoGoogleSources();
    const res = (await openLoopsOp.handler(
      ctx({
        remote: true,
        sourceId: undefined,
        auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['g1', 'g2'] },
      }),
      { source_id: 'g2', group_by: 'none' },
    )) as FlatResult;
    expect(res.count).toBe(1);
    expect(res.loops[0].counterparty_email).toBe('eve@example.com');
    expect(res.sources.map((s) => s.id)).toEqual(['g2']);
    expect(res.redacted).toBe(true);
    expect(JSON.stringify(res)).not.toContain('"quote"');
  });

  test('all_sources trusted local spans the whole brain', async () => {
    await seedTwoGoogleSources();
    const res = (await openLoopsOp.handler(ctx(), {
      all_sources: true,
      group_by: 'none',
    })) as FlatResult;
    expect(res.count).toBe(2);
    expect(res.loops.map((l) => l.counterparty_email).sort()).toEqual([
      'alice@example.com',
      'eve@example.com',
    ]);
    expect(res.sources.map((s) => s.id).sort()).toEqual(['g1', 'g2']);
  });

  test('all_sources from a remote caller stays inside its grant', async () => {
    await seedTwoGoogleSources();
    const res = (await openLoopsOp.handler(
      ctx({
        remote: true,
        sourceId: undefined,
        auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['g1'] },
      }),
      { all_sources: true, group_by: 'none' },
    )) as FlatResult;
    expect(res.count).toBe(1);
    expect(res.loops[0].counterparty_email).toBe('alice@example.com');
    expect(res.sources.map((s) => s.id)).toEqual(['g1']);
    expect(res.redacted).toBe(true);
  });

  test('all_sources from a remote caller with NO grant fail-closes (permission_denied)', async () => {
    await seedTwoGoogleSources();
    await expect(
      openLoopsOp.handler(ctx({ remote: true, sourceId: undefined }), {
        all_sources: true,
        group_by: 'none',
      }),
    ).rejects.toThrow(/resolved source scope/);
  });
});

describe('open_loops single-loop lookup by id (#5870)', () => {
  interface LookupFlat {
    loops: Array<{ id: number; status: string; quote?: string; deep_link?: string }>;
    count: number;
    redacted: boolean;
  }

  /**
   * g1: one aged loop (2019) behind 510 newer fillers, so it sits past the
   * op's 500-row internal fetch, plus one loop closed as `stale`.
   * g3: a second google source with one loop the g1-scoped callers must not see.
   */
  async function seedLookup(): Promise<{ aged: number; closed: number; foreign: number }> {
    const googleConfig = { kind: 'google' };
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, last_sync_at) VALUES ($1, $1, $2::jsonb, now()) ON CONFLICT (id) DO NOTHING`,
      ['g3', googleConfig],
    );
    const { id: aged } = await upsertOpenLoop(engine, loop({ threadId: 'cccc000000000001', counterpartyEmail: 'carol@example.com' }));
    await engine.executeRaw(`UPDATE open_loops SET last_activity_at = '2019-06-01T00:00:00Z' WHERE id = $1`, [aged]);
    await engine.executeRaw(
      `INSERT INTO open_loops (source_id, detector, loop_type, dedup_key, summary, counterparty_email, last_activity_at)
       SELECT 'g1', 'deterministic_thread', 'unanswered_inbound', 'thread:filler-' || n || ':unanswered_inbound',
              'Filler loop ' || n, 'filler' || n || '@example.com',
              now() - (n || ' minutes')::interval
       FROM generate_series(1, 510) AS n`,
    );
    const { id: closed } = await upsertOpenLoop(engine, loop({ threadId: 'cccc000000000002', counterpartyEmail: 'frank@example.com' }));
    await closeOpenLoop(engine, 'g1', closed, 'stale', 'staleness');
    const { id: foreign } = await upsertOpenLoop(engine, loop({ sourceId: 'g3', threadId: 'dddd000000000003', counterpartyEmail: 'dave@example.com' }));
    return { aged, closed, foreign };
  }

  const federated = (allowedSources: string[]) =>
    ctx({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources } });
  const flat = async (caller: OperationContext, params: Record<string, unknown>) =>
    (await openLoopsOp.handler(caller, { group_by: 'none', ...params })) as LookupFlat;

  test('trusted: a loop past the 500-row fetch comes back alone, with its quote', async () => {
    const { aged } = await seedLookup();
    const res = await flat(ctx(), { id: aged });
    expect(res.loops.map((l) => l.id)).toEqual([aged]);
    expect(res.count).toBe(1);
    expect(res.loops[0].status).toBe('open');
    expect(res.loops[0].quote).toBe('Can you review the plan?');
  });

  test('trusted: a closed (stale) loop is found with no status given', async () => {
    const { closed } = await seedLookup();
    const res = await flat(ctx(), { id: closed });
    expect(res.loops.map((l) => [l.id, l.status])).toEqual([[closed, 'stale']]);
  });

  test('explicit filters still narrow: status, loop_type and counterparty mismatches return nothing', async () => {
    const { closed, aged } = await seedLookup();
    expect((await flat(ctx(), { id: closed, status: 'open' })).count).toBe(0);
    expect((await flat(ctx(), { id: closed, status: 'stale' })).count).toBe(1);
    expect((await flat(ctx(), { id: aged, loop_type: 'commitment_owed_by_me' })).count).toBe(0);
    expect((await flat(ctx(), { id: aged, counterparty: 'someone-else@example.com' })).count).toBe(0);
    expect((await flat(ctx(), { id: aged, counterparty: 'carol@example.com' })).count).toBe(1);
  });

  test('trusted source_id still bounds the lookup: the g3 loop is not visible from g1', async () => {
    const { foreign } = await seedLookup();
    expect((await flat(ctx(), { id: foreign })).count).toBe(0);
    expect((await flat(ctx(), { id: foreign, source_id: 'g3' })).count).toBe(1);
  });

  test('deny: a foreign id reads exactly like a missing id for scalar and federated remote callers', async () => {
    const { foreign } = await seedLookup();
    const asOf = '2026-04-03T09:00:00.000Z';
    for (const caller of [ctx({ remote: true, sourceId: 'g1' }), federated(['g1'])]) {
      for (const group_by of ['none', 'counterparty'] as const) {
        const foreignRes = await openLoopsOp.handler(caller, { group_by, id: foreign, as_of: asOf });
        const missingRes = await openLoopsOp.handler(caller, { group_by, id: foreign + 900_000, as_of: asOf });
        expect(foreignRes).toEqual(missingRes);
        expect((foreignRes as { count: number }).count).toBe(0);
      }
    }
  });

  test('deny: a narrowed grant cannot reach the id through an out-of-grant source_id', async () => {
    const { foreign } = await seedLookup();
    await expect(flat(federated(['g1']), { id: foreign, source_id: 'g3' })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(flat(ctx({ remote: true, sourceId: 'g1' }), { id: foreign, source_id: 'g3' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('deny: an unscoped remote id lookup fails closed', async () => {
    const { aged } = await seedLookup();
    await expect(flat(ctx({ remote: true, sourceId: undefined }), { id: aged })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('allow: a grant covering the source finds the loop redacted (no quote, no deep link)', async () => {
    const { foreign } = await seedLookup();
    const res = await flat(federated(['g3']), { id: foreign });
    expect(res.loops.map((l) => l.id)).toEqual([foreign]);
    expect(res.redacted).toBe(true);
    expect(JSON.stringify(res)).not.toContain('"quote"');
    expect(JSON.stringify(res)).not.toContain('"deep_link"');
  });

  test.each([
    ['zero', 0],
    ['negative', -4],
    ['fractional', 3.25],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past the safe-integer range', 2 ** 53],
    ['a numeric string', '12'],
    ['a boolean', true],
    ['an object', { id: 1 }],
  ])('invalid id (%s) is refused with invalid_params before any read', async (_label, bad) => {
    await expect(openLoopsOp.handler(ctx(), { id: bad })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('the refusal renders the agent contract and does not echo the rejected value', async () => {
    const thrown = await openLoopsOp.handler(ctx({ remote: true }), { id: 31337.5 }).catch((e: unknown) => e);
    const env = toAgentError(thrown, { transport: 'stdio', op: 'open_loops', render: {
      transport: 'stdio', surface: 'full', isCallable: () => true, preapproved: () => false, routing: { brain: 'host', source: 'g1' },
    } });
    expect(env).toMatchObject({ code: 'invalid_params', class: 'caller', contract_version: 1 });
    expect(env.message).toBe('open_loops: id must be a whole number of 1 or more.');
    expect(env.suggestion).toContain('open_loops {"id": 42}');
    expect(JSON.stringify(env)).not.toContain('31337');
  });

  test('negative control: id absent or null keeps the list read and its open default', async () => {
    const { closed } = await seedLookup();
    for (const extra of [{}, { id: null }]) {
      const res = await flat(ctx(), { limit: 500, ...extra });
      expect(res.loops.length).toBe(500);
      expect(res.loops.some((l) => l.id === closed)).toBe(false);
      expect(res.loops.every((l) => l.status === 'open')).toBe(true);
    }
  });

  test('grouped: a lookup carries no text digest, while the trusted list keeps it', async () => {
    const { closed } = await seedLookup();
    const lookup = (await openLoopsOp.handler(ctx(), { id: closed })) as GroupsResult;
    expect(lookup.groups.flatMap((g) => g.loops.map((l) => l.id))).toEqual([closed]);
    expect(lookup.text).toBeUndefined();
    const missing = (await openLoopsOp.handler(ctx(), { id: closed + 900_000 })) as GroupsResult;
    expect(missing.count).toBe(0);
    expect(missing.text).toBeUndefined();
    const list = (await openLoopsOp.handler(ctx(), {})) as GroupsResult;
    expect(typeof list.text).toBe('string');
  });
});

describe('loops_close', () => {
  test('closes an open loop; the second close reports not_found_or_already_closed', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const res = (await loopsCloseOp.handler(ctx(), { id, status: 'done' })) as {
      closed: boolean;
      id: number;
      status: string;
      fact_expired: boolean;
    };
    expect(res.closed).toBe(true);
    expect(res.id).toBe(id);
    expect(res.status).toBe('done');
    expect(res.fact_expired).toBe(false);

    const again = (await loopsCloseOp.handler(ctx(), { id, status: 'done' })) as {
      closed: boolean;
      reason: string;
    };
    expect(again.closed).toBe(false);
    expect(again.reason).toBe('not_found_or_already_closed');
  });

  test('closing a loop with a fact_id expires the projected fact', async () => {
    const factRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ('g1', 'people/bob-example', 'Send the deck to bob', 'commitment', 'loops-test')
       RETURNING id`,
    );
    const factId = Number(factRows[0].id);
    const { id } = await upsertOpenLoop(
      engine,
      loop({
        dedupKey: 'commit:dddddddd',
        loopType: 'commitment_owed_by_me',
        detector: 'llm_extract',
        factId,
      }),
    );
    const res = (await loopsCloseOp.handler(ctx(), { id, status: 'done' })) as {
      closed: boolean;
      fact_expired: boolean;
    };
    expect(res.closed).toBe(true);
    expect(res.fact_expired).toBe(true);
    const expired = await engine.executeRaw<{ expired_at: unknown }>(
      `SELECT expired_at FROM facts WHERE id = $1`,
      [factId],
    );
    expect(expired[0].expired_at).not.toBeNull();
  });

  test('remote write-bound caller closes a loop in its write source even under a multi-source read grant (#5446)', async () => {
    const { id } = await upsertOpenLoop(engine, loop()); // lives in g1 = ctx.sourceId
    const res = (await loopsCloseOp.handler(
      ctx({
        remote: true,
        auth: {
          token: 't',
          clientId: 'c',
          scopes: ['write'],
          allowedSources: ['g1', 'g2'], // read federation — write stays g1
        },
      }),
      { id, status: 'done' },
    )) as { closed: boolean; status: string };
    expect(res.closed).toBe(true);
    expect(res.status).toBe('done');
  });

  test('remote caller cannot close a loop in a read-granted sibling source — identical answer to a missing id (#5446)', async () => {
    // Write source g1, read grant covers g1+g2, loop lives in g2: the
    // federated READ grant must never authorize the close+fact-expiry write.
    // The op does NOT cross-source SELECT — the close runs scoped to the
    // write source, so a foreign-source loop is indistinguishable from a
    // missing id and neither its existence nor its source name leaks.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('g2', 'g2', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    const { id } = await upsertOpenLoop(engine, loop({ sourceId: 'g2' }));
    const boundCtx = ctx({
      remote: true,
      auth: {
        token: 't',
        clientId: 'c',
        scopes: ['write'],
        allowedSources: ['g1', 'g2'], // read covers g2 — write does not
      },
    });
    const foreign = (await loopsCloseOp.handler(boundCtx, { id, status: 'done' })) as {
      closed: boolean; reason?: string;
    };
    const missing = (await loopsCloseOp.handler(boundCtx, { id: 999999, status: 'done' })) as {
      closed: boolean; reason?: string;
    };
    expect(foreign).toEqual(missing); // identical envelope — no existence/source disclosure
    expect(foreign.closed).toBe(false);
    expect(JSON.stringify(foreign)).not.toContain('g2');
    const rows = await listOpenLoops(engine, { sourceIds: ['g2'], status: 'open' });
    expect(rows).toHaveLength(1); // untouched
  });

  test('remote source_id param: equal to the write source → closes; anything else → permission_denied (#5446)', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const boundCtx = ctx({
      remote: true,
      auth: { token: 't', clientId: 'c', scopes: ['write'], allowedSources: ['g1', 'g2'] },
    });
    const res = (await loopsCloseOp.handler(boundCtx, {
      id,
      status: 'done',
      source_id: 'g1',
    })) as { closed: boolean };
    expect(res.closed).toBe(true);

    const { id: id2 } = await upsertOpenLoop(
      engine,
      loop({ threadId: '18c2f4a9b3d21e99', dedupKey: 'thread:18c2f4a9b3d21e99:unanswered_inbound' }),
    );
    // 'g2' is inside the READ grant — still not the write source.
    await expect(
      loopsCloseOp.handler(boundCtx, { id: id2, status: 'done', source_id: 'g2' }),
    ).rejects.toThrow(/permission_denied|outside the caller's write scope/);
  });

  test('remote ctx without any scope still throws permission_denied, loop untouched', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    // Denials are thrown OperationErrors (enumerated error envelope via
    // dispatch), never success-shaped { closed: false } payloads.
    await expect(
      loopsCloseOp.handler(
        ctx({
          remote: true,
          sourceId: undefined,
        }),
        { id, status: 'done' },
      ),
    ).rejects.toThrow(/permission_denied|bound write source/);
    const rows = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(rows).toHaveLength(1);
  });

  test('remote ctx WITH a single-source scope may close within it', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const res = (await loopsCloseOp.handler(ctx({ remote: true }), {
      id,
      status: 'dropped',
    })) as { closed: boolean; status: string };
    expect(res.closed).toBe(true);
    expect(res.status).toBe('dropped');
  });

  test('dry_run returns the action without closing', async () => {
    const { id } = await upsertOpenLoop(engine, loop());
    const res = (await loopsCloseOp.handler(ctx({ dryRun: true }), { id, status: 'done' })) as {
      dry_run: boolean;
      action: string;
    };
    expect(res.dry_run).toBe(true);
    expect(res.action).toBe('loops_close');
    expect(await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' })).toHaveLength(1);
  });
});

describe('loops_mute', () => {
  test('writes the suppression row lowercased', async () => {
    const res = (await loopsMuteOp.handler(ctx(), {
      kind: 'sender',
      value: 'Bob@Example.com',
    })) as { muted: boolean; value: string; source_id: string };
    expect(res.muted).toBe(true);
    expect(res.value).toBe('bob@example.com');
    expect(res.source_id).toBe('g1');
    const set = await loadSuppressions(engine, 'g1');
    expect(set.senders.has('bob@example.com')).toBe(true);
  });

  test('dry_run returns the action without writing', async () => {
    const res = (await loopsMuteOp.handler(ctx({ dryRun: true }), {
      kind: 'sender',
      value: 'bob@example.com',
    })) as { dry_run: boolean; action: string };
    expect(res.dry_run).toBe(true);
    expect(res.action).toBe('loops_mute');
    const set = await loadSuppressions(engine, 'g1');
    expect(set.senders.size).toBe(0);
  });

  test('thread mutes land in the threads set', async () => {
    await loopsMuteOp.handler(ctx(), { kind: 'thread', value: '18C2F4A9B3D21E07' });
    const set = await loadSuppressions(engine, 'g1');
    expect(set.threads.has('18c2f4a9b3d21e07')).toBe(true);
    expect(set.senders.size).toBe(0);
  });

  test('federated read grant does not confer write authority: write source mutes, read-only source refuses (#5446)', async () => {
    // Write-bound to g1, read-federated over other-src: the other-source
    // mute is a write the read grant cannot authorize, even though the
    // caller can read that source.
    const boundCtx = ctx({
      remote: true,
      auth: { token: 't', clientId: 'c', scopes: ['write'], allowedSources: ['other-src'] },
    });
    await expect(
      loopsMuteOp.handler(boundCtx, { kind: 'sender', value: 'bob@example.com', source_id: 'other-src' }),
    ).rejects.toThrow(/permission_denied|outside the caller's write scope/);
    const own = (await loopsMuteOp.handler(boundCtx, {
      kind: 'sender',
      value: 'bob@example.com',
    })) as { muted: boolean };
    expect(own.muted).toBe(true);
    expect((await loadSuppressions(engine, 'g1')).senders.has('bob@example.com')).toBe(true);
  });

  test('REGRESSION: scalar-scoped remote caller cannot mute a DIFFERENT source via p.source_id', async () => {
    // The shipped default transport shape is a scalar scope (ctx.sourceId,
    // no allowedSources). Before the fix, the guard only checked federated
    // arrays, so this wrote a suppression row into an arbitrary source —
    // targeted denial-of-loop-detection outside the caller's grant.
    await expect(
      loopsMuteOp.handler(
        ctx({ remote: true, sourceId: 'g1' }),
        { kind: 'sender', value: 'bob@example.com', source_id: 'g2' },
      ),
    ).rejects.toThrow(/permission_denied|outside the caller's write scope/);
    const set = await loadSuppressions(engine, 'g2');
    expect(set.senders.size).toBe(0);
    // Within its own scalar scope, the mute still works.
    const ok = (await loopsMuteOp.handler(
      ctx({ remote: true, sourceId: 'g1' }),
      { kind: 'sender', value: 'bob@example.com' },
    )) as { muted: boolean };
    expect(ok.muted).toBe(true);
  });

  test('omitted source_id on a non-google source → invalid_params, no dead suppression (#5446)', async () => {
    // The reporter's 4 dead mutes: a remote caller bound to 'workspace'
    // (no Google content) planted suppression rows the detector could
    // never consult.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('workspace', 'workspace', '{"kind":"files"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await expect(
      loopsMuteOp.handler(
        ctx({ remote: true, sourceId: 'workspace' }),
        { kind: 'sender', value: 'bob@example.com' },
      ),
    ).rejects.toThrow(/no Google content|invalid_params/);
    expect((await loadSuppressions(engine, 'workspace')).senders.size).toBe(0);
  });

  test('explicit source_id naming a non-google source is honored (deliberate scope)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('workspace', 'workspace', '{"kind":"files"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    const res = (await loopsMuteOp.handler(
      ctx({ remote: true, sourceId: 'workspace' }),
      { kind: 'sender', value: 'bob@example.com', source_id: 'workspace' },
    )) as { muted: boolean };
    expect(res.muted).toBe(true);
    expect((await loadSuppressions(engine, 'workspace')).senders.has('bob@example.com')).toBe(true);
  });
});

describe('loops_unmute', () => {
  test('removes the row loops_mute wrote and reports removed:true', async () => {
    await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'Bob@Example.com' });
    const res = (await loopsUnmuteOp.handler(ctx(), {
      kind: 'sender',
      value: 'BOB@example.COM',
    })) as { removed: boolean; value: string; source_id: string };
    expect(res.removed).toBe(true);
    expect(res.value).toBe('bob@example.com');
    expect(res.source_id).toBe('g1');
    expect((await loadSuppressions(engine, 'g1')).senders.size).toBe(0);
  });

  test('a second unmute reports removed:false with a reason, and does not throw', async () => {
    await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'bob@example.com' });
    await loopsUnmuteOp.handler(ctx(), { kind: 'sender', value: 'bob@example.com' });
    const res = (await loopsUnmuteOp.handler(ctx(), {
      kind: 'sender',
      value: 'bob@example.com',
    })) as { removed: boolean; reason?: string };
    expect(res.removed).toBe(false);
    expect(res.reason).toContain('no matching suppression');
  });

  test('dry_run returns the action without removing', async () => {
    await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'bob@example.com' });
    const res = (await loopsUnmuteOp.handler(ctx({ dryRun: true }), {
      kind: 'sender',
      value: 'bob@example.com',
    })) as { dry_run: boolean; action: string };
    expect(res.dry_run).toBe(true);
    expect(res.action).toBe('loops_unmute');
    expect((await loadSuppressions(engine, 'g1')).senders.has('bob@example.com')).toBe(true);
  });

  test('kind is exact: unmuting a sender leaves the same value muted as a thread', async () => {
    await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'shared-value' });
    await loopsMuteOp.handler(ctx(), { kind: 'thread', value: 'shared-value' });
    await loopsUnmuteOp.handler(ctx(), { kind: 'sender', value: 'shared-value' });
    const set = await loadSuppressions(engine, 'g1');
    expect(set.senders.has('shared-value')).toBe(false);
    expect(set.threads.has('shared-value')).toBe(true);
  });

  test('federated read grant does not confer write authority on unmute either (#5446)', async () => {
    // Write-bound to g1, read-federated over other-src: lifting g1's mute is
    // the caller's own write domain; lifting a read-only source's is not.
    await loopsMuteOp.handler(ctx(), { kind: 'sender', value: 'bob@example.com' });
    const boundCtx = ctx({
      remote: true,
      auth: { token: 't', clientId: 'c', scopes: ['write'], allowedSources: ['other-src'] },
    });
    await expect(
      loopsUnmuteOp.handler(boundCtx, { kind: 'sender', value: 'bob@example.com', source_id: 'other-src' }),
    ).rejects.toThrow(/permission_denied|outside the caller's write scope/);
    const res = (await loopsUnmuteOp.handler(boundCtx, {
      kind: 'sender',
      value: 'bob@example.com',
    })) as { removed: boolean };
    expect(res.removed).toBe(true);
    expect((await loadSuppressions(engine, 'g1')).senders.has('bob@example.com')).toBe(false);
  });

  test('REGRESSION: scalar-scoped remote caller cannot unmute a DIFFERENT source via p.source_id', async () => {
    // Mirrors the loops_mute guard: lifting another source's suppression is
    // just as much a targeted write as planting one — it re-opens the noise
    // channel that source's owner deliberately silenced.
    // This file's fixture seeds only g1; the sibling source is local to this test.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('g2', 'g2', '{"kind":"google"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await loopsMuteOp.handler(ctx({ sourceId: 'g2' }), { kind: 'sender', value: 'bob@example.com' });
    await expect(
      loopsUnmuteOp.handler(
        ctx({ remote: true, sourceId: 'g1' }),
        { kind: 'sender', value: 'bob@example.com', source_id: 'g2' },
      ),
    ).rejects.toThrow(/permission_denied|outside the caller's write scope/);
    expect((await loadSuppressions(engine, 'g2')).senders.has('bob@example.com')).toBe(true);
  });

  test('omitted source_id on a non-google source → invalid_params (#5446)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('workspace', 'workspace', '{"kind":"files"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await expect(
      loopsUnmuteOp.handler(
        ctx({ remote: true, sourceId: 'workspace' }),
        { kind: 'sender', value: 'bob@example.com' },
      ),
    ).rejects.toThrow(/no Google content|invalid_params/);
  });
});

// #5871: loops with no counterparty (decision_pending and the like) are not a
// person. They used to group under 'unknown' and rank first by sheer count.
describe('open_loops no-counterparty loops and the per-group cap (#5871)', () => {
  interface CappedResult extends GroupsResult {
    groups: Array<GroupsResult['groups'][number] & { loops_omitted: number }>;
    no_counterparty: { loop_count: number; by_type: Record<string, number>; loops: Array<Record<string, unknown>>; loops_omitted: number } | null;
  }
  async function seedPile(): Promise<void> {
    for (let i = 0; i < 9; i++) {
      await upsertOpenLoop(engine, loop({ dedupKey: `decision:${i}`, loopType: 'decision_pending', counterpartyEmail: null,
        threadId: null, summary: `Decide on vendor option ${i}`, detector: 'llm_extract' }));
    }
    for (let i = 0; i < 8; i++) {
      await upsertOpenLoop(engine, loop({ threadId: `18c2f4a9b3d21f${String(i).padStart(2, '0')}`, counterpartyEmail: 'bob@example.com',
        summary: `Reply owed to bob@example.com: thread ${i}` }));
    }
    await upsertOpenLoop(engine, loop({ threadId: '18c2f4a9b3d21e99', counterpartyEmail: 'alice@example.com', summary: 'Reply owed to alice@example.com' }));
  }

  for (const remote of [false, true]) {
    test(`${remote ? 'remote' : 'trusted'}: no-counterparty loops sit beside the people, never ranked, and each group shows at most 5`, async () => {
      await seedPile();
      const r = (await openLoopsOp.handler(ctx({ remote }), {})) as CappedResult;
      expect(r.groups.map((g) => g.counterparty)).toEqual(['bob@example.com', 'alice@example.com']);
      expect(r.groups[0]).toMatchObject({ loop_count: 8, loops_omitted: 3 });
      expect(r.groups[0].loops).toHaveLength(5);
      expect(r.no_counterparty).toMatchObject({ loop_count: 9, by_type: { decision_pending: 9 }, loops_omitted: 4 });
      expect(r.no_counterparty!.loops).toHaveLength(5);
      expect(r.count).toBe(18);
      if (!remote) {
        expect(r.text).toContain('2 people are waiting on you');
        expect(r.text).not.toContain('## unknown');
        expect(r.text).toContain('+3 more');
        expect(r.text).toContain('## No counterparty (9 open: decision_pending 9)');
      }
    });
  }

  test('the group cap shows the due-soonest loop first', async () => {
    for (let i = 0; i < 6; i++) {
      await upsertOpenLoop(engine, loop({ threadId: `18c2f4a9b3d21a${String(i).padStart(2, '0')}`, summary: `Reply ${i}`,
        ...(i === 5 ? { dueAt: new Date(Date.now() + 86_400_000).toISOString() } : {}) }));
    }
    const r = (await openLoopsOp.handler(ctx({ remote: true }), {})) as CappedResult;
    expect(r.groups[0].loops[0].summary).toBe('Reply 5');
    expect(r.groups[0].loops_omitted).toBe(1);
  });

  test('only no-counterparty loops: no person is waiting, and the digest never says you are clean', async () => {
    await upsertOpenLoop(engine, loop({ dedupKey: 'decision:solo', loopType: 'decision_pending', counterpartyEmail: null, threadId: null,
      summary: 'Decide on the offsite venue', detector: 'llm_extract' }));
    const r = (await openLoopsOp.handler(ctx(), {})) as CappedResult;
    expect(r.groups).toEqual([]);
    expect(r.no_counterparty).toMatchObject({ loop_count: 1, loops_omitted: 0 });
    expect(r.text).not.toContain('You are clean');
    expect(r.text).toContain('## No counterparty (1 open: decision_pending 1)');
  });
});
