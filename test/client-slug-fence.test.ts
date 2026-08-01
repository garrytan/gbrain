/**
 * OAuth-client slug-fence tests (v0.42.70.0 — write-side isolation symmetry).
 *
 * enforceClientSlugFence confines a bound client's direct writes to slugs
 * under its `oauth_clients.bound_slug_prefixes`. This pins:
 *  - regression: no auth / unbound client → every op accepts any slug
 *    (local CLI and unbound-remote behavior unchanged);
 *  - fence: each slug-mutating write op rejects out-of-binding slugs with
 *    permission_denied, BEFORE the dry-run short-circuit (all denials here
 *    run with dryRun=true and an empty engine stub);
 *  - fail-closed: an empty-array binding denies all writes (matches
 *    submit_agent's posture for the same column);
 *  - add_link/remove_link fence the `from` endpoint only — linking TO a
 *    page outside the binding is a reference, not a mutation of it.
 */

import { describe, test, expect } from 'bun:test';
import {
  operations, OperationError, slugUnderBoundPrefixes,
  enforceBoundClientOpAllowList, CLIENT_FENCED_WRITE_OPS,
} from '../src/core/operations.ts';
import type { OperationContext, Operation, AuthInfo } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function op(name: string): Operation {
  const found = operations.find(o => o.name === name);
  if (!found) throw new Error(`${name} op missing`);
  return found;
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'shared',
    ...overrides,
  };
}

function boundAuth(prefixes: string[] | undefined): AuthInfo {
  return {
    token: 'test-token',
    clientId: 'gbrain_cl_fence_test',
    scopes: ['read', 'write'],
    sourceId: 'shared',
    ...(prefixes !== undefined ? { boundSlugPrefixes: prefixes } : {}),
  };
}

// Every fenced op with a params factory for an arbitrary slug.
const FENCED_OPS: Array<{ name: string; params: (slug: string) => Record<string, unknown> }> = [
  { name: 'put_page', params: (slug) => ({ slug, content: 'stub' }) },
  { name: 'delete_page', params: (slug) => ({ slug }) },
  { name: 'restore_page', params: (slug) => ({ slug }) },
  { name: 'add_tag', params: (slug) => ({ slug, tag: 't' }) },
  { name: 'remove_tag', params: (slug) => ({ slug, tag: 't' }) },
  { name: 'add_link', params: (slug) => ({ from: slug, to: 'org-wiki/roadmap' }) },
  { name: 'remove_link', params: (slug) => ({ from: slug, to: 'org-wiki/roadmap' }) },
  { name: 'add_timeline_entry', params: (slug) => ({ slug, date: '2026-08-01', summary: 's' }) },
  { name: 'revert_version', params: (slug) => ({ slug, version_id: 1 }) },
  { name: 'put_raw_data', params: (slug) => ({ slug, source: 'src', data: {} }) },
];

