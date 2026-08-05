/**
 * put_page dedup resolved-slug fence (v0.42.73.1).
 *
 * importFromContent's dedup pre-check can resolve a write to a DIFFERENT page
 * than the caller named (same `frontmatter.id`), and the disk write-through
 * runs against that RESOLVED slug. The re-check that fences it shipped in
 * v0.42.72.0 testing `ctx.auth.boundSlugPrefixes` only — so a slug-bound
 * OAuth client holding `agent` scope could delegate the write through
 * submit_agent, whose subagent context carries `viaSubagent` +
 * `allowedSlugPrefixes` but NO `auth`, and land the rewrite on a page outside
 * its grant.
 *
 * Pins: every confinement a caller can be under fences the RESOLVED slug
 * (OAuth binding, trusted-workspace allow-list, legacy subagent namespace),
 * unconfined callers keep the dedup redirect, an in-fence redirect still
 * works, and the denial never names the resolved slug (it would be a
 * slug-enumeration oracle).
 *
 * PGLite hermetic. Every case resolves at the dedup pre-check, which returns
 * before any chunk/embed work.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation, AuthInfo } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const VICTIM_SLUG = 'people/alice-example';
const VICTIM_ID = 'external-uuid-victim';

function put(): Operation {
  const found = operations.find(o => o.name === 'put_page');
  if (!found) throw new Error('put_page op missing');
  return found;
}

function page(id: string, body: string): string {
  return ['---', 'type: concept', 'title: Notes', `id: ${id}`, '---', '', body].join('\n');
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

function boundAuth(prefixes: string[]): AuthInfo {
  return {
    token: 'test-token',
    clientId: 'gbrain_cl_dedup_fence',
    scopes: ['read', 'write', 'agent'],
    sourceId: 'default',
    boundSlugPrefixes: prefixes,
  };
}

/** The attacker's move: echo the victim's frontmatter id under an in-fence slug. */
async function putEchoingVictimId(ctx: OperationContext, slug: string, id = VICTIM_ID) {
  return put().handler(ctx, { slug, content: page(id, 'Attacker body, different text.') });
}

async function expectFenced(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe('permission_denied');
    expect((e as Error).message).toContain('write scope');
    // The oracle guard: the resolved slug belongs to a page the caller may
    // not see, so it must never appear in the denial.
    expect((e as Error).message).not.toContain('alice-example');
  }
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
  const victim = await importFromContent(engine, VICTIM_SLUG, page(VICTIM_ID, 'Confidential.'), {
    noEmbed: true,
    sourceId: 'default',
  });
  expect(victim.status).toBe('imported');
});

describe('put_page: dedup-resolved slug is fenced by the caller\'s own confinement', () => {
  test('delegated subagent (allow-list, NO auth) cannot rewrite an out-of-fence page', async () => {
    // The bypass: submit_agent's subagent context carries allowedSlugPrefixes
    // but no auth, so an auth-only re-check skipped exactly this caller.
    const ctx = makeCtx({
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/agents/7/*'],
    });
    await expectFenced(putEchoingVictimId(ctx, 'wiki/agents/7/notes'));
  });

  test('legacy sandbox subagent (namespace fence, no allow-list) cannot either', async () => {
    const ctx = makeCtx({ viaSubagent: true, subagentId: 7 });
    await expectFenced(putEchoingVictimId(ctx, 'wiki/agents/7/notes'));
  });

  test('slug-bound OAuth client cannot (the v0.42.72.0 case, still fenced)', async () => {
    const ctx = makeCtx({ auth: boundAuth(['emp-bob/']) });
    await expectFenced(putEchoingVictimId(ctx, 'emp-bob/notes'));
  });

  test('a caller under BOTH confinements is fenced (requested slug satisfies both)', async () => {
    const ctx = makeCtx({
      auth: boundAuth(['emp-bob/']),
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['emp-bob/*'],
    });
    await expectFenced(putEchoingVictimId(ctx, 'emp-bob/notes'));
  });

  test('feature preserved: a redirect INSIDE the fence still dedups', async () => {
    const inFence = await importFromContent(engine, 'wiki/agents/7/first', page('in-fence-id', 'Body.'), {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(inFence.status).toBe('imported');

    const ctx = makeCtx({
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/agents/7/*'],
    });
    const r = await putEchoingVictimId(ctx, 'wiki/agents/7/second', 'in-fence-id') as {
      slug: string; status: string;
    };
    expect(r.status).toBe('skipped');
    expect(r.slug).toBe('wiki/agents/7/first');
  });

  test('feature preserved: a bound client\'s in-fence redirect still dedups', async () => {
    // The OAuth mirror of the case above — the fence must not break the happy
    // path it was already allowing before this change.
    const inFence = await importFromContent(engine, 'emp-bob/first', page('bob-id', 'Body.'), {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(inFence.status).toBe('imported');

    const ctx = makeCtx({ auth: boundAuth(['emp-bob/']) });
    const r = await putEchoingVictimId(ctx, 'emp-bob/second', 'bob-id') as {
      slug: string; status: string;
    };
    expect(r.status).toBe('skipped');
    expect(r.slug).toBe('emp-bob/first');
  });

  test('fail-closed: viaSubagent without a subagentId is denied before any write', async () => {
    // enforceSubagentSlugFence refuses rather than trusting a dispatcher that
    // set viaSubagent but forgot the id — the branch slugUnderSubagentFence
    // would otherwise evaluate against 'wiki/agents/undefined/'.
    const ctx = makeCtx({ viaSubagent: true });
    const p = putEchoingVictimId(ctx, 'wiki/agents/7/notes');
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/requires ctx\.subagentId/);
  });

  test('regression: an unconfined caller keeps the dedup redirect', async () => {
    const r = await putEchoingVictimId(makeCtx(), 'anywhere/notes') as { slug: string; status: string };
    expect(r.status).toBe('skipped');
    expect(r.slug).toBe(VICTIM_SLUG);
  });
});
