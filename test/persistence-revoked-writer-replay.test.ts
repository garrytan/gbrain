/**
 * A local writer revoked after it committed a write is refused on PGLite: both a
 * replay of the committed request_id and a new write end with permission_denied.
 * The pre-admission cache is Postgres-only (preadmitReads returns null here), so
 * this file pins the uncached behaviour that the Postgres cases in
 * test/e2e/single-write-fast-path-postgres.test.ts compare the cache against.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { managedBrain } from './helpers/managed-brain.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { preadmitReads } from '../src/core/persistence/preadmit-cache.ts';

const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const failure = (run: Promise<unknown>) => run.then(() => null, (error: { code?: string }) => ({ code: error.code }));

describe('a revoked local writer on PGLite', () => {
  for (const next of ['the same request_id', 'a new write'] as const) {
    test(`commits once, is revoked, then ${next} is refused`, async () => {
      await managedBrain(async ({ engine, ctx }) => {
        expect(await preadmitReads(engine)).toBeNull();
        const params = { slug: 'notes/revoked', request_id: randomUUID(), content: page('Revoked', 'Committed before the revoke.') };
        const first = await submitPageMutation(ctx, { operation: 'put_page', params: { ...params }, waitMs: 20_000 });
        expect(first.state).toBe('committed');
        const [row] = await engine.executeRaw<{ principal_id: string }>("SELECT principal_id FROM persistence_requests WHERE slug='notes/revoked'");
        await revokeLocalWriter(engine, row!.principal_id);
        const again = next === 'the same request_id' ? params : { slug: 'notes/after', request_id: randomUUID(), content: page('After', 'After the revoke.') };
        expect(await failure(submitPageMutation(ctx, { operation: 'put_page', params: { ...again }, waitMs: 20_000 }))).toEqual({ code: 'permission_denied' });
      });
    }, 60_000);
  }
});
