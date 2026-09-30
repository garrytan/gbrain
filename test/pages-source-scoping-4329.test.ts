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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;
const home = mkdtempSync(join(tmpdir(), 'gbrain-page-sources-'));
let betaRoot: string;
let legacyTokenId: string;
function localMutation(name: string) {
  const op = operations.find(o => o.name === name)!;
  return { ...op, handler: (ctx: OperationContext, p: Record<string, unknown>) => withEnv({ GBRAIN_HOME: home }, () => op.handler(ctx, p)) };
}
const delete_page = localMutation('delete_page');
const restore_page = localMutation('restore_page');
async function revision(sourceId = 'default') { return (await engine.readPageSnapshot('shared/doc', { sourceId, includeDeleted: true }))!.revision; }

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: { engine: 'pglite', embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

function authOf(overrides: Record<string, unknown> = {}) {
  const sourceId = typeof overrides.sourceId === 'string' ? overrides.sourceId : 'default';
  const clientId = `source-client-${sourceId}`;
  return { token: 't', clientId, principal: { kind: 'oauth_client' as const, id: clientId }, scopes: ['read', 'write'], sourceId, ...overrides };
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
  if (engine) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  rmSync(home, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  // Reset creates a new brain identity; give it a fresh physical checkout.
  // Ownership reservations intentionally survive source deletion and cannot
  // be recycled across different brains.
  betaRoot = mkdtempSync(join(home, 'beta-'));
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', $1)`, [betaRoot]);
  for (const sourceId of ['default', 'beta']) await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,federated_read) VALUES($1,'Source fixture','read write',$2,$3)`, [`source-client-${sourceId}`, sourceId, ['default', 'beta']]);
  const [legacy] = await engine.executeRaw<{ id: string }>(`INSERT INTO access_tokens(name,token_hash,permissions) VALUES('Legacy source fixture','source-fixture-token','{"source_id":"beta"}'::jsonb) RETURNING id`);
  legacyTokenId = String(legacy.id);
  // Same slug in BOTH sources — the ambiguity #4329 is about.
  await engine.putPage('shared/doc', {
    type: 'note', title: 'default copy', compiled_truth: 'default content', timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('shared/doc', {
    type: 'note', title: 'beta copy', compiled_truth: 'beta content', timeline: '', frontmatter: {},
  }, { sourceId: 'beta' });
  const snapshot = (await engine.readPageSnapshot('shared/doc', { sourceId: 'beta' }))!;
  mkdirSync(join(betaRoot, 'shared'), { recursive: true });
  writeFileSync(join(betaRoot, 'shared/doc.md'), serializePageToMarkdown(snapshot.page, snapshot.tags));
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
    const res = await delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: 'beta', expected_revision: await revision('beta') }) as Record<string, unknown>;
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
    const res = await delete_page.handler(ctxOf({ sourceId: 'beta' }), { slug: 'shared/doc', source_id: 'beta', expected_revision: await revision('beta') }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect(res.source_id).toBe('beta');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).not.toBeNull();
    expect(rows.default).toBeNull();
  });

  test('without source_id, keeps the ctx.sourceId status quo (and echoes it)', async () => {
    const res = await delete_page.handler(ctxOf(), { slug: 'shared/doc', expected_revision: await revision() }) as Record<string, unknown>;
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
    const res = await delete_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta', expected_revision: await revision('beta') }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).not.toBeNull();
    expect(rows.default).toBeNull();
  });

  test('legacy authenticated token (no auth.sourceId): falls back to ctx.sourceId as the write authority', async () => {
    const legacyAuth = { token: 't', clientId: 'legacy', principal: { kind: 'legacy_token' as const, id: legacyTokenId }, scopes: ['read', 'write'] };
    const ctx = ctxOf({ sourceId: 'beta', auth: legacyAuth });
    const res = await delete_page.handler(ctx, { slug: 'shared/doc', source_id: 'beta', expected_revision: await revision('beta') }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect((await deletedAtBySource('shared/doc')).beta).not.toBeNull();
    // ...and the same legacy token cannot target outside ctx.sourceId.
    await expect(delete_page.handler(ctxOf({ sourceId: 'beta', auth: legacyAuth }), { slug: 'shared/doc', source_id: 'default' }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect((await deletedAtBySource('shared/doc')).default).toBeNull();
  });

  test('dry-run still validates the param before returning the preview', async () => {
    await expect(delete_page.handler(ctxOf({ dryRun: true }), { slug: 'shared/doc', source_id: '__all__' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('delete_page purge — immediate removal for the trusted local CLI only', () => {
  test('contract: purge is a boolean param (so the generated CLI accepts `gbrain delete <slug> --purge`)', () => {
    expect(delete_page.params.purge?.type).toBe('boolean');
  });

  test('trusted local purge: coordinated hard-delete of the targeted row only; status purged', async () => {
    const res = await delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: 'beta', purge: true, expected_revision: await revision('beta') }) as Record<string, unknown>;
    expect(res.status).toBe('purged');
    expect(res.source_id).toBe('beta');
    expect(res).not.toHaveProperty('recoverable_until');
    // Shape pin: the live-row purge carries the artifact-removal outcome, same
    // as a plain soft-delete (committed publication or an explicit database-only reason).
    expect(res.write_through).toEqual({ written: true });
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.beta).toBeUndefined();          // row is GONE, not tombstoned
    expect(rows.default).toBeNull();            // the other source's copy is untouched
    expect(await engine.getPage('shared/doc', { sourceId: 'beta', includeDeleted: true })).toBeNull();
    expect((await engine.getRawData('shared/doc', undefined, { sourceId: 'beta', includeDeleted: true })).length).toBe(0);
  });

  test('purge completes the removal of a row that was already soft-deleted (the remediation path)', async () => {
    await engine.softDeletePage('shared/doc', { sourceId: 'default' });
    const res = await delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', purge: true, expected_revision: await revision() }) as Record<string, unknown>;
    expect(res.status).toBe('purged');
    // Shape pin: ONE response shape for status purged — the remediation path
    // RETRIES the artifact removal against the tombstone's recorded path and
    // reports the real outcome (here: no repo is configured, so nothing to
    // unlink) instead of a fabricated 'already_soft_deleted' skip. The
    // retry itself is pinned by test/pages-purge-artifact.test.ts.
    expect(res.write_through).toEqual({ written: false, skipped: 'no_repo_configured' });
    expect((await deletedAtBySource('shared/doc')).default).toBeUndefined();
    // Unknown slug is still a clean not-found, even with purge.
    await expect(delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', purge: true }))
      .rejects.toMatchObject({ code: 'page_not_found' });
  });

  test('remote callers (anything not strictly remote === false) get permission_denied and nothing is deleted', async () => {
    // Local-only lane convention (connectors_status, get_recent_transcripts):
    // a well-formed request the caller is not allowed to make is
    // permission_denied, not invalid_params (that code is for shape errors).
    await expect(delete_page.handler(ctxOf(), { slug: 'shared/doc', purge: true }))
      .rejects.toMatchObject({ code: 'permission_denied', suggestion: expect.stringContaining('gbrain delete <slug> --purge') });
    await expect(delete_page.handler(ctxOf({ remote: undefined as unknown as boolean }), { slug: 'shared/doc', purge: true }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const authed = ctxOf({ auth: authOf({ sourceId: 'default', allowedSources: ['default'], scopes: ['read', 'write', 'admin'] }) as any });
    await expect(delete_page.handler(authed, { slug: 'shared/doc', purge: true }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    const rows = await deletedAtBySource('shared/doc');
    expect(rows.default).toBeNull();            // not even soft-deleted
    expect(rows.beta).toBeNull();
    // ...and the same remote caller can still soft-delete without purge.
    const res = await delete_page.handler(ctxOf(), { slug: 'shared/doc', expected_revision: await revision() }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
  });

  test('a non-boolean purge value is rejected, never coerced (shape error stays invalid_params)', async () => {
    await expect(delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', purge: 'yes' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    // A remote caller with a malformed purge is a shape error first.
    await expect(delete_page.handler(ctxOf(), { slug: 'shared/doc', purge: 'yes' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect((await deletedAtBySource('shared/doc')).default).toBeNull();
  });

  test('purge: false behaves as a plain soft delete, and the hint names the purge path', async () => {
    const res = await delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', purge: false, expected_revision: await revision() }) as Record<string, unknown>;
    expect(res.status).toBe('soft_deleted');
    expect(String(res.recoverable_until)).toContain('gbrain delete <slug> --purge');
    expect((await deletedAtBySource('shared/doc')).default).not.toBeNull();
  });

  test('dry-run purge previews the hard removal without touching the row', async () => {
    const res = await delete_page.handler(ctxOf({ remote: false, dryRun: true }), { slug: 'shared/doc', purge: true }) as Record<string, unknown>;
    expect(res.dry_run).toBe(true);
    expect(res.action).toBe('purge_page');
    expect((await deletedAtBySource('shared/doc')).default).toBeNull();
  });
});

// get_raw_data follows the page's soft-delete (op-level pin of the engine
// rule): a tombstoned page's raw rows read as [] — exactly like a missing
// page — and restore_page brings them back. Remote callers get no
// include_deleted knob on this op; get_page include_deleted verifies the
// tombstone instead.
describe('get_raw_data follows the page soft-delete', () => {
  const get_raw_data = operations.find(o => o.name === 'get_raw_data')!;

  test('contract: no remote-facing include_deleted param; description states the soft-delete rule', () => {
    expect(get_raw_data.params.include_deleted).toBeUndefined();
    expect(get_raw_data.description).toMatch(/soft-delete/);
    expect(get_raw_data.description).toMatch(/restore_page/);
  });

  test('[] after softDeletePage, rows again after restorePage (trusted local and remote alike)', async () => {
    await engine.putRawData('shared/doc', 'crustdata', { k: 'v' }, { sourceId: 'default' });
    const read = (ctx: OperationContext) => get_raw_data.handler(ctx, { slug: 'shared/doc' }) as Promise<unknown[]>;
    expect((await read(ctxOf({ remote: false }))).length).toBe(1);
    expect((await read(ctxOf())).length).toBe(1);

    expect(await engine.softDeletePage('shared/doc', { sourceId: 'default' })).not.toBeNull();
    expect(await read(ctxOf({ remote: false }))).toEqual([]);
    expect(await read(ctxOf())).toEqual([]);
    // The tombstone is verifiable through get_page include_deleted.
    const tomb = await get_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', include_deleted: true }) as Record<string, unknown>;
    expect(tomb.deleted_at).not.toBeNull();

    const res = await restore_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', expected_revision: await revision() }) as Record<string, unknown>;
    expect(res.status).toBe('restored');
    expect((await read(ctxOf({ remote: false }))).length).toBe(1);
    expect((await read(ctxOf())).length).toBe(1);
  });
});

describe('#4329 — restore_page source_id', () => {
  beforeEach(async () => {
    await engine.softDeletePage('shared/doc', { sourceId: 'default' });
    await engine.softDeletePage('shared/doc', { sourceId: 'beta' });
  });

  test('restores only the targeted source\'s row (and echoes it)', async () => {
    const res = await restore_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', source_id: 'beta', expected_revision: await revision('beta') }) as Record<string, unknown>;
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

// purge's reason to exist is "a page must not linger (e.g. it captured a
// credential)" — so the dependents that carry the page's bytes (raw_data,
// chunks, tags) must go with the row, and only for the targeted source.
describe('delete_page purge — cascades through the row\'s dependents, leaves the other source alone', () => {
  test('raw_data / tags / chunks of the purged row are gone; the same slug in another source keeps its rows', async () => {
    for (const sourceId of ['default', 'beta']) {
      await engine.putRawData('shared/doc', 'transcript:claude-code', { note: `${sourceId} meta` }, { sourceId });
      await engine.addTag('shared/doc', `tag-${sourceId}`, { sourceId });
      await engine.upsertChunks('shared/doc', [
        { chunk_index: 0, chunk_text: `${sourceId} chunk`, chunk_source: 'compiled_truth' },
      ], { sourceId });
    }
    const ids = await engine.executeRaw<{ id: number; source_id: string }>(
      `SELECT id, source_id FROM pages WHERE slug = 'shared/doc'`,
    );
    const idOf = Object.fromEntries(ids.map(r => [r.source_id, r.id])) as Record<string, number>;
    const dependents = async (pageId: number) => {
      const count = async (table: string) => {
        const [row] = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE page_id = $1`, [pageId],
        );
        return row.n;
      };
      return { raw: await count('raw_data'), tags: await count('tags'), chunks: await count('content_chunks') };
    };
    expect(await dependents(idOf.default)).toEqual({ raw: 1, tags: 1, chunks: 1 });
    expect(await dependents(idOf.beta)).toEqual({ raw: 1, tags: 1, chunks: 1 });

    const res = await delete_page.handler(ctxOf({ remote: false }), { slug: 'shared/doc', purge: true, expected_revision: await revision() }) as Record<string, unknown>;
    expect(res.status).toBe('purged');
    expect(res.source_id).toBe('default');
    expect(await dependents(idOf.default)).toEqual({ raw: 0, tags: 0, chunks: 0 });
    expect(await dependents(idOf.beta)).toEqual({ raw: 1, tags: 1, chunks: 1 });
    expect((await engine.getRawData('shared/doc', undefined, { sourceId: 'beta' })).length).toBe(1);
    expect((await deletedAtBySource('shared/doc')).beta).toBeNull(); // beta copy alive, not even tombstoned
  });
});
