/**
 * Per-API-key default source pinning (v38 migration).
 *
 * Mirror of test/oauth-source-pinning.test.ts for the legacy access_tokens
 * table. API keys (no TTL) are preferred over OAuth tokens (TTL) for headless
 * agent setups, so the same source-pin ergonomics need to land here.
 *
 * Coverage:
 *   1. verifyAccessToken populates AuthInfo.defaultSourceId from the legacy
 *      access_tokens row (no extra DB roundtrip).
 *   2. API key without default_source_id → AuthInfo.defaultSourceId is
 *      undefined → put_page writes to 'default'.
 *   3. API key with default_source_id → put_page with no source_id param
 *      writes to the pinned source.
 *   4. Explicit params.source_id always overrides ctx.defaultSourceId.
 *   5. Source deleted while pinned → FK ON DELETE SET NULL clears the pin;
 *      subsequent verifyAccessToken returns undefined and writes fall back
 *      to 'default'.
 *
 * Uses PGLite in-memory (matches test/oauth-source-pinning.test.ts pattern).
 * No Docker required, no DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { hashToken, generateToken } from '../src/core/utils.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;
let engine: PGLiteEngine;

beforeAll(async () => {
  // Stand up a real engine via the production lifecycle (connect + initSchema)
  // so all migrations — including the new v38 we're testing — are applied.
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as any);
  await engine.initSchema();

  // Wrap the engine's underlying PGLite so the OAuth provider and our test
  // assertions can speak raw SQL against the same DB the engine writes to.
  const db = (engine as any).db;
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''),
      '',
    );
    const result = await db.query(query, values as any[]);
    return result.rows;
  };

  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });

  // Seed two non-default sources so we can pin/unpin between them.
  await sql`INSERT INTO sources (id, name, config) VALUES ('agent-a', 'Agent A', '{}'::jsonb) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO sources (id, name, config) VALUES ('agent-b', 'Agent B', '{}'::jsonb) ON CONFLICT DO NOTHING`;
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 15_000);

beforeEach(async () => {
  // Wipe pages + access tokens between tests so token reuse doesn't leak.
  await sql`DELETE FROM pages`;
  await sql`DELETE FROM access_tokens`;
});

// ---------------------------------------------------------------------------
// Helper: insert a legacy API key row and return the raw bearer token.
// Mirrors the production CLI path (`gbrain auth create <name>`) without going
// through postgres.js / cli.ts.
// ---------------------------------------------------------------------------
async function makeApiKey(
  name: string,
  defaultSourceId: string | null = null,
): Promise<{ name: string; token: string }> {
  const token = generateToken('gbrain_');
  const hash = hashToken(token);
  await sql`
    INSERT INTO access_tokens (name, token_hash, default_source_id)
    VALUES (${name}, ${hash}, ${defaultSourceId})
  `;
  return { name, token };
}

// ---------------------------------------------------------------------------
// Helper: stand up a minimal OperationContext for direct handler invocation.
// Matches the shape serve-http.ts builds, minus logger noise.
// ---------------------------------------------------------------------------
function makeCtx(defaultSourceId?: string) {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true as const,
    auth: undefined,
    defaultSourceId,
  };
}

const PAGE_CONTENT = `---
type: concept
title: Test Page
---

# Test Page

Body content for source-pinning tests.
`;

// ===========================================================================
// 1. verifyAccessToken populates AuthInfo.defaultSourceId via legacy path
// ===========================================================================

describe('verifyAccessToken (legacy API key) returns defaultSourceId', () => {
  test('populates defaultSourceId when API key has a pin', async () => {
    const { token } = await makeApiKey('pinned-key', 'agent-a');
    const auth = await provider.verifyAccessToken(token);
    expect((auth as any).defaultSourceId).toBe('agent-a');
    // Legacy tokens still get full admin scopes.
    expect((auth as any).scopes).toEqual(['read', 'write', 'admin']);
    // clientId == clientName == name for legacy tokens (single identifier).
    expect((auth as any).clientId).toBe('pinned-key');
    expect((auth as any).clientName).toBe('pinned-key');
  });

  test('defaultSourceId is undefined when API key is unpinned', async () => {
    const { token } = await makeApiKey('free-key', null);
    const auth = await provider.verifyAccessToken(token);
    expect((auth as any).defaultSourceId).toBeUndefined();
  });

  test('revoked API key still rejects (revoked_at filter intact)', async () => {
    const { token } = await makeApiKey('revoked-key', 'agent-a');
    await sql`UPDATE access_tokens SET revoked_at = now() WHERE name = 'revoked-key'`;
    await expect(provider.verifyAccessToken(token)).rejects.toThrow(/Invalid token/);
  });
});

// ===========================================================================
// 2. Source-pinning precedence (params > ctx.defaultSourceId > 'default')
//    — same handler precedence as OAuth, exercised via API-key-issued ctx.
// ===========================================================================

describe('put_page handler precedence (API key path)', () => {
  async function getOps() {
    const ops = await import('../src/core/operations.ts');
    return ops.operations;
  }

  test('ctx.defaultSourceId from API key routes write when no param given', async () => {
    const { token } = await makeApiKey('writer-pinned', 'agent-a');
    const auth = await provider.verifyAccessToken(token);
    const ctx = makeCtx((auth as any).defaultSourceId);

    const ops = await getOps();
    const putPage = ops.find((o: any) => o.name === 'put_page')!;
    await putPage.handler(ctx as any, {
      slug: 'concepts/api-key-pinned',
      content: PAGE_CONTENT,
    });
    const [row] = await sql`SELECT source_id FROM pages WHERE slug = 'concepts/api-key-pinned'`;
    expect(row.source_id).toBe('agent-a');
  });

  test('unpinned API key → ctx pin undefined → falls back to default source', async () => {
    const { token } = await makeApiKey('writer-free', null);
    const auth = await provider.verifyAccessToken(token);
    const ctx = makeCtx((auth as any).defaultSourceId);

    const ops = await getOps();
    const putPage = ops.find((o: any) => o.name === 'put_page')!;
    await putPage.handler(ctx as any, {
      slug: 'concepts/api-key-free',
      content: PAGE_CONTENT,
    });
    const [row] = await sql`SELECT source_id FROM pages WHERE slug = 'concepts/api-key-free'`;
    expect(row.source_id).toBe('default');
  });

  test('explicit params.source_id overrides API-key pin', async () => {
    const { token } = await makeApiKey('writer-override', 'agent-a');
    const auth = await provider.verifyAccessToken(token);
    const ctx = makeCtx((auth as any).defaultSourceId);

    const ops = await getOps();
    const putPage = ops.find((o: any) => o.name === 'put_page')!;
    await putPage.handler(ctx as any, {
      slug: 'concepts/api-key-override',
      content: PAGE_CONTENT,
      source_id: 'agent-b',
    });
    const [row] = await sql`SELECT source_id FROM pages WHERE slug = 'concepts/api-key-override'`;
    expect(row.source_id).toBe('agent-b');
  });
});

// ===========================================================================
// 3. Source deletion clears the pin (FK ON DELETE SET NULL)
// ===========================================================================

describe('orphaned API-key source pin', () => {
  test('deleting the pinned source clears default_source_id', async () => {
    await sql`INSERT INTO sources (id, name, config) VALUES ('throwaway-k', 'Throwaway K', '{}'::jsonb) ON CONFLICT DO NOTHING`;
    await makeApiKey('orphan-key-test', 'throwaway-k');

    // Sanity: pin landed.
    const [before] = await sql`SELECT default_source_id FROM access_tokens WHERE name = 'orphan-key-test'`;
    expect(before.default_source_id).toBe('throwaway-k');

    // Delete the source — pages-FK cascade fires first; we have no rows there.
    await sql`DELETE FROM pages WHERE source_id = 'throwaway-k'`;
    await sql`DELETE FROM sources WHERE id = 'throwaway-k'`;

    const [after] = await sql`SELECT default_source_id FROM access_tokens WHERE name = 'orphan-key-test'`;
    expect(after.default_source_id).toBeNull();
  });

  test('verifyAccessToken after orphan returns undefined defaultSourceId; write falls back to default', async () => {
    await sql`INSERT INTO sources (id, name, config) VALUES ('temp-src-k', 'Temp K', '{}'::jsonb) ON CONFLICT DO NOTHING`;
    const { token } = await makeApiKey('fallback-key-test', 'temp-src-k');
    await sql`DELETE FROM sources WHERE id = 'temp-src-k'`;

    // Re-verify the token: defaultSourceId should now be undefined (FK SET NULL).
    const auth = await provider.verifyAccessToken(token);
    expect((auth as any).defaultSourceId).toBeUndefined();

    // Simulate the dispatcher: ctx.defaultSourceId is undefined →
    // put_page lands in 'default'.
    const ctx = makeCtx((auth as any).defaultSourceId);
    const ops = (await import('../src/core/operations.ts')).operations;
    const putPage = ops.find((o: any) => o.name === 'put_page')!;
    await putPage.handler(ctx as any, {
      slug: 'concepts/api-key-post-orphan',
      content: PAGE_CONTENT,
    });
    const [row] = await sql`SELECT source_id FROM pages WHERE slug = 'concepts/api-key-post-orphan'`;
    expect(row.source_id).toBe('default');
  });
});
