/**
 * #1393 — get_page exact-match path honors the federated source grant.
 *
 * Pre-fix the exact path used scalar `ctx.sourceId` only:
 *   const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {};
 * A remote OAuth client with a federated `allowedSources` grant (and no single
 * ctx.sourceId) therefore got an UNSCOPED exact lookup — a cross-source read of
 * any page by slug. The fuzzy path was already scoped (#1436); this closes the
 * exact path by (a) routing it through sourceScopeOpts and (b) teaching
 * engine.getPage to honor a `sourceIds[]` array (both engines).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const get_page = operations.find(o => o.name === 'get_page')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
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
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  // Distinct slugs per source so an exact lookup can leak across the boundary.
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Beta secret', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('shared/alpha-doc', {
    type: 'note', title: 'Alpha doc', compiled_truth: 'alpha content', frontmatter: {},
  }, { sourceId: 'alpha' });
});

describe('engine.getPage honors sourceIds[] (federated grant)', () => {
  test('sourceIds[] matching the page returns it', async () => {
    const page = await engine.getPage('secret/beta-doc', { sourceIds: ['alpha', 'beta'] });
    expect(page?.title).toBe('Beta secret');
  });

  test('sourceIds[] NOT containing the page returns null', async () => {
    const page = await engine.getPage('secret/beta-doc', { sourceIds: ['alpha'] });
    expect(page).toBeNull();
  });

  test('sourceIds[] takes precedence over scalar sourceId', async () => {
    // scalar says alpha, array says beta-only — array wins, page found.
    const page = await engine.getPage('secret/beta-doc', { sourceId: 'alpha', sourceIds: ['beta'] });
    expect(page?.title).toBe('Beta secret');
  });
});

describe('get_page handler closes the cross-source exact-read leak', () => {
  test('remote client granted only [alpha] CANNOT read a beta-only slug', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    // Pre-fix this returned the beta page (leak). Now it is scoped out → 404.
    await expect(get_page.handler(ctx, { slug: 'secret/beta-doc' })).rejects.toBeInstanceOf(OperationError);
  });

  test('remote client granted [alpha, beta] CAN read the beta slug', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha', 'beta'] } as any });
    const page: any = await get_page.handler(ctx, { slug: 'secret/beta-doc' });
    expect(page.title).toBe('Beta secret');
  });

  test('remote client granted only [alpha] CAN read its own alpha slug', async () => {
    const ctx = ctxOf({ remote: true, auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['alpha'] } as any });
    const page: any = await get_page.handler(ctx, { slug: 'shared/alpha-doc' });
    expect(page.title).toBe('Alpha doc');
  });
});
