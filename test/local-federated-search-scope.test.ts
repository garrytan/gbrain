/**
 * #2561 — sources.config.federated participates in UNQUALIFIED local CLI
 * search/query.
 *
 * Pre-fix: the local CLI always emitted a scalar `{sourceId}` scope (required
 * field, auto-filled 'default'), so a source registered with
 * `gbrain sources add --federated` was invisible to an unqualified
 * `gbrain search "X"` — contradicting docs/guides/multi-source-brains.md
 * ("Source participates in unqualified `gbrain search` results").
 *
 * Fix: the CLI context builder computes `ctx.localFederatedSourceIds`
 * (resolved source + every other federated source) whenever the source
 * resolved via a NON-explicit tier; `federatedSearchScope` widens the scalar
 * scope to that set for the `search` / `query` ops — trusted-local only
 * (`ctx.remote === false`), never for remote callers, never when a per-call
 * `source_id` or an explicit --source/env/dotfile was given.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localFederatedSourceIds } from '../src/core/source-resolver.ts';
import {
  federatedSearchScope,
  operations,
  type OperationContext,
} from '../src/core/operations.ts';

let engine: PGLiteEngine;
const search = operations.find((o) => o.name === 'search')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seeded 'default' source is federated=true. Add:
  //   wiki    — federated (must join unqualified search)
  //   private — NOT federated (must stay invisible unless explicitly named)
  //   oldnews — federated but archived (must stay excluded)
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('wiki', 'wiki', '/tmp/wiki', '{"federated": true}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('private', 'private', '/tmp/private', '{}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived) VALUES ('oldnews', 'oldnews', '/tmp/oldnews', '{"federated": true}'::jsonb, true)`,
  );
  const pages: Array<[slug: string, sourceId: string, where: string]> = [
    ['notes/home', 'default', 'default'],
    ['wiki/topic', 'wiki', 'wiki'],
    ['private/topic', 'private', 'private'],
    ['old/topic', 'oldnews', 'oldnews'],
  ];
  for (const [slug, sourceId, where] of pages) {
    await engine.putPage(slug, {
      type: 'note', title: `Topic in ${where}`, compiled_truth: `the zebra telescope in ${where}`, frontmatter: {},
    }, { sourceId });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: `the zebra telescope in ${where}`, chunk_source: 'compiled_truth' },
    ], { sourceId });
  }
  // Keyword-only search path: no embedding provider needed in tests.
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('localFederatedSourceIds — CLI-side scope computation', () => {
  test('non-explicit tier: resolved source first, then other federated, archived excluded', async () => {
    expect(await localFederatedSourceIds(engine, 'default', 'seed_default')).toEqual(['default', 'wiki']);
  });

  test('non-federated resolved source still joins its own scope', async () => {
    expect(await localFederatedSourceIds(engine, 'private', 'brain_default')).toEqual(['private', 'default', 'wiki']);
  });

  test('explicit tiers (--source / env / dotfile) never expand', async () => {
    expect(await localFederatedSourceIds(engine, 'default', 'flag')).toBeUndefined();
    expect(await localFederatedSourceIds(engine, 'default', 'env')).toBeUndefined();
    expect(await localFederatedSourceIds(engine, 'default', 'dotfile')).toBeUndefined();
  });

  test('single federated source (the resolved one) keeps the scalar fast path', async () => {
    const solo = { executeRaw: async () => [{ id: 'default' }] } as any;
    expect(await localFederatedSourceIds(solo, 'default', 'seed_default')).toBeUndefined();
  });
});

describe('federatedSearchScope — trust + explicitness matrix', () => {
  test('trusted local + unqualified widens to the federated set', () => {
    const ctx = ctxOf({ localFederatedSourceIds: ['default', 'wiki'] });
    expect(federatedSearchScope(ctx)).toEqual({ sourceIds: ['default', 'wiki'] });
  });

  test('remote caller NEVER widens (fail-closed), even if the field is set', () => {
    const ctx = ctxOf({ remote: true, localFederatedSourceIds: ['default', 'wiki'] });
    expect(federatedSearchScope(ctx)).toEqual({ sourceId: 'default' });
  });

  test('per-call source_id wins over the federated set', () => {
    const ctx = ctxOf({ localFederatedSourceIds: ['default', 'wiki'] });
    expect(federatedSearchScope(ctx, 'wiki')).toEqual({ sourceId: 'wiki' });
  });

  test('per-call __all__ keeps the whole-brain semantics for trusted local', () => {
    const ctx = ctxOf({ localFederatedSourceIds: ['default', 'wiki'] });
    expect(federatedSearchScope(ctx, '__all__')).toEqual({});
  });

  test('a federated OAuth grant wins over the local set', () => {
    const ctx = ctxOf({
      localFederatedSourceIds: ['default', 'wiki'],
      auth: { allowedSources: ['a', 'b'] } as OperationContext['auth'],
    });
    expect(federatedSearchScope(ctx)).toEqual({ sourceIds: ['a', 'b'] });
  });

  test('no local federated set → unchanged scalar scope', () => {
    expect(federatedSearchScope(ctxOf())).toEqual({ sourceId: 'default' });
  });
});

describe('search op — unqualified local search spans federated sources', () => {
  test('federated source results appear; non-federated + archived stay invisible', async () => {
    const ctx = ctxOf({
      localFederatedSourceIds: await localFederatedSourceIds(engine, 'default', 'seed_default'),
    });
    const results = (await search.handler(ctx, { query: 'zebra telescope' })) as Array<{ slug: string }>;
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain('notes/home');
    expect(slugs).toContain('wiki/topic'); // pre-#2561 this was missing
    expect(slugs).not.toContain('private/topic');
    expect(slugs).not.toContain('old/topic');
  });

  test('explicit source resolution (no federated set on ctx) stays single-source', async () => {
    const results = (await search.handler(ctxOf(), { query: 'zebra telescope' })) as Array<{ slug: string }>;
    const slugs = results.map((r) => r.slug);
    expect(slugs).toEqual(['notes/home']);
  });
});
