/**
 * BrainEngine parity: the put_page write guard for readers named in a frontmatter block the parser does not read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: put_page, run through the real operation handler on each engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), refuses content that opens with an indented
 *    frontmatter fence naming `readable_by` (block style or a `{...}` flow mapping) with `invalid_frontmatter`, and the page
 *    does not exist afterward. A fence in the first column still stores the page, and so does an indented fence that names
 *    no readers.
 *  - Regression: an engine or a write path that lets the content through stores a page every member can read while its
 *    author believes it is restricted (the parser reads frontmatter only when the fence is in the first column).
 *  - Why existing coverage misses it: the cases in this directory call typed engine members; none runs the write
 *    guard in page-prepare.ts, which is shared TypeScript that every engine's put_page goes through.
 *  - Seam: the put_page operation handler over the arm's engine. The write path still reads and writes through raw
 *    SQL, so the case requires `raw_sql`; an engine without it stops on the typed refusal before the guard.
 *    The Rust arm is such an engine today: its first write stops on `engine_capability_missing` (raw_sql), the harness
 *    counts that as a stop, and the guard itself is reached only on the SQL arms until the Rust engine serves the write path.
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
const body = 'A page about acme-example.\n';

describe('engine parity: put_page unread readers block guard', () => {
  parityTest('put_page refuses an indented fence that names readers as invalid_frontmatter and stores nothing; a first-column fence and an indented fence with no readers still store', {
    methods: ['getPage'], requires: 'raw_sql',
  }, async (engine) => {
    const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const put = (slug: string, content: string) => (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, unknown>>)
      .then((result) => ({ code: null as string | null, status: String(result.status) }), (e: { code?: string; canonical?: string }) => {
        // An engine without raw SQL stops on its typed refusal; the harness reads that as the arm's outcome, so it must reach it.
        if (e.code === 'engine_capability_missing') throw e;
        return { code: e.canonical ?? e.code ?? null, status: 'refused' };
      });
    try {
      const outcomes: Record<string, { code: string | null; status: string }> = {
        column_zero: await put('notes/column-zero', `---\ntitle: Example\ntype: note\nreadable_by: [alice-example]\n---\n${body}`),
        indented: await put('notes/indented', ` ---\ntitle: Example\ntype: note\nreadable_by: [alice-example]\n---\n${body}`),
        flow_cased: await put('notes/flow-cased', ` ---\n{title: Example, Readable_By: [alice-example]}\n---\n${body}`),
        flow_exact: await put('notes/flow-exact', ` ---\n{title: Example, readable_by: [alice-example]}\n---\n${body}`),
        no_readers: await put('notes/no-readers', ` ---\ntitle: Example\ntype: note\n---\n${body}`),
      };
      const stored: Record<string, boolean> = {};
      for (const slug of ['column-zero', 'indented', 'flow-cased', 'flow-exact', 'no-readers']) stored[slug] = (await engine.getPage(`notes/${slug}`)) !== null;
      expect(outcomes.column_zero!.code).toBeNull();
      expect(outcomes.no_readers!.code).toBeNull();
      for (const key of ['indented', 'flow_cased', 'flow_exact']) expect({ key, code: outcomes[key]!.code }).toEqual({ key, code: 'invalid_frontmatter' });
      expect(stored).toEqual({ 'column-zero': true, indented: false, 'flow-cased': false, 'flow-exact': false, 'no-readers': true });
      return { outcomes, stored };
    } finally {
      await disposePersistenceConsumer(engine);
    }
  });
});
