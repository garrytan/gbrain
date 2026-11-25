/**
 * A read whose scan for other stored spellings of a slug fails with a real database error falls back to the normal
 * form of the slug; only an engine that does not serve the scan (a typed capability refusal) is treated as "no other spelling
 * known" and keeps looking at the spellings it already read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: `withNormalizedSlugParams` (src/core/ops/slug-params.ts, chooseSpelling) hands a read the normal-form slug
 *     when the stored-spelling scan throws anything other than `engine_capability_missing`; with that refusal it still
 *     answers a soft-deleted page stored under the caller's lowercased spelling.
 *  2. Regression: master's silent read-catch guard (#9902) flagged chooseSpelling's empty catch, which turned every scan
 *     failure into "no other spelling" and then answered a soft-deleted spelling as if the scan had found nothing.
 *  3. Existing coverage: test/slug-legacy-rows.test.ts and test/slug-normalize-reads.test.ts cover the scan when it works.
 *  4. Seam: the engine handed to the wrapper throws from the typed stored-spelling scan (`readStoredSlugSpellings`, the
 *     member chooseSpelling calls) only; every other call reaches a real PGLite engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { withNormalizedSlugParams } from '../src/core/ops/slug-params.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const RAW = 'Notes/Cafe\u0301-scan';
const STORED = 'notes/cafe\u0301-scan';
const NORMAL = 'notes/caf\u00e9-scan';

let engine: PGLiteEngine;

/** `engine` with the stored-spelling scan replaced by `fail`; every other member is the real engine's. */
function failingScan(fail: () => never): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'readStoredSlugSpellings') return () => fail();
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrainEngine;
}

async function slugHandedToRead(e: BrainEngine): Promise<string> {
  let seen = '';
  const op = { name: 'get_tags', mutating: false } as unknown as Operation;
  const wrapped = withNormalizedSlugParams(op, async (_ctx, params) => { seen = String((params as { slug: string }).slug); return []; });
  const ctx = { engine: e, config: { engine: 'pglite' } as never, remote: false, sourceId: 'default', dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  await wrapped(ctx, { slug: RAW });
  return seen;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(NORMAL, { type: 'note', title: 'Scan', compiled_truth: 'Body.', timeline: '' });
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2', [STORED, NORMAL]);
  await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE slug = $1', [STORED]);
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

describe('a failed stored-spelling scan', () => {
  test('a real database error falls back to the normal form, not to a soft-deleted spelling', async () => {
    const slug = await slugHandedToRead(failingScan(() => { throw new Error('connection reset by peer'); }));
    expect(slug).toBe(NORMAL);
  });

  test('a capability refusal (an engine that does not serve the scan) still answers the soft-deleted spelling it read', async () => {
    const refusal = Object.assign(new Error('the engine does not serve readStoredSlugSpellings'), { code: 'engine_capability_missing', reason: 'pages',
      detail: 'member=readStoredSlugSpellings capability=pages outcome=none written=nothing' });
    const slug = await slugHandedToRead(failingScan(() => { throw refusal; }));
    expect(slug).toBe(STORED);
  });
});
