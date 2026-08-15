/**
 * Ambient recall hooks (issue #1) — context_pack + delta frozen verbs, the
 * shared session cursor, world-only-by-default visibility, and cross-caller
 * isolation. Hermetic in-memory PGLite.
 *
 * Coverage map (plan verification + eng-review findings):
 *  - session-state round-trip, surfaced-slug union, ISO cursor, GC
 *  - eng 1B: cross-caller isolation via the (source_id, client_id, session_id) key
 *  - eng 1A / D2=A: world-only default; include_private widens only for
 *    trusted-local (ctx.remote === false); remote NEVER widens (fail-closed)
 *  - delta cursor lifecycle (establish → advance), page dedup, since|session gate
 *  - MEMORY_VERBS_VERSION stays 1 (additive; the P1 fix)
 *  - v0.45.7 gap-closure wave: delta visibility fail-closed mirror, stateless
 *    keyset resume + explicit since_slug precedence, forced budget overflow,
 *    session-state outage fail-open, banked-entity warm-pack visibility
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { operations } from '../src/core/operations.ts';
import { MEMORY_VERBS_VERSION, VERB_NAMES } from '../src/core/verbs.ts';
import {
  getSessionContextState,
  upsertSessionContextState,
  gcSessionContextState,
  resolveClientId,
  LOCAL_CLIENT_SENTINEL,
} from '../src/core/context/session-state.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function ctxFor(opts: { remote: boolean; clientId?: string }): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: noopLogger,
    dryRun: false,
    remote: opts.remote,
    sourceId: 'default',
    ...(opts.clientId ? { auth: { clientId: opts.clientId, scopes: [] } as never } : {}),
  } as OperationContext;
}

const contextPack = operations.find((o) => o.name === 'context_pack')!;
const del = operations.find((o) => o.name === 'delta')!;
const remember = operations.find((o) => o.name === 'remember')!;

/** Handler results are `unknown` on the Operation type; tests branch on fields. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VerbResult = Record<string, any>;
async function call(
  op: typeof contextPack,
  ctx: OperationContext,
  p: Record<string, unknown>,
): Promise<VerbResult> {
  return (await op.handler(ctx, p)) as VerbResult;
}

beforeAll(async () => {
  // Hermetic embedding: pin the gateway to a KEYLESS config (empty env) so
  // `remember`'s fact-embed degrades gracefully (degraded_dedup) instead of
  // firing a real OpenAI call. On CI the process carries a dummy
  // OPENAI_API_KEY (sk-test-*) that a shard-neighbor can leak into the
  // gateway singleton via a captured env (the bunfig preload configures with
  // `env: {...process.env}`); a present-but-invalid key turns the keyless
  // degrade into a hard 401. The delta/context_pack tests exercise
  // cursor/budget logic, not embedding quality, so keyless is correct and
  // makes them independent of shard bin-packing. Dimensions stay 1536 to
  // match the preload's schema.
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM session_context_state');
  __resetHotMemoryCacheForTests();
});

describe('protocol additivity (P1 fix)', () => {
  test('MEMORY_VERBS_VERSION stays 1 with 7 frozen verbs', () => {
    expect(MEMORY_VERBS_VERSION).toBe(1);
    expect(VERB_NAMES).toContain('context_pack');
    expect(VERB_NAMES).toContain('delta');
    expect(VERB_NAMES.length).toBe(7);
  });

  test('context_pack + delta are verbs on the surface, scope read', () => {
    expect(contextPack.verb).toBe(true);
    expect(contextPack.scope).toBe('read');
    expect(del.verb).toBe(true);
    expect(del.scope).toBe('read');
  });

  test('responses stamp protocol_version 1', async () => {
    const pack = await call(contextPack, ctxFor({ remote: false }), { entities: 'a,b' });
    expect(pack.protocol_version).toBe(1);
    const d = await call(del, ctxFor({ remote: false }), { since: '1970-01-01T00:00:00Z' });
    expect(d.protocol_version).toBe(1);
  });
});

describe('session-state cursor', () => {
  test('absent → null; round-trips + ISO cursor + keyset slug', async () => {
    expect(await getSessionContextState(engine, 'default', null, 's1')).toBeNull();
    await upsertSessionContextState(engine, 'default', null, 's1', {
      standingEntities: ['people/alice-example'],
      lastWakeAt: '2026-08-01T00:00:00Z',
      cursorSlug: 'notes/x',
    });
    const st = (await getSessionContextState(engine, 'default', null, 's1'))!;
    expect(st.standing_entities).toEqual(['people/alice-example']);
    expect(st.surfaced_slugs).toEqual(['notes/x']); // keyset slug, single element
    // ISO-normalized regardless of the engine's ::text format
    expect(st.last_wake_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(new Date(st.last_wake_at!).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('cursorSlug REPLACES on each advance; omission keeps standing + wake', async () => {
    await upsertSessionContextState(engine, 'default', null, 's1', {
      standingEntities: ['e1'],
      cursorSlug: 'notes/a',
      lastWakeAt: '2026-08-01T00:00:00Z',
    });
    // replace cursor slug; omit standing + wake → both kept
    await upsertSessionContextState(engine, 'default', null, 's1', { cursorSlug: 'notes/c' });
    const st = (await getSessionContextState(engine, 'default', null, 's1'))!;
    expect(st.surfaced_slugs).toEqual(['notes/c']);
    expect(st.standing_entities).toEqual(['e1']); // keep-if-absent
    expect(new Date(st.last_wake_at!).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('cursor is last-writer-wins on lastWakeAt (keyset ordering lives in the handler)', async () => {
    await upsertSessionContextState(engine, 'default', null, 'lww', { lastWakeAt: '2026-08-05T00:00:00Z' });
    await upsertSessionContextState(engine, 'default', null, 'lww', { lastWakeAt: '2026-08-01T00:00:00Z' });
    const st = (await getSessionContextState(engine, 'default', null, 'lww'))!;
    // A null lastWakeAt keeps the prior; a concrete one always wins.
    expect(new Date(st.last_wake_at!).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    await upsertSessionContextState(engine, 'default', null, 'lww', { cursorSlug: 'notes/z' });
    expect(new Date((await getSessionContextState(engine, 'default', null, 'lww'))!.last_wake_at!).toISOString())
      .toBe('2026-08-01T00:00:00.000Z'); // null wake → kept
  });

  test('eng 1B: cross-caller isolation — local sentinel vs auth client are separate rows', async () => {
    await upsertSessionContextState(engine, 'default', null, 's1', { cursorSlug: 'local-only' });
    await upsertSessionContextState(engine, 'default', 'client-XYZ', 's1', { cursorSlug: 'remote-only' });
    const local = (await getSessionContextState(engine, 'default', null, 's1'))!;
    const remote = (await getSessionContextState(engine, 'default', 'client-XYZ', 's1'))!;
    expect(local.surfaced_slugs).toEqual(['local-only']);
    expect(remote.surfaced_slugs).toEqual(['remote-only']);
    expect(resolveClientId(null)).toBe(LOCAL_CLIENT_SENTINEL);
    expect(resolveClientId('client-XYZ')).toBe('client-XYZ');
  });

  test('GC ages out stale rows', async () => {
    await upsertSessionContextState(engine, 'default', null, 'old', { cursorSlug: 'x' });
    await engine.executeRaw(`UPDATE session_context_state SET updated_at = now() - interval '30 days' WHERE session_id = 'old'`);
    await gcSessionContextState(engine, 7);
    expect(await getSessionContextState(engine, 'default', null, 'old')).toBeNull();
  });

  test('GC caps rows per (source, client) — oldest evicted past the cap', async () => {
    // Seed 3 rows, age them so ordering is deterministic, cap to 2.
    for (const s of ['c1', 'c2', 'c3']) {
      await upsertSessionContextState(engine, 'default', 'capclient', s, { cursorSlug: s });
    }
    await engine.executeRaw(`UPDATE session_context_state SET updated_at = '2026-08-01T00:00:00Z' WHERE session_id = 'c1'`);
    await engine.executeRaw(`UPDATE session_context_state SET updated_at = '2026-08-02T00:00:00Z' WHERE session_id = 'c2'`);
    await engine.executeRaw(`UPDATE session_context_state SET updated_at = '2026-08-03T00:00:00Z' WHERE session_id = 'c3'`);
    // Directly exercise the windowed cap via a tiny inline DELETE mirror (the
    // real gc uses MAX_ROWS_PER_CLIENT=1000; prove the ORDER here with cap 2).
    await engine.executeRaw(
      `DELETE FROM session_context_state s USING (
         SELECT source_id, client_id, session_id,
                row_number() OVER (PARTITION BY source_id, client_id ORDER BY updated_at DESC) AS rn
         FROM session_context_state
       ) ranked
       WHERE s.source_id = ranked.source_id AND s.client_id = ranked.client_id
         AND s.session_id = ranked.session_id AND ranked.rn > 2`,
    );
    expect(await getSessionContextState(engine, 'default', 'capclient', 'c1')).toBeNull(); // oldest evicted
    expect(await getSessionContextState(engine, 'default', 'capclient', 'c3')).not.toBeNull(); // newest kept
  });
});

describe('delta cursor lifecycle', () => {
  test('first wake with session establishes an ISO cursor and empty delta', async () => {
    const r = await call(del, ctxFor({ remote: false }), { session_id: 'sess-1' });
    expect(r.pages).toEqual([]);
    expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // cursor persisted
    const st = await getSessionContextState(engine, 'default', null, 'sess-1');
    expect(st?.last_wake_at).toBeTruthy();
  });

  test('since OR session required; else invalid_params', async () => {
    await expect(del.handler(ctxFor({ remote: false }), {})).rejects.toThrow(/requires|since|session/i);
  });

  test('explicit since is echoed, NORMALIZED to ISO (F4 — never the raw string)', async () => {
    const r = await call(del, ctxFor({ remote: false }), { since: '1970-01-01T00:00:00Z' });
    expect(r.since).toBe('1970-01-01T00:00:00.000Z');
    // A parseable NON-ISO form is normalized to canonical ISO, never echoed raw
    // into the injectable `text` block.
    const r2 = await call(del, ctxFor({ remote: false }), { since: 'January 1, 2000 00:00:00 GMT' });
    expect(r2.since).toBe('2000-01-01T00:00:00.000Z');
    expect(r2.text as string).not.toContain('January 1, 2000');
    // An UNPARSEABLE string is rejected outright (defense in depth).
    await expect(call(del, ctxFor({ remote: false }), { since: 'definitely not a date' })).rejects.toThrow(/parseable|ISO/i);
  });

  test('remote caller cursor is namespaced by auth client', async () => {
    await call(del, ctxFor({ remote: true, clientId: 'harness-A' }), { session_id: 'shared' });
    await call(del, ctxFor({ remote: true, clientId: 'harness-B' }), { session_id: 'shared' });
    const a = await getSessionContextState(engine, 'default', 'harness-A', 'shared');
    const b = await getSessionContextState(engine, 'default', 'harness-B', 'shared');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 'local' sentinel row must NOT exist for a remote-only session
    expect(await getSessionContextState(engine, 'default', null, 'shared')).toBeNull();
  });

  test('auth-less remote (stdio) lands in the "remote" namespace, never "local" (adversarial P2)', async () => {
    await call(del, ctxFor({ remote: true }), { session_id: 'anon-sess' });
    expect(await getSessionContextState(engine, 'default', 'remote', 'anon-sess')).not.toBeNull();
    expect(await getSessionContextState(engine, 'default', null, 'anon-sess')).toBeNull();
  });

  test('at-least-once: budget-dropped pages surface on the next wake (adversarial P2)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    // establish cursor first
    await call(del, local, { session_id: 'alo' });
    // three page changes after the cursor
    for (const s of ['alo-a', 'alo-b', 'alo-c']) {
      await call(putPage, local, { slug: `notes/${s}`, content: `# ${s}\n\ncontent for ${s}` });
    }
    // tiny budget: deliver a strict subset, has_more = true, cursor lags
    const r1 = await call(del, local, { session_id: 'alo', budget_tokens: 8 });
    expect(r1.has_more).toBe(true);
    expect(r1.pages.length).toBeGreaterThan(0);
    expect(r1.pages.length).toBeLessThan(3);
    // big budget: the remaining pages arrive — nothing was lost
    const r2 = await call(del, local, { session_id: 'alo', budget_tokens: 100000 });
    const delivered = new Set([...r1.pages, ...r2.pages].map((p: { slug: string }) => p.slug));
    expect(delivered.has('notes/alo-a')).toBe(true);
    expect(delivered.has('notes/alo-b')).toBe(true);
    expect(delivered.has('notes/alo-c')).toBe(true);
    expect(r2.has_more).toBe(false);
  });

  test('text is rendered from the budget-packed sets, not the full sets (adversarial P2)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    await call(del, local, { session_id: 'txt' });
    for (const s of ['txt-a', 'txt-b', 'txt-c']) {
      await call(putPage, local, { slug: `notes/${s}`, content: `# ${s}\n\ncontent` });
    }
    const r = await call(del, local, { session_id: 'txt', budget_tokens: 8 });
    const inText = ['txt-a', 'txt-b', 'txt-c'].filter((s) => (r.text as string).includes(s));
    expect(inText.length).toBe(r.pages.length); // text lists exactly the delivered pages
  });

  test('equal-timestamp ties survive across wakes (boundary-tie dedup, pre-landing P2)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    for (const s of ['tie-a', 'tie-b', 'tie-c', 'tie-d']) {
      await call(putPage, local, { slug: `notes/${s}`, content: `# ${s}\n\nbody` });
    }
    // Force all four onto ONE identical timestamp (the bulk-sync shape).
    await engine.executeRaw(
      `UPDATE pages SET updated_at = '2026-08-10T12:00:00Z' WHERE slug LIKE 'notes/tie-%'`,
    );
    // Seed the keyset cursor BEFORE the tie cluster (empty slug = start of the
    // bucket) via the INSERT path.
    await upsertSessionContextState(engine, 'default', null, 'tie', {
      lastWakeAt: '2026-08-10T11:00:00Z', cursorSlug: '',
    });
    // Tiny budget: deliver a strict subset of the tie cluster (all 4 share one
    // timestamp — the keyset paginates within it by slug).
    const r1 = await call(del, local, { session_id: 'tie', budget_tokens: 8 });
    expect(r1.pages.length).toBeGreaterThan(0);
    expect(r1.pages.length).toBeLessThan(4);
    expect(r1.has_more).toBe(true);
    // Next wake MUST deliver the remaining ties (timestamp-only cursors lost them).
    const r2 = await call(del, local, { session_id: 'tie', budget_tokens: 100000 });
    const delivered = new Set([...r1.pages, ...r2.pages].map((p: { slug: string }) => p.slug));
    for (const s of ['tie-a', 'tie-b', 'tie-c', 'tie-d']) expect(delivered.has(`notes/${s}`)).toBe(true);
    // And already-delivered ties must NOT re-deliver on a third wake.
    const r3 = await call(del, local, { session_id: 'tie', budget_tokens: 100000 });
    const redelivered = (r3.pages as Array<{ slug: string }>).filter((p) => p.slug.startsWith('notes/tie-'));
    expect(redelivered).toEqual([]);
  });

  test('F1: a tie cluster LARGER than the fetch limit fully drains (no livelock)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    const N = 55; // > DELTA_PAGE_FETCH_LIMIT (50) at ONE timestamp
    for (let i = 0; i < N; i++) {
      await call(putPage, local, { slug: `notes/big-${String(i).padStart(3, '0')}`, content: `# big-${i}\n\nb` });
    }
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-08-11T09:00:00Z' WHERE slug LIKE 'notes/big-%'`);
    await upsertSessionContextState(engine, 'default', null, 'big', {
      lastWakeAt: '2026-08-11T08:00:00Z', cursorSlug: '',
    });
    const seenBig = new Set<string>();
    let guard = 0;
    let more = true;
    while (more && guard < 10) {
      const r = await call(del, local, { session_id: 'big', budget_tokens: 100000 });
      for (const pg of r.pages as Array<{ slug: string }>) {
        if (pg.slug.startsWith('notes/big-')) seenBig.add(pg.slug);
      }
      more = r.has_more === true;
      guard++;
    }
    expect(guard).toBeLessThan(10); // did NOT livelock (the F1 failure was a stuck has_more)
    expect(more).toBe(false);
    expect(seenBig.size).toBe(N); // every tied page in the >limit cluster delivered, across wakes
  });

  test('zero-delivery wake does not advance the cursor (deliver-before-advance)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    await call(del, local, { session_id: 'zd' });
    const before = (await getSessionContextState(engine, 'default', null, 'zd'))!.last_wake_at;
    await call(putPage, local, { slug: 'notes/zd-page-with-a-very-long-title-to-cost-tokens', content: '# long\n\nbody' });
    const r = await call(del, local, { session_id: 'zd', budget_tokens: 1 });
    expect(r.pages).toEqual([]);
    expect(r.has_more).toBe(true);
    expect((await getSessionContextState(engine, 'default', null, 'zd'))!.last_wake_at).toBe(before);
  });

  test('remote caller with an empty-string clientId lands in "remote", never "local"', async () => {
    const ctx = ctxFor({ remote: true, clientId: '' });
    await call(del, ctx, { session_id: 'blank-cid' });
    expect(await getSessionContextState(engine, 'default', null, 'blank-cid')).toBeNull();
    expect(await getSessionContextState(engine, 'default', 'remote', 'blank-cid')).not.toBeNull();
  });

  test('malformed since → invalid_params with a suggestion (both verbs)', async () => {
    await expect(call(del, ctxFor({ remote: false }), { since: 'not-a-date' })).rejects.toThrow(/parseable|ISO/i);
    await expect(
      call(contextPack, ctxFor({ remote: false }), { entities: 'a', since: 'yesterday-ish' }),
    ).rejects.toThrow(/parseable|ISO/i);
  });

  test('first wake echoes the budget footer when budget_tokens was passed', async () => {
    const r = await call(del, ctxFor({ remote: false }), { session_id: 'fw-budget', budget_tokens: 500 });
    expect(r.budget_tokens).toBe(500);
    expect(r.budget_used).toBe(0);
    expect(r.dropped_count).toBe(0);
  });

  test('context_pack echoes the CAPPED entity list (max 8)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `entity-${i}`).join(',');
    const r = await call(contextPack, ctxFor({ remote: false }), { entities: many });
    expect((r.entities as string[]).length).toBe(8);
  });

  test('delta facts filter uses RECORDING time and reaches past 24h (pre-landing P2)', async () => {
    const local = ctxFor({ remote: false });
    await call(remember, local, { fact: 'old recorded fact for delta window test', provenance: 't', visibility: 'world' });
    // Age the fact's created_at 3 days back — the old hot-memory fallback
    // window (24h) would have silently missed it for a 5-day-old cursor.
    await engine.executeRaw(
      `UPDATE facts SET created_at = now() - interval '3 days' WHERE fact = 'old recorded fact for delta window test'`,
    );
    const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const r = await call(del, local, { since });
    const found = (r.facts as Array<{ fact: string }>).some((f) => f.fact.includes('old recorded fact'));
    expect(found).toBe(true);
  });

  test('stateless keyset resume: next_cursor.since/.slug drains a tie cluster, no re-delivery (v0.45.7)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    for (const s of ['sr-a', 'sr-b', 'sr-c', 'sr-d']) {
      await call(putPage, local, { slug: `notes/${s}`, content: `# ${s}\n\nbody` });
    }
    // One identical timestamp, earlier than every other fixture cluster.
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-08-09T10:00:00Z' WHERE slug LIKE 'notes/sr-%'`);
    // NO session_id anywhere: resume rides next_cursor.since/.slug alone.
    // budget 8 ≈ 2 pages per call, so the 4-page cluster needs ≥2 wakes.
    const seen: string[] = [];
    let since = '2026-08-09T09:59:00Z';
    let sinceSlug: string | undefined;
    let guard = 0;
    while (seen.length < 4 && guard < 10) {
      const r = await call(del, ctxFor({ remote: false }), {
        since,
        ...(sinceSlug !== undefined ? { since_slug: sinceSlug } : {}),
        budget_tokens: 8,
      });
      for (const pg of r.pages as Array<{ slug: string }>) {
        if (pg.slug.startsWith('notes/sr-')) seen.push(pg.slug);
      }
      since = (r.next_cursor as { since: string }).since;
      sinceSlug = (r.next_cursor as { slug: string }).slug;
      guard++;
    }
    // Full drain, exactly once each — a re-delivery would duplicate in `seen`.
    expect(seen.sort()).toEqual(['notes/sr-a', 'notes/sr-b', 'notes/sr-c', 'notes/sr-d']);
    // One more resumed call: the drained cluster must NOT re-deliver.
    const r = await call(del, ctxFor({ remote: false }), { since, since_slug: sinceSlug, budget_tokens: 100000 });
    const redelivered = (r.pages as Array<{ slug: string }>).filter((p) => p.slug.startsWith('notes/sr-'));
    expect(redelivered).toEqual([]);
  });

  test('explicit since_slug wins over the session cursor slug when both are present (v0.45.7)', async () => {
    const putPage = operations.find((o) => o.name === 'put_page')!;
    const local = ctxFor({ remote: false });
    for (const s of ['ow-a', 'ow-b', 'ow-c', 'ow-d']) {
      await call(putPage, local, { slug: `notes/${s}`, content: `# ${s}\n\nbody` });
    }
    await engine.executeRaw(`UPDATE pages SET updated_at = '2026-08-08T10:00:00Z' WHERE slug LIKE 'notes/ow-%'`);
    // Session cursor at the START of the tie bucket — on its own it would
    // deliver the whole cluster from ow-a.
    await upsertSessionContextState(engine, 'default', null, 'ow', {
      lastWakeAt: '2026-08-08T10:00:00Z', cursorSlug: '',
    });
    const r = await call(del, local, { session_id: 'ow', since_slug: 'notes/ow-b', budget_tokens: 100000 });
    const cluster = (r.pages as Array<{ slug: string }>)
      .map((p) => p.slug)
      .filter((s) => s.startsWith('notes/ow-'));
    // Strictly after the EXPLICIT slug — the session's '' slug would have
    // re-delivered ow-a/ow-b.
    expect(cluster).toEqual(['notes/ow-c', 'notes/ow-d']);
  });

  test('fail-open: a session_context_state outage never blocks the delta read path (v0.45.7)', async () => {
    // Proxy engine: executeRaw throws ONLY for statements touching
    // session_context_state; everything else hits the real engine (the delta
    // page/fact reads must keep working through the outage).
    const failing = new Proxy(engine, {
      get(t, k) {
        if (k === 'executeRaw') {
          return (sql: unknown, params?: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('session_context_state')) {
              throw new Error('injected session-state outage');
            }
            return t.executeRaw(sql as never, params as never);
          };
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' && k !== 'constructor'
          ? (v as (...a: unknown[]) => unknown).bind(t)
          : v;
      },
    });
    // The state READ degrades to null, never a throw.
    await expect(getSessionContextState(failing as never, 'default', null, 'outage')).resolves.toBeNull();
    const ctx = { ...ctxFor({ remote: false }), engine: failing } as OperationContext;
    // First-wake path: cursor read + establish-write + GC all fail — the verb
    // still answers with a complete payload.
    const r1 = await call(del, ctx, { session_id: 'outage' });
    expect(r1.protocol_version).toBe(1);
    expect(r1.pages).toEqual([]);
    expect(r1.since).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // Full delta path: assembly reads run fine; the cursor-advance write fails
    // silently and the payload is still complete.
    const r2 = await call(del, ctx, { session_id: 'outage', since: '1970-01-01T00:00:00Z' });
    expect(r2.protocol_version).toBe(1);
    expect(Array.isArray(r2.pages)).toBe(true);
    expect(r2.since).toBe('1970-01-01T00:00:00.000Z');
    expect(r2.next_cursor).toBeTruthy();
    // The writes really did fail: nothing persisted for this session.
    expect(await getSessionContextState(engine, 'default', null, 'outage')).toBeNull();
  });
});

describe('push-path IPC handler (extracted, real engine)', () => {
  test('bankOnly persists standing entities under the local lane; assembly merges them back', async () => {
    const { makeContextPackIpcHandler } = await import('../src/mcp/context-pack-handler.ts');
    const handler = makeContextPackIpcHandler(engine, 'default');
    const bank = await handler({
      kind: 'context_pack', protocol: 2, secret: 's',
      sessionId: 'push-1',
      window: [{ role: 'user', text: 'we should follow up with Acme Example about the pilot' }],
      bankOnly: true,
    });
    expect(bank?.text).toBe('');
    const st = await getSessionContextState(engine, 'default', null, 'push-1');
    expect((st?.standing_entities ?? []).length).toBeGreaterThan(0);
    // Assembly path picks the banked set back up (cards may be empty — the
    // entities need not resolve — but the merge itself must not throw and the
    // cursor must advance on a complete pack).
    const before = st?.last_wake_at ?? null;
    const res = await handler({ kind: 'context_pack', protocol: 2, secret: 's', sessionId: 'push-1' });
    expect(res).not.toBeNull();
    const after = await getSessionContextState(engine, 'default', null, 'push-1');
    expect(after?.last_wake_at).not.toBe(before); // complete pack advances the cursor
  });

  test('a deadline-degraded pack does NOT advance the wake cursor', async () => {
    const { makeContextPackIpcHandler } = await import('../src/mcp/context-pack-handler.ts');
    // Freeze a known cursor + banked entities first (INSERT path) so the
    // handler's assembly has real card work to blow the deadline on.
    await upsertSessionContextState(engine, 'default', null, 'push-2', {
      lastWakeAt: '2026-08-01T00:00:00Z',
      standingEntities: ['slow-ent-a', 'slow-ent-b', 'slow-ent-c'],
    });
    // A proxy engine that delays EVERY method call well past the pack budget
    // (arms use engine methods, not just executeRaw).
    const DELAY = 250;
    const slowEngine = new Proxy(engine, {
      get(t, k) {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        if (typeof v === 'function' && k !== 'constructor') {
          return async (...a: unknown[]) => {
            await new Promise((r) => setTimeout(r, DELAY));
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        return v;
      },
    });
    const { assembleContextPack } = await import('../src/core/context/turn-context.ts');
    const res = await assembleContextPack(slowEngine as never, {
      sourceId: 'default',
      entities: ['slow-ent-a', 'slow-ent-b', 'slow-ent-c'],
      deadlineMs: 100,
    });
    expect(res.degradedReason).toBe('deadline');
    // Snapshot semantics: the returned arrays must not grow after resolution.
    const lenCards = res.cards!.length;
    await new Promise((r) => setTimeout(r, 4 * DELAY));
    expect(res.cards!.length).toBe(lenCards);
    // And the handler skips the cursor advance on a degraded result — proven
    // via the real handler against the slow engine. (The handler's own state
    // read/write use the REAL engine here so we can assert directly.)
    const handler = makeContextPackIpcHandler(slowEngine as never, 'default');
    await handler({ kind: 'context_pack', protocol: 2, secret: 's', sessionId: 'push-2' });
    const st = await getSessionContextState(engine, 'default', null, 'push-2');
    expect(new Date(st!.last_wake_at!).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  }, 20_000);

  test('banked entities surface as VISIBLE warm-pack content on the next wake (v0.45.7)', async () => {
    const { makeContextPackIpcHandler } = await import('../src/mcp/context-pack-handler.ts');
    const putPage = operations.find((o) => o.name === 'put_page')!;
    // A REAL page the banked window entity resolves to (title + slug-suffix arms).
    await call(putPage, ctxFor({ remote: false }), {
      slug: 'people/dana-example',
      content: '# Dana Example\n\nFounder of widget-co; met at the retreat.',
    });
    const handler = makeContextPackIpcHandler(engine, 'default');
    // PreCompact banking: the window NAMES the seeded page.
    const bank = await handler({
      kind: 'context_pack', protocol: 2, secret: 's',
      sessionId: 'push-vis',
      window: [{ role: 'user', text: 'we should sync with Dana Example before the board meeting' }],
      bankOnly: true,
    });
    expect(bank?.text).toBe('');
    const st = await getSessionContextState(engine, 'default', null, 'push-vis');
    expect(st?.standing_entities ?? []).toContain('Dana Example');
    // Post-compaction wake: the banked entity resolves to its page and lands in
    // the rendered pack — traceable CONTENT, not merely a cursor advance.
    const res = await handler({ kind: 'context_pack', protocol: 2, secret: 's', sessionId: 'push-vis' });
    expect(res).not.toBeNull();
    expect((res!.cards ?? []).some((c) => c.entity.slug === 'people/dana-example')).toBe(true);
    expect(res!.text).toContain('## Standing entities');
    expect(res!.text).toContain('people/dana-example');
  });
});

describe('hot-memory cache: cross-tier isolation (adversarial P1 regression)', () => {
  test('a local include_private call must not warm the cache the remote read hits', async () => {
    const local = ctxFor({ remote: false });
    await call(remember, local, { fact: 'tier-secret burn detail', provenance: 't', entity: 'tier-acme', visibility: 'private' });
    __resetHotMemoryCacheForTests();
    // Warm the cache at the trusted-local tier (private facts included).
    const warm = await call(contextPack, local, { entities: 'tier-acme', include_private: true });
    expect((warm.facts as Array<{ fact: string }>).map((f) => f.fact).join('|')).toContain('tier-secret');
    // NO cache reset here — the remote call with the same source/session must
    // MISS the local-tier entry (the leak was: same key, served private).
    const r = await call(contextPack, ctxFor({ remote: true, clientId: 'c1' }), { entities: 'tier-acme', include_private: true });
    expect((r.facts as Array<{ fact: string }>).map((f) => f.fact).join('|')).not.toContain('tier-secret');
  });
});

describe('visibility (eng 1A / D2=A): world-only default, fail-closed widen', () => {
  beforeEach(async () => {
    // seed one world + one private fact about the same entity
    const local = ctxFor({ remote: false });
    await call(remember, local, { fact: 'acme-example raised a seed round', provenance: 'test', entity: 'acme-example', visibility: 'world' });
    await call(remember, local, { fact: 'acme-example secret burn rate detail', provenance: 'test', entity: 'acme-example', visibility: 'private' });
    __resetHotMemoryCacheForTests();
  });

  test('local include_private=true widens facts to include private', async () => {
    const r = await call(contextPack, ctxFor({ remote: false }), { entities: 'acme-example', include_private: true });
    const facts = (r.facts as Array<{ fact: string }>).map((f) => f.fact).join(' | ');
    expect(facts).toContain('secret burn rate');
  });

  test('local default (no include_private) is world-only', async () => {
    const r = await call(contextPack, ctxFor({ remote: false }), { entities: 'acme-example' });
    const facts = (r.facts as Array<{ fact: string }>).map((f) => f.fact).join(' | ');
    expect(facts).not.toContain('secret burn rate');
  });

  test('remote caller NEVER widens even with include_private=true (fail-closed)', async () => {
    const r = await call(contextPack, ctxFor({ remote: true, clientId: 'c1' }), { entities: 'acme-example', include_private: true });
    const facts = (r.facts as Array<{ fact: string }>).map((f) => f.fact).join(' | ');
    expect(facts).not.toContain('secret burn rate');
  });

  // v0.45.7 gap closure: `delta` mirrors the same fail-closed ladder — the
  // facts arm routes through listFactsSince's visibility filter, not the
  // hot-memory tier, so it needs its own pins.
  test('delta local default (no include_private) is world-only in facts[] AND text', async () => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = await call(del, ctxFor({ remote: false }), { since });
    const facts = (r.facts as Array<{ fact: string }>).map((f) => f.fact).join(' | ');
    expect(facts).toContain('raised a seed round');
    expect(facts).not.toContain('secret burn rate');
    expect(r.text as string).not.toContain('secret burn rate');
  });

  test('delta local include_private=true widens facts to include private', async () => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = await call(del, ctxFor({ remote: false }), { since, include_private: true });
    const facts = (r.facts as Array<{ fact: string }>).map((f) => f.fact).join(' | ');
    expect(facts).toContain('secret burn rate');
  });

  test('delta remote caller NEVER widens even with include_private=true (fail-closed)', async () => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = await call(del, ctxFor({ remote: true, clientId: 'c1' }), { since, include_private: true });
    const facts = (r.facts as Array<{ fact: string }>).map((f) => f.fact).join(' | ');
    expect(facts).not.toContain('secret burn rate');
    expect(r.text as string).not.toContain('secret burn rate');
  });
});

describe('budget packing + drop footer', () => {
  beforeEach(async () => {
    const local = ctxFor({ remote: false });
    for (let i = 0; i < 8; i++) {
      await call(remember, local, { fact: `fact number ${i} with some length to consume tokens`, provenance: 'test', visibility: 'world' });
    }
    __resetHotMemoryCacheForTests();
  });

  test('tiny budget reports dropped_count and never trims client-side', async () => {
    const r = await call(contextPack, ctxFor({ remote: false }), { entities: 'acme-example', budget_tokens: 5 });
    expect(r.budget_tokens).toBe(5);
    expect(typeof r.budget_used).toBe('number');
    expect(r.dropped_count).toBeGreaterThanOrEqual(0);
  });

  test('no budget → no footer fields', async () => {
    const r = await call(contextPack, ctxFor({ remote: false }), { entities: 'acme-example' });
    expect(r.budget_tokens).toBeUndefined();
    expect(r.dropped_count).toBeUndefined();
  });

  test('forced overflow: dropped_count > 0 and budget_used stays within budget_tokens (v0.45.7)', async () => {
    const local = ctxFor({ remote: false });
    // Long facts (~55 tokens each): even ONE cannot fit the 20-token budget,
    // so overflow is GUARANTEED, not merely allowed (the >= 0 escape hatch).
    for (let i = 0; i < 5; i++) {
      await call(remember, local, {
        fact: `overflow filler fact ${i} ${'x'.repeat(200)}`,
        provenance: 'test',
        visibility: 'world',
      });
    }
    __resetHotMemoryCacheForTests();
    // Precondition: the unbudgeted pack actually carries facts to drop.
    const full = await call(contextPack, local, { entities: 'acme-example' });
    expect((full.facts as unknown[]).length).toBeGreaterThan(0);
    const r = await call(contextPack, local, { entities: 'acme-example', budget_tokens: 20 });
    expect(r.budget_tokens).toBe(20);
    expect(r.dropped_count).toBeGreaterThan(0);
    expect(r.budget_used).toBeLessThanOrEqual(20);
    expect((r.facts as unknown[]).length).toBeLessThan((full.facts as unknown[]).length);
  });
});
