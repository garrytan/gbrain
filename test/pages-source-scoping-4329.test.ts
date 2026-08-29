/**
 * #4329 — get_page / delete_page / restore_page honor a per-call source_id.
 *
 * Pre-fix, the three ops had NO source_id in their contracts, so an
 * agent-passed source_id was SILENTLY dropped and the op acted on
 * ctx.sourceId — on a multi-source brain holding the same slug in several
 * sources, delete_page soft-deleted the WRONG row while returning a success
 * that named the requested slug (false confidence, observed in the wild).
 *
 * Contract pinned here:
 *   - a caller-supplied source_id is honored (threaded to the engine call)
 *     or rejected loudly (invalid_params / permission_denied) — never ignored;
 *   - destructive ops reject '__all__' (they target exactly one source);
 *   - a remote caller (anything not strictly ctx.remote === false) may target
 *     ONLY its write authority: ctx.auth.sourceId when auth exists (falling
 *     back to ctx.sourceId for legacy tokens without a source grant), else
 *     ctx.sourceId. `allowedSources` is the READ-federation grant
 *     (contract.ts) and plays NO role in writes — a client that can READ
 *     sources [A, B] with write authority A cannot delete/restore in B;
 *   - delete/restore responses echo the targeted source_id so callers can
 *     verify WHICH row the op landed on.
 *
 * Plus the #3070 real-engine pinning both ways: the sole_non_default resolver
 * tier fires only while 'default' is an empty corpus.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resolveSourceId, resolveSourceWithTier } from '../src/core/source-resolver.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;
const delete_page = operations.find(o => o.name === 'delete_page')!;
const restore_page = operations.find(o => o.name === 'restore_page')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

function authOf(overrides: Record<string, unknown> = {}) {
  return { token: 't', clientId: 'client-1', scopes: ['read', 'write'], ...overrides };
}

async function deletedAtBySource(slug: string): Promise<Record<string, string | null>> {
  const rows = await engine.executeRaw<{ source_id: string; deleted_at: string | null }>(
    `SELECT source_id, deleted_at FROM pages WHERE slug = $1`,
    [slug],
  );
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.source_id] = r.deleted_at;
  return out;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta-4329') ON CONFLICT (id) DO NOTHING`);
  // Same slug in BOTH sources — the ambiguity #4329 is about.
  await engine.putPage('shared/doc', {
    type: 'note', title: 'default copy', compiled_truth: 'default content', timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('shared/doc', {
    type: 'note', title: 'beta copy', compiled_truth: 'beta content', timeline: '', frontmatter: {},
  }, { sourceId: 'beta' });
});

describe('#4329 — op contracts carry source_id (honored, never silently dropped)', () => {
  test('all three ops declare the source_id param', () => {
    for (const op of [get_page, delete_page, restore_page]) {
      expect(Object.keys(op.params)).toContain('source_id');
    }
  });
});

describe('#4329 — delete_page source_id', () => {
  test('REGRESSION: source_id targets that source\'s row, not ctx.sourceId\'s (trusted local)', async () => {
    // Trusted local caller (ctx.remote === false) owns the brain: an explicit
    // source_id is honored and threaded to the engine, never silently dropped.
    const res = await delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect(res.source_id).toBe('beta');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).not.toBeNull();       // intended target deleted
    expect(rows.default).toBeNull();        // ctx source untouched
  });

  test('S1 REGRESSION: no-auth remote with an out-of-authority source_id → permission_denied, never a cross-source delete', async () => {
    // The reporter's exact shape: ctx resolved to 'default', param says beta,
    // remote transport with no auth (stdio MCP). Rejected loudly — an
    // unauthenticated remote caller's write authority is exactly ctx.sourceId.
    await expect(delete_page.handler(ctxOf(), { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).toBeNull();           // nothing deleted anywhere
    expect(rows.default).toBeNull();
  });

  test('no-auth remote: explicit source_id equal to ctx.sourceId is honored (redundant-but-matching)', async () => {
    const res = await delete_page.handler(ctxOf({ sourceId: 'beta' }), { slug: 'shared/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect(res.source_id).toBe('beta');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).not.toBeNull();
    expect(rows.default).toBeNull();
  });

  test('without source_id, keeps the ctx.sourceId status quo (and echoes it)', async () => {
    const res = await delete_page.handler(ctxOf(), { slug: 'shared/doc' }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect(res.source_id).toBe('default');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.default).not.toBeNull();
    expect(rows.beta).toBeNull();
  });

  test('invalid source_id shape → invalid_params, nothing deleted', async () => {
    await expect(delete_page.handler(ctxOf(), { slug: 'shared/doc', source_id: 'Not Valid!' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    // Non-string values are rejected too — never coerced or dropped.
    await expect(delete_page.handler(ctxOf(), { slug: 'shared/doc', source_id: 42 }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.default).toBeNull();
    expect(rows.beta).toBeNull();
  });

  test("'__all__' is rejected for the destructive op", async () => {
    await expect(delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: '__all__' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('authenticated remote caller: out-of-grant source_id → permission_denied, row untouched', async () => {
    const ctx = ctxOf({ auth: authOf({ sourceId: 'default', allowedSources: ['default'] }) as any });
    await expect(delete_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).toBeNull();
  });

  test('S1: allowedSources is a READ grant — write authority A + allowedSources [A, B] CANNOT delete in B', async () => {
    // The federated read grant must play NO role in writes: a client that can
    // READ ['default', 'beta'] with write authority 'default' must not be able
    // to soft-delete beta's row.
    const ctx = ctxOf({ auth: authOf({ sourceId: 'default', allowedSources: ['default', 'beta'] }) as any });
    await expect(delete_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).toBeNull();           // read grant conferred no write
    expect(rows.default).toBeNull();        // and nothing was retargeted
  });

  test('authenticated remote caller: source_id equal to the write authority (auth.sourceId) is honored', async () => {
    // HTTP transport dual-writes auth.sourceId into ctx.sourceId; mirror that.
    const ctx = ctxOf({ sourceId: 'beta', auth: authOf({ sourceId: 'beta', allowedSources: ['default', 'beta'] }) as any });
    const res = await delete_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).not.toBeNull();
    expect(rows.default).toBeNull();
  });

  test('legacy authenticated token (no auth.sourceId): falls back to ctx.sourceId as the write authority', async () => {
    const ctx = ctxOf({ sourceId: 'beta', auth: authOf({}) as any });
    const res = await delete_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect((await deletedAtBySource('shared/doc')).beta).not.toBeNull();
    // ...and the same legacy token cannot target outside ctx.sourceId.
    await expect(delete_page.handler(ctxOf({ sourceId: 'beta', auth: authOf({}) as any }), { slug: 'shared/doc', source_id: 'default' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deletedAtBySource('shared/doc')).default).toBeNull();
  });

  test('dry-run still validates the param before returning the preview', async () => {
    await expect(delete_page.handler(ctxOf({ dryRun: true }), { slug: 'shared/doc', source_id: '__all__' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('#4329 — restore_page source_id', () => {
  beforeEach(async () => {
    await engine.softDeletePage('shared/doc', { sourceId: 'default' });
    await engine.softDeletePage('shared/doc', { sourceId: 'beta' });
  });

  test('restores only the targeted source\'s row (and echoes it)', async () => {
    const res = await restore_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.status).toBe('restored');
    expect(res.source_id).toBe('beta');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).toBeNull();            // restored
    expect(rows.default).not.toBeNull();     // still soft-deleted
  });

  test('authenticated remote caller: out-of-authority source_id → permission_denied', async () => {
    const ctx = ctxOf({ auth: authOf({ sourceId: 'default', allowedSources: [] }) as any });
    await expect(restore_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deletedAtBySource('shared/doc')).beta).not.toBeNull();
  });

  test('S1: federated allowedSources confers no restore authority either', async () => {
    const ctx = ctxOf({ auth: authOf({ sourceId: 'default', allowedSources: ['default', 'beta'] }) as any });
    await expect(restore_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deletedAtBySource('shared/doc')).beta).not.toBeNull();  // still soft-deleted
  });

  test('S1: no-auth remote cannot restore outside ctx.sourceId', async () => {
    await expect(restore_page.handler(ctxOf(), { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deletedAtBySource('shared/doc')).beta).not.toBeNull();
  });

  test('invalid source_id shape → invalid_params', async () => {
    await expect(restore_page.handler(ctxOf(), { slug: 'shared/doc', source_id: 'UPPER' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('#4329 — get_page source_id', () => {
  test('returns the requested source\'s copy, not ctx.sourceId\'s', async () => {
    const res = await get_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.title).toBe('beta copy');
    const viaCtx = await get_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc' }) as Record<string, unknown>;
    expect(viaCtx.title).toBe('default copy');
  });

  test('remote federated grant excluding the requested source → permission_denied', async () => {
    const ctx = ctxOf({ auth: authOf({ allowedSources: ['default'] }) as any });
    await expect(get_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  test("'__all__' is accepted for the read op (trusted local spans the brain)", async () => {
    const res = await get_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: '__all__' }) as Record<string, unknown>;
    expect(res.slug).toBe('shared/doc');
  });

  test('invalid source_id shape → invalid_params (never silently dropped)', async () => {
    await expect(get_page.handler(ctxOf(), { slug: 'shared/doc', source_id: 'no/slash' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('#4516 — get_page miss names the source that holds the slug (trusted local only)', () => {
  beforeEach(async () => {
    await engine.putPage('beta-only/doc', {
      type: 'note', title: 'beta only', compiled_truth: 'beta only content', timeline: '', frontmatter: {},
    }, { sourceId: 'beta' });
  });

  test('trusted local scoped miss → hint says which source holds it and how to route there', async () => {
    await expect(get_page.handler(ctxOf({ remote: false }), { slug: 'beta-only/doc' }))
      .rejects.toMatchObject({
        code: 'page_not_found',
        suggestion: expect.stringContaining("--source beta"),
      });
  });

  test('remote caller gets NO cross-source existence hint (no oracle outside the grant)', async () => {
    try {
      await get_page.handler(ctxOf(), { slug: 'beta-only/doc' });
      throw new Error('expected page_not_found');
    } catch (e: any) {
      expect(e.code).toBe('page_not_found');
      expect(String(e.suggestion ?? '')).not.toContain('beta');
    }
  });

  test('slug existing nowhere keeps the plain hint', async () => {
    try {
      await get_page.handler(ctxOf({ remote: false }), { slug: 'nowhere/doc' });
      throw new Error('expected page_not_found');
    } catch (e: any) {
      expect(e.code).toBe('page_not_found');
      expect(String(e.suggestion ?? '')).not.toContain('--source');
    }
  });

  test('explicit --source targeting still finds it (isolation is by design, unchanged)', async () => {
    const res = await get_page.handler(ctxOf({ remote: false }), { slug: 'beta-only/doc', source_id: 'beta' }) as Record<string, unknown>;
    expect(res.title).toBe('beta only');
  });
});

describe('#3070 — sole_non_default emptiness guard (real engine, both ways)', () => {
  // Neutral cwd (no .gbrain-source ancestor, outside any registered
  // local_path) + GBRAIN_SOURCE cleared, so tiers 1-4 never fire.
  const cwd = mkdtempSync(join(tmpdir(), 'gbrain-3070-cwd-'));
  const resolveBare = (fn: () => Promise<unknown>) =>
    withEnv({ GBRAIN_SOURCE: undefined }, fn);

  test('established default corpus: bare resolution falls through to seed_default', async () => {
    // Fixture already holds an active page in 'default' + exactly one
    // non-default source with a local_path ('beta') — the hijack shape.
    await resolveBare(async () => {
      const resolved = await resolveSourceWithTier(engine as any, null, cwd);
      expect(resolved.source_id).toBe('default');
      expect(resolved.tier).toBe('seed_default');
      expect(await resolveSourceId(engine as any, null, cwd)).toBe('default');
    });
  });

  test('empty default: the #1434 convenience tier still fires', async () => {
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default'`);
    await resolveBare(async () => {
      const resolved = await resolveSourceWithTier(engine as any, null, cwd);
      expect(resolved.source_id).toBe('beta');
      expect(resolved.tier).toBe('sole_non_default');
    });
  });

  test('soft-deleted-only default counts as empty (active pages gate the corpus)', async () => {
    await engine.softDeletePage('shared/doc', { sourceId: 'default' });
    await resolveBare(async () => {
      const resolved = await resolveSourceWithTier(engine as any, null, cwd);
      expect(resolved.source_id).toBe('beta');
      expect(resolved.tier).toBe('sole_non_default');
    });
  });
});
