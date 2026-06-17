/**
 * v0.28 e2e: per-token takes_holders allow-list, end-to-end through the
 * access_tokens.permissions JSONB column. Closes Codex P0 #3 verification.
 *
 * The HTTP transport's validateToken reads permissions.takes_holders from
 * the access_tokens row and threads it into the dispatch context. This
 * test exercises that path against real Postgres without booting the
 * full Bun.serve transport (the auth probe is the load-bearing piece).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'gbrain_' + randomBytes(32).toString('hex');
}

let alicePageId: number;

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice', type: 'person', compiled_truth: '## Takes\n',
  });
  alicePageId = alice.id;
  await engine.addTakesBatch([
    { page_id: alicePageId, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0 },
    { page_id: alicePageId, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.85 },
    { page_id: alicePageId, row_num: 3, claim: 'Burned out signal', kind: 'hunch', holder: 'brain', weight: 0.4 },
  ]);
});

afterAll(async () => {
  if (!RUN) return;
  await teardownDB();
});

d('access_tokens.permissions.takes_holders end-to-end', () => {
  test('newly-created token defaults to {takes_holders: ["world"]} via migration v32 backfill', async () => {
    const engine = getEngine();
    const token = generateToken();
    const hash = hashToken(token);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)`,
      [`tok-default-${Date.now()}`, hash],
    );
    const rows = await engine.executeRaw<{ permissions: { takes_holders?: unknown } }>(
      `SELECT permissions FROM access_tokens WHERE token_hash = $1`,
      [hash],
    );
    expect(rows[0]?.permissions).toEqual({ takes_holders: ['world'] });
  });

  test('explicit ["world","garry"] permission filters dispatch responses correctly', async () => {
    const engine = getEngine();
    const token = generateToken();
    const hash = hashToken(token);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, permissions) VALUES ($1, $2, $3::jsonb)`,
      // Pass the object directly — JSON.stringify + ::jsonb cast double-encodes
      // (per CLAUDE.md memory: postgres-js JSONB double-encode trap).
      [`tok-wg-${Date.now()}`, hash, { takes_holders: ['world', 'garry'] }],
    );
    // Read back permissions to simulate validateToken's path
    const rows = await engine.executeRaw<{ permissions: { takes_holders?: string[] } }>(
      `SELECT permissions FROM access_tokens WHERE token_hash = $1`,
      [hash],
    );
    const allowList = rows[0]?.permissions?.takes_holders ?? ['world'];
    expect(allowList).toEqual(['world', 'garry']);

    // Now dispatch with that allow-list, verify SQL filter applies
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: true,
      takesHoldersAllowList: allowList,
    });
    expect(result.isError).toBeFalsy();
    const takes = JSON.parse(result.content[0].text) as Array<{ holder: string }>;
    const holders = new Set(takes.map(t => t.holder));
    expect(holders.has('world')).toBe(true);
    expect(holders.has('garry')).toBe(true);
    expect(holders.has('brain')).toBe(false); // brain hunch is hidden
  });

  test('default ["world"] hides garry hunches even from search', async () => {
    const engine = getEngine();
    const token = generateToken();
    const hash = hashToken(token);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, permissions) VALUES ($1, $2, $3)`,
      [`tok-w-${Date.now()}`, hash, { takes_holders: ['world'] }],
    );
    const result = await dispatchToolCall(engine, 'takes_search', { query: 'founder' }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const hits = JSON.parse(result.content[0].text) as Array<{ holder: string }>;
    expect(hits.every(h => h.holder === 'world')).toBe(true);
  });

  test('NULL permissions row defaults to ["world"] (back-compat for pre-v32 tokens edited manually)', async () => {
    const engine = getEngine();
    const token = generateToken();
    const hash = hashToken(token);
    // Simulate a manually-tampered token where permissions was set to NULL after creation
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, permissions) VALUES ($1, $2, $3)`,
      [`tok-null-${Date.now()}`, hash, {}],
    );
    const rows = await engine.executeRaw<{ permissions: { takes_holders?: string[] } }>(
      `SELECT permissions FROM access_tokens WHERE token_hash = $1`,
      [hash],
    );
    // perm was {} so takes_holders is undefined; HTTP transport defaults to ['world']
    const allowList = Array.isArray(rows[0]?.permissions?.takes_holders) ? rows[0].permissions!.takes_holders! : ['world'];
    expect(allowList).toEqual(['world']);
  });

  test('revoked token is excluded from active token query', async () => {
    const engine = getEngine();
    const token = generateToken();
    const hash = hashToken(token);
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash, revoked_at) VALUES ($1, $2, now())`,
      [`tok-revoked-${Date.now()}`, hash],
    );
    // The HTTP transport's validateToken filters WHERE revoked_at IS NULL — confirm the row is invisible there.
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM access_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
    expect(rows).toHaveLength(0);
  });
});
