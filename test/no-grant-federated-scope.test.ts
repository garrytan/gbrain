/**
 * #3242 parity for the SDK HTTP transport (`serve --http`).
 *
 * The legacy HTTP transport and the stdio dispatch site both widen an
 * UNQUALIFIED read to the federated source set when the caller carries no
 * operator source grant. The SDK transport in `src/commands/serve-http.ts`
 * never did, so one legacy bearer token saw federated pages over `/mcp` on one
 * serve mode and scalar 'default' on the other — a brain whose code lives in a
 * non-default source answered `code_def` on one and came back empty on the
 * other.
 *
 * `noGrantFederatedScope` is the decision that transport now shares. These
 * tests pin the part that is easy to get wrong: WHICH callers may widen. The
 * gate is `hasSourceGrant === false`, not a falsy check, because `undefined`
 * means an OAuth client and must NOT widen — a falsy gate would quietly hand
 * every OAuth client the whole federated set.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seeded 'default' is federated. 'wiki' joins it; 'private' opted out and
  // must never appear in a widened scope.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('wiki', 'wiki', '/tmp/wiki', '{"federated": true}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('private', 'private', '/tmp/private', '{}'::jsonb)`,
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('noGrantFederatedScope — which callers may widen', () => {
  test('no-grant legacy bearer token widens to the federated set', async () => {
    expect(await noGrantFederatedScope(engine, false, 'default')).toEqual(['default', 'wiki']);
  });

  test('operator-granted token keeps its scalar scope', async () => {
    expect(await noGrantFederatedScope(engine, true, 'default')).toBeUndefined();
  });

  test('OAuth client (flag undefined) keeps its scalar scope', async () => {
    // The regression a falsy gate would introduce: undefined is not "no grant".
    expect(await noGrantFederatedScope(engine, undefined, 'default')).toBeUndefined();
  });

  test('no resolved source id: nothing to widen from', async () => {
    expect(await noGrantFederatedScope(engine, false, undefined)).toBeUndefined();
    expect(await noGrantFederatedScope(engine, false, '')).toBeUndefined();
  });

  test('a non-default anchor widens from itself, excluding the unfederated source', async () => {
    const scope = await noGrantFederatedScope(engine, false, 'wiki');
    expect(scope).toEqual(['wiki', 'default']);
    expect(scope).not.toContain('private');
  });

  test('an unreadable sources table leaves the scalar scope standing', async () => {
    const broken = {
      executeRaw: async () => {
        throw new Error('sources table unavailable');
      },
    } as any;
    expect(await noGrantFederatedScope(broken, false, 'default')).toBeUndefined();
  });
});
