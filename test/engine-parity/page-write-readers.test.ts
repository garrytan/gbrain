/**
 * BrainEngine parity: the put_page write guard for the readers key.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: put_page, run through the real operation handler on each engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), refuses content whose frontmatter names its
 *    readers with a key that is not exactly `readable_by` (`Readable_By: [alice-example]`) with the code
 *    `readers_noncanonical`, and the page does not exist afterward. The exact key still stores the page.
 *  - Regression: an engine or a write path that lets the misspelled key through stores a page every member can
 *    read while its author believes it is restricted (page access reads only the exact key).
 *  - Why existing coverage misses it: the cases in this directory call typed engine members; none runs the write
 *    guard in page-prepare.ts, which is shared TypeScript that every engine's put_page goes through.
 *  - Seam: the put_page operation handler over the arm's engine. The write path still reads and writes through raw
 *    SQL, so the case requires `raw_sql`; an engine without it stops on the typed refusal before the guard.
 *    The Rust arm is such an engine today: its first write (the `exact` page) stops on `engine_capability_missing`
 *    (raw_sql), the harness counts that as a stop, and the guard itself is reached only on the SQL arms until the
 *    Rust engine serves the write path.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const putPage = operations.find((op) => op.name === 'put_page')!;
const page = (extra: string) => `---\ntitle: Example\ntype: note\n${extra}---\nA page about acme-example.\n`;

describe('engine parity: put_page readers key guard', () => {
  parityTest('put_page refuses a misspelled readable_by key as readers_noncanonical and stores nothing; the exact key still stores', {
    methods: ['getPage'], requires: 'raw_sql',
  }, async (engine) => {
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = (slug: string, content: string) => (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)
      .then((result) => ({ code: null as string | null, status: String(result.status) }), (e: { code?: string }) => {
        // An engine without raw SQL stops on its typed refusal; the harness reads that as the arm's outcome, so it must reach it.
        if (e.code === 'engine_capability_missing') throw e;
        return { code: e.code ?? null, status: 'refused' };
      });
    try {
      const outcomes: Record<string, { code: string | null; status: string }> = {
        exact: await put('notes/exact', page('readable_by: [alice-example]\n')),
        cased: await put('notes/cased', page('Readable_By: [alice-example]\n')),
        hyphen: await put('notes/hyphen', page('readable-by: [alice-example]\n')),
        camel: await put('notes/camel', page('readableBy: [alice-example]\n')),
        both: await put('notes/both', page('readable_by: [alice-example]\nREADABLE_BY: [bob-example]\n')),
      };
      const stored: Record<string, boolean> = {};
      for (const slug of ['exact', 'cased', 'hyphen', 'camel', 'both']) stored[slug] = (await engine.getPage(`notes/${slug}`)) !== null;
      expect(outcomes.exact!.code).toBeNull();
      for (const key of ['cased', 'hyphen', 'camel', 'both']) expect({ key, code: outcomes[key]!.code }).toEqual({ key, code: 'readers_noncanonical' });
      expect(stored).toEqual({ exact: true, cased: false, hyphen: false, camel: false, both: false });
      return { outcomes, stored };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
});
