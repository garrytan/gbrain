/**
 * #2928 — `gbrain sources unfederate <id>` (config.federated = false) must
 * keep the isolated source out of UNQUALIFIED reads.
 *
 * The leak: tier 5.5 (#1434) anchors an unqualified call on the sole
 * non-default source — correct for writes and for the anchor itself — but
 * `localFederatedSourceIds` then widened that anchor into the federated set
 * (`[isolated-src, default]`), mixing the isolated source's pages with
 * federated sources' pages in unqualified query/search/think, both
 * directions. The fix is READ-ONLY: an explicitly isolated anchor
 * (config.federated === false) is never widened; scalar scope stands.
 *
 * Deliberately unchanged (pinned below):
 *   - tier 5.5 write routing — `--no-federated` governs read mixing, not
 *     where unqualified sync/import land (#1434,
 *     test/sync-sole-non-default-routing.test.ts);
 *   - the unscoped-local invariant that sank #3470/#3497: an empty scope
 *     must stay UNSCOPED ({}), never collapse to 'default'.
 *
 * All imports here exist on master, so this file runs against an unmodified
 * master checkout and fails BEHAVIORALLY there (the widened scope contains
 * both sources).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  resolveSourceWithTier,
  localFederatedSourceIds,
} from '../src/core/source-resolver.ts';
import {
  sourceScopeOpts,
  federatedSearchScope,
  type OperationContext,
} from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
/** A cwd guaranteed to be outside every registered source local_path. */
let outsideCwd: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** Resolve with the env tier neutralized (host shell may set GBRAIN_SOURCE). */
function resolveClean(explicit: string | null, cwd: string) {
  return withEnv({ GBRAIN_SOURCE: undefined }, () => resolveSourceWithTier(engine, explicit, cwd));
}

beforeEach(async () => {
  await resetPgliteState(engine);
  outsideCwd = mkdtempSync(join(tmpdir(), 'gbrain-2928-cwd-'));
});

async function addSource(id: string, config: Record<string, unknown>): Promise<void> {
  const localPath = mkdtempSync(join(tmpdir(), `gbrain-2928-${id}-`));
  // $N::text::jsonb (never bare ::jsonb on a stringified param) per the
  // JSONB invariant in CLAUDE.md.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)`,
    [id, localPath, JSON.stringify(config)],
  );
}

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    ...overrides,
  } as OperationContext;
}

describe('#2928 — isolated anchor is never widened into a cross-source read', () => {
  test('explicitly isolated resolved source gets NO federated widening set', async () => {
    await addSource('isolated-src', { federated: false });
    // Master returns ['isolated-src', 'default'] here (the seeded default is
    // federated), which mixes the isolated source's pages with default's in
    // every unqualified query/search/think — the #2928 report.
    const localFed = await localFederatedSourceIds(engine, 'isolated-src', 'sole_non_default');
    expect(localFed).toBeUndefined();
  });

  test('full unqualified read chain stays scalar: no default pages mixed in', async () => {
    await addSource('isolated-src', { federated: false });
    const resolved = await resolveClean(null, outsideCwd);
    // Write/anchor routing is UNCHANGED: the sole vault still resolves (#1434).
    expect(resolved.source_id).toBe('isolated-src');
    expect(resolved.tier).toBe('sole_non_default');
    const localFed = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
    const ctx = ctxOf({
      sourceId: resolved.source_id,
      ...(localFed ? { localFederatedSourceIds: localFed } : {}),
    });
    // Scalar scope: the isolated source is not mixed with 'default' (and
    // vice versa). Master produces { sourceIds: ['isolated-src','default'] }.
    expect(federatedSearchScope(ctx)).toEqual({ sourceId: 'isolated-src' });
  });

  test('isolated brain_default anchor is not widened either (same seam)', async () => {
    await addSource('isolated-src', { federated: false });
    const localFed = await localFederatedSourceIds(engine, 'isolated-src', 'brain_default');
    expect(localFed).toBeUndefined();
  });

  test('UNSET federated keeps the #1434 sole-source convenience (no over-narrowing)', async () => {
    await addSource('vault', {});
    const resolved = await resolveClean(null, outsideCwd);
    expect(resolved.source_id).toBe('vault');
    expect(resolved.tier).toBe('sole_non_default');
    // Only an EXPLICIT federated:false suppresses widening; unset keeps the
    // pre-#2928 behavior (the seeded 'default' is federated).
    const localFed = await localFederatedSourceIds(engine, 'vault', 'sole_non_default');
    expect(localFed).toEqual(['vault', 'default']);
  });

  test('federated: true sole source still auto-resolves', async () => {
    await addSource('wiki', { federated: true });
    const resolved = await resolveClean(null, outsideCwd);
    expect(resolved.source_id).toBe('wiki');
    expect(resolved.tier).toBe('sole_non_default');
  });

  test('explicit --source still reaches an isolated source (only unqualified routing changes)', async () => {
    await addSource('isolated-src', { federated: false });
    const resolved = await resolveClean('isolated-src', outsideCwd);
    expect(resolved.source_id).toBe('isolated-src');
    expect(resolved.tier).toBe('flag');
  });

  test('multi-source brain: widening set already excludes the isolated source (pin)', async () => {
    await addSource('isolated-src', { federated: false });
    await addSource('wiki', { federated: true });
    // Two non-default sources → tier 5.5 stays out; resolution lands on 'default'.
    const resolved = await resolveClean(null, outsideCwd);
    expect(resolved.source_id).toBe('default');
    const localFed = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
    expect(localFed).toEqual(['default', 'wiki']);
    const scope = federatedSearchScope(ctxOf({ sourceId: 'default', localFederatedSourceIds: localFed }));
    expect(scope).toEqual({ sourceIds: ['default', 'wiki'] });
  });
});

describe('unscoped local path stays UNSCOPED (the #3470/#3497 regression class)', () => {
  test('sourceScopeOpts with no sourceId and no grant returns {} — never "default"', () => {
    expect(sourceScopeOpts(ctxOf())).toEqual({});
  });

  test('federatedSearchScope with an empty local context returns {} (brain-wide read)', () => {
    expect(federatedSearchScope(ctxOf())).toEqual({});
  });

  test('empty allowedSources [] does not widen; scalar sourceId wins', () => {
    const ctx = ctxOf({ sourceId: 'a', auth: { allowedSources: [] } as any });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceId: 'a' });
  });

  test('federated grant outranks scalar (precedence ladder pin)', () => {
    const ctx = ctxOf({ sourceId: 'a', auth: { allowedSources: ['a', 'b'] } as any });
    expect(sourceScopeOpts(ctx)).toEqual({ sourceIds: ['a', 'b'] });
  });
});