describe('client slug fence (bound_slug_prefixes on direct writes)', () => {
  describe('regression: unbound callers unchanged', () => {
    for (const { name, params } of FENCED_OPS) {
      test(`${name}: no ctx.auth accepts arbitrary slug`, async () => {
        const result = await op(name).handler(makeCtx(), params('anywhere/at-all'));
        expect(result).toMatchObject({ dry_run: true });
      });

      test(`${name}: authed client WITHOUT binding accepts arbitrary slug`, async () => {
        const ctx = makeCtx({ auth: boundAuth(undefined) });
        const result = await op(name).handler(ctx, params('anywhere/at-all'));
        expect(result).toMatchObject({ dry_run: true });
      });
    }
  });

  describe('fence: bound client confined to its prefixes', () => {
    const auth = boundAuth(['chan-eng/', 'emp-alice/']);

    for (const { name, params } of FENCED_OPS) {
      test(`${name}: in-binding slug accepted`, async () => {
        const ctx = makeCtx({ auth });
        const result = await op(name).handler(ctx, params('chan-eng/standup-notes'));
        expect(result).toMatchObject({ dry_run: true });
      });

      test(`${name}: out-of-binding slug rejected with permission_denied`, async () => {
        const ctx = makeCtx({ auth });
        try {
          await op(name).handler(ctx, params('chan-product/roadmap'));
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(OperationError);
          expect((e as OperationError).code).toBe('permission_denied');
          expect((e as Error).message).toContain('bound_slug_prefixes');
        }
      });
    }

    test('second prefix also admits writes', async () => {
      const ctx = makeCtx({ auth });
      const result = await op('put_page').handler(ctx, { slug: 'emp-alice/journal', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('prefix match is plain startsWith — bare slug equal to a prefix-less-slash is rejected', async () => {
      const ctx = makeCtx({ auth });
      const p = op('put_page').handler(ctx, { slug: 'chan-eng', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('add_link: `to` outside the binding is allowed (reference, not mutation)', async () => {
      const ctx = makeCtx({ auth });
      const result = await op('add_link').handler(ctx, { from: 'chan-eng/decision', to: 'org-wiki/anything' });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('local CLI (no auth, remote=false) is never fenced', async () => {
      const ctx = makeCtx({ remote: false });
      const result = await op('put_page').handler(ctx, { slug: 'people/alice', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true });
    });
  });

  describe('fail-closed: empty-array binding denies all writes', () => {
    test('put_page with boundSlugPrefixes=[] rejects every slug', async () => {
      const ctx = makeCtx({ auth: boundAuth([]) });
      const p = op('put_page').handler(ctx, { slug: 'anywhere/at-all', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('empty-string prefix cannot silently disable the fence', () => {
    // startsWith('') is true for every slug, so a stray '' (an unset variable
    // in a provisioning template) would render as "bound" while fencing
    // nothing. Registration rejects it; the matcher ignores it anyway.
    test("[''] denies every slug rather than allowing every slug", async () => {
      const ctx = makeCtx({ auth: boundAuth(['']) });
      const p = op('put_page').handler(ctx, { slug: 'anywhere/at-all', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test("a real prefix alongside '' still fences to the real one", async () => {
      const ctx = makeCtx({ auth: boundAuth(['chan-eng/', '']) });
      const ok = await op('put_page').handler(ctx, { slug: 'chan-eng/x', content: 'stub' });
      expect(ok).toMatchObject({ dry_run: true });
      await expect(op('put_page').handler(ctx, { slug: 'other/x', content: 'stub' }))
        .rejects.toBeInstanceOf(OperationError);
    });

    test('slugUnderBoundPrefixes ignores empty prefixes', () => {
      expect(slugUnderBoundPrefixes([''], 'anything')).toBe(false);
      expect(slugUnderBoundPrefixes(['a/'], 'a/b')).toBe(true);
      expect(slugUnderBoundPrefixes(['a/'], 'b/a')).toBe(false);
    });
  });

  describe('dispatch allow-list: unfenceable write ops are denied outright', () => {
    const bound = boundAuth(['emp-alice/']);
    const unbound = boundAuth(undefined);

    // These write by a key other than a slug (derived entity names, numeric
    // fact ids), so no per-op fence can confine them.
    for (const name of ['extract_entities', 'extract_facts', 'forget_fact', 'ontology_propose']) {
      test(`${name} is denied for a bound client`, () => {
        const o = operations.find(x => x.name === name);
        if (!o) throw new Error(`${name} missing`);
        expect(() => enforceBoundClientOpAllowList(bound, o)).toThrow(/not available to slug-bound clients/);
        expect(() => enforceBoundClientOpAllowList(unbound, o)).not.toThrow();
      });
    }

    test('every fenced write op is allowed', () => {
      for (const name of CLIENT_FENCED_WRITE_OPS) {
        const o = operations.find(x => x.name === name);
        if (!o) throw new Error(`${name} missing from operations`);
        expect(() => enforceBoundClientOpAllowList(bound, o)).not.toThrow();
      }
    });

    test('read ops are never gated', () => {
      for (const o of operations.filter(x => x.scope === 'read')) {
        expect(() => enforceBoundClientOpAllowList(bound, o)).not.toThrow();
      }
    });

    // The regression this exists to prevent: a write op added later must be
    // denied by default, not silently unfenced.
    test('a hypothetical new write op is denied by default', () => {
      expect(() => enforceBoundClientOpAllowList(bound, { name: 'brand_new_write_op', scope: 'write' }))
        .toThrow(/not available to slug-bound clients/);
    });
  });

  describe('both prefix grammars are accepted (the column predates this fence)', () => {
    // v85 introduced bound_slug_prefixes for submit_agent, whose grammar is
    // matchesSlugAllowList's `<prefix>/*` glob. Rejecting it here would deny
    // every direct write to already-configured clients on upgrade.
    test('a glob-style binding still matches', () => {
      expect(slugUnderBoundPrefixes(['wiki/agents/alice/*'], 'wiki/agents/alice/notes')).toBe(true);
      expect(slugUnderBoundPrefixes(['wiki/agents/alice/*'], 'wiki/agents/bob/notes')).toBe(false);
    });

    test('a trailing-slash binding still matches', () => {
      expect(slugUnderBoundPrefixes(['emp-alice/'], 'emp-alice/notes')).toBe(true);
      expect(slugUnderBoundPrefixes(['emp-alice/'], 'emp-alice-evil/notes')).toBe(false);
    });

    // The `emp-<slug>` scheme makes sibling collisions the common case:
    // `alice` and `alice-2` are different people. A plain startsWith let a
    // boundary-less binding reach the neighbour's namespace.
    test('a boundary-less prefix does NOT reach a sibling namespace', () => {
      expect(slugUnderBoundPrefixes(['emp-alice'], 'emp-alice/notes')).toBe(true);
      expect(slugUnderBoundPrefixes(['emp-alice'], 'emp-alice')).toBe(true);
      expect(slugUnderBoundPrefixes(['emp-alice'], 'emp-alice-2/onboarding')).toBe(false);
      expect(slugUnderBoundPrefixes(['emp-alice'], 'emp-alicexyz/secret')).toBe(false);
    });

    test('trailing-slash and glob forms are equally boundary-safe', () => {
      for (const p of ['emp-alice/', 'emp-alice/*']) {
        expect(slugUnderBoundPrefixes([p], 'emp-alice/notes')).toBe(true);
        expect(slugUnderBoundPrefixes([p], 'emp-alice-2/notes')).toBe(false);
      }
    });

    test('the canonical (lowercased) slug is what is matched', () => {
      // validateSlug lowercases before storage, so the fence must compare the
      // form that actually gets written — not the caller's raw string.
      expect(slugUnderBoundPrefixes(['emp-alice/'], 'EMP-ALICE/Notes')).toBe(true);
      expect(slugUnderBoundPrefixes(['emp-alice/'], 'EMP-BOB/Notes')).toBe(false);
    });
  });

  describe('degraded fence projection fails closed', () => {
    test('writes are refused when bound_slug_prefixes could not be read', async () => {
      const ctx = makeCtx({
        auth: { ...boundAuth(undefined), fenceProjectionDegraded: true },
      });
      const p = op('put_page').handler(ctx, { slug: 'anything/at-all', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/cannot be evaluated/);
    });
  });

  describe('composition with the subagent fence', () => {
    test('both fences apply: subagent namespace passes but client binding rejects', async () => {
      const ctx = makeCtx({
        viaSubagent: true,
        subagentId: 42,
        auth: boundAuth(['chan-eng/']),
      });
      const p = op('put_page').handler(ctx, { slug: 'wiki/agents/42/notes', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/bound_slug_prefixes/);
    });
  });
});
