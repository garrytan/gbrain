/**
 * F4a (O-ENG-13): the get_health op memo (`src/core/health-memo.ts`).
 *
 * Contracts protected:
 *   - a repeat call with no page/config change inside the TTL is served from
 *     the memo (`computed_at` unchanged); a page write, a config change, TTL
 *     expiry, `repair --apply` and `doctor --remediate` each force fresh
 *     numbers, so no caller sees a pre-repair score;
 *   - entries never cross scopes: warming as the trusted caller and then
 *     reading with disjoint source grants, in both orders, returns exactly
 *     what an uncached `engine.getHealth(scope)` returns for each grant, with
 *     `most_connected` confined to the grant;
 *   - an empty grant computes zeros and never reads the brain-wide entry;
 *   - TTL 0 (env or config) disables the memo.
 * A links-only write does not advance the page clock, which is what lets
 * these tests tell a memo hit from a recompute.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainHealth } from '../src/core/types.ts';
import { clearHealthMemo, healthScopeKey, memoizedHealth, HEALTH_CACHE_TTL_KEY } from '../src/core/health-memo.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { runRemediate } from '../src/commands/doctor/remediate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { HEALTH_SRC_A, HEALTH_SRC_B, seedSourceScopeFixture } from './helpers/health-equality-fixtures.ts';

type OpHealth = BrainHealth & { computed_at: string; embedding_column: string; migrations: unknown };

let engine: PGLiteEngine;
let now = Date.parse('2026-10-03T12:00:00.000Z');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  setSystemTime();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  clearHealthMemo();
  now += 3_600_000;
  setSystemTime(new Date(now));
  await seedSourceScopeFixture(engine);
});

afterEach(() => { setSystemTime(); _resetCliExitVerdictForTests(); });

const advance = (ms: number) => { now += ms; setSystemTime(new Date(now)); };

const trusted = () => ({ engine, remote: false }) as unknown as OperationContext;
const remote = (extra: Partial<OperationContext>) =>
  ({ engine, remote: true, transport: 'http', takesHoldersAllowList: ['world'], ...extra }) as unknown as OperationContext;
const health = async (ctx: OperationContext) => (await operationsByName.get_health.handler(ctx, {})) as OpHealth;
const counters = ({ computed_at, embedding_column, migrations, ...rest }: OpHealth) => rest;
const degree = (h: BrainHealth) => h.most_connected.find(m => m.slug === 'people/alice-example')?.link_count ?? -1;
const fresh = (scope?: { sourceId?: string; sourceIds?: string[] }) => engine.getHealth(scope);

let probe = 0;
async function linkOnlyWrite(): Promise<void> {
  probe++;
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type)
     SELECT b.id, a.id, 'memo-probe-${probe}' FROM pages a, pages b
      WHERE a.slug = 'notes/alpha' AND b.slug = 'people/alice-example'`,
  );
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('the documented opt-out key is a known config key, so `gbrain config set health.cache_ttl_ms 0` needs no --force', () => {
  expect(KNOWN_CONFIG_KEYS).toContain(HEALTH_CACHE_TTL_KEY);
});

describe('get_health memo (O-ENG-13)', () => {
  test('a repeat call inside the TTL is memoized; a page write recomputes', async () => {
    const first = await health(trusted());
    expect(first.computed_at).toBe(new Date(now).toISOString());
    expect(counters(first)).toEqual(await fresh());
    await linkOnlyWrite();
    advance(1_000);
    const second = await health(trusted());
    expect(second.computed_at).toBe(first.computed_at);
    expect(degree(second)).toBe(degree(first));
    await engine.putPage('notes/beta', { type: 'note', title: 'Beta', compiled_truth: 'beta' });
    const third = await health(trusted());
    expect(third.computed_at).toBe(new Date(now).toISOString());
    expect(counters(third)).toEqual(await fresh());
    expect(degree(third)).toBe(degree(first) + 1);
  });

  for (const order of ['trusted-first', 'grants-first'] as const) {
    test(`disjoint grants stay confined when warmed ${order}`, async () => {
      const calls: Array<[string, OperationContext, { sourceId?: string; sourceIds?: string[] } | undefined]> = [
        ['trusted', trusted(), undefined],
        ['scalar A', remote({ sourceId: HEALTH_SRC_A }), { sourceId: HEALTH_SRC_A }],
        ['federated B', remote({ sourceId: 'default', auth: { token: 't', clientId: 'c', scopes: ['read', 'admin'], allowedSources: [HEALTH_SRC_B] } } as never), { sourceIds: [HEALTH_SRC_B] }],
      ];
      if (order === 'grants-first') calls.reverse();
      for (const [, ctx] of calls) await health(ctx);
      for (const [label, ctx, scope] of calls) {
        const got = await health(ctx);
        expect({ label, got: counters(got) }).toEqual({ label, got: await fresh(scope) });
      }
      const a = await health(remote({ sourceId: HEALTH_SRC_A }));
      const b = await health(calls.find(c => c[0] === 'federated B')![1]);
      expect(a.page_count).toBe(2);
      expect(b.page_count).toBe(1);
      expect(a.most_connected.map(m => m.slug)).toEqual(['people/alice-example']);
      expect(b.most_connected.map(m => m.slug)).toEqual(['people/bob-example']);
      expect(a.most_connected[0].link_count).toBe(1);
      expect(b.most_connected[0].link_count).toBe(0);
    });
  }

  test('an empty grant computes zeros and never reads the brain-wide entry', async () => {
    const all = await health(trusted());
    expect(all.page_count).toBe(3);
    let computed = 0;
    const empty = await memoizedHealth(engine, { sourceIds: [] }, async () => {
      computed++;
      return fresh({ sourceIds: [] });
    });
    expect(computed).toBe(1);
    expect(empty.page_count).toBe(0);
    expect(empty.most_connected).toEqual([]);
    const sentinel = await health(remote({ sourceId: '__all__' }));
    expect(sentinel.page_count).toBe(0);
    expect(sentinel.most_connected).toEqual([]);
    expect(healthScopeKey({})).toBe('all');
    expect(healthScopeKey({ sourceIds: [] })).toBe('empty');
    expect(healthScopeKey({ sourceId: '__none__' })).toBe('empty');
    expect(healthScopeKey({ sourceId: '' })).toBe('all');
    expect(healthScopeKey({ sourceId: 'a' })).toBe('scalar:a');
    expect(healthScopeKey({ sourceIds: ['b', 'a', 'b'] })).toBe('set:a,b');
  });

  test('changing orphan exclusions recomputes with the new policy', async () => {
    const before = await health(trusted());
    expect(before.linkable_page_count).toBe(3);
    await engine.setConfig('orphans.exclude_prefixes', 'notes/');
    const after = await health(trusted());
    expect(after.linkable_page_count).toBe(2);
    expect(counters(after)).toEqual(await fresh());
  });

  test('repair --apply clears the memo: no pre-repair score', async () => {
    const warm = await health(trusted());
    await linkOnlyWrite();
    expect(degree(await health(trusted()))).toBe(degree(warm));
    await quietly(() => runRepairCommand(engine, ['timeline', '--apply', '--no-embed', '--json']));
    const after = await health(trusted());
    expect(degree(after)).toBe(degree(warm) + 1);
    expect(counters(after)).toEqual(await fresh());
  });

  test('doctor --remediate clears the memo', async () => {
    const warm = await health(trusted());
    await linkOnlyWrite();
    await quietly(() => runRemediate(engine, ['--yes', '--json', '--no-embed', '--max-jobs', '0']));
    const after = await health(trusted());
    expect(degree(after)).toBe(degree(warm) + 1);
  });

  test('the TTL expires entries; 0 disables the memo (env and config)', async () => {
    await withEnv({ GBRAIN_HEALTH_CACHE_TTL_MS: '1000' }, async () => {
      const warm = await health(trusted());
      await linkOnlyWrite();
      advance(999);
      expect((await health(trusted())).computed_at).toBe(warm.computed_at);
      advance(1);
      const expired = await health(trusted());
      expect(expired.computed_at).not.toBe(warm.computed_at);
      expect(degree(expired)).toBe(degree(warm) + 1);
    });
    await withEnv({ GBRAIN_HEALTH_CACHE_TTL_MS: '0' }, async () => {
      const a = await health(trusted());
      await linkOnlyWrite();
      expect(degree(await health(trusted()))).toBe(degree(a) + 1);
    });
    await withEnv({ GBRAIN_HEALTH_CACHE_TTL_MS: undefined }, async () => {
      await engine.setConfig(HEALTH_CACHE_TTL_KEY, '0');
      const a = await health(trusted());
      await linkOnlyWrite();
      expect(degree(await health(trusted()))).toBe(degree(a) + 1);
    });
  });
});
