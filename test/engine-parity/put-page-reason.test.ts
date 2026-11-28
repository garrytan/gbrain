/**
 * Engine parity: put_page with a `reason`, through the CLI route and the MCP dispatcher.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain put_page --reason` (parseOpArgs, makeContext, the op handler, normalizeLocalResult, formatResult)
 *    and the MCP `put_page` tool with `reason` commit the page on every engine arm, print the same JSON answer, and
 *    get_versions lists the reason on the version the update archived. The answer is compared byte for byte after the
 *    generated values (ids, revisions, request ids, times) are replaced by their shape.
 *  - Regression: on a Rust brain, a put_page that gave a reason was refused at publication (engine_capability_missing,
 *    member=executeRaw, raw_sql) and nothing was written: the change-reason step (persistence/change-reason.ts) read
 *    the page's world visibility with raw SQL. It now reads the typed readPageWorldVisible.
 *  - Why existing coverage misses it: the put_page parity cases gave no reason, and the reason step runs only when one
 *    is given.
 *  - Seam: none. Real engines; the CLI route of src/cli/main.ts and the MCP dispatcher.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { formatResult, makeContext, normalizeLocalResult, parseOpArgs } from '../../src/cli/main.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const { parityTest } = parityArms(testBackends());

const putPage = operations.find(o => o.name === 'put_page')!;
const getVersions = operations.find(o => o.name === 'get_versions')!;
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const content = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;
const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
/** The printed answer with generated values replaced by their shape, so two engines' answers compare byte for byte. */
function shape(text: string): string {
  return text.replace(UUID, '<uuid>').replace(ISO, '<time>')
    .replace(/"(id|page_id|version_id|request_row_id|write_request_id)":\s*"?\d+"?/g, '"$1":<n>');
}

/** The reasons the get_versions operation lists for `slug` (each version's `replaced_because`), newest first. */
async function reasons(engine: BrainEngine, slug: string): Promise<Array<string | null>> {
  const ctx = await makeContext(engine, { slug }, getVersions as never);
  const versions = normalizeLocalResult(await getVersions.handler(ctx, { slug })) as Array<{ replaced_because?: string | null }>;
  return versions.map(v => v.replaced_because ?? null);
}

describe('engine parity: put_page with a reason', () => {
  parityTest('CLI: gbrain put_page --reason --json commits the update and prints the same JSON answer', {
    methods: ['readPageSnapshot', 'getVersions'],
    timeout: 60_000,
  }, async (engine) => {
    const slug = 'notes/reason-cli';
    try {
      const run = async (args: string[]) => {
        const params = parseOpArgs(putPage, args);
        const ctx = await makeContext(engine, params, putPage as never);
        const result = normalizeLocalResult(await putPage.handler(ctx, params));
        return shape(formatResult(putPage.name, result, params));
      };
      const created = await run([slug, '--content', content('Reason CLI', 'First body.'), '--json']);
      const updated = await run([slug, '--content', content('Reason CLI', 'Second body.'), '--reason', 'fix a typo',
        '--expected-revision', await revisionOf(engine, slug), '--json']);
      const answer = { created, updated, body: (await engine.getPage(slug))?.compiled_truth, reasons: await reasons(engine, slug) };
      expect(JSON.parse(updated).state ?? JSON.parse(updated).status).toBeTruthy();
      expect(answer.body).toContain('Second body.');
      expect(answer.reasons).toContain('fix a typo');
      return answer;
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('MCP: the put_page tool with a reason commits the update and answers the same text', {
    methods: ['readPageSnapshot', 'getVersions'],
    timeout: 60_000,
  }, async (engine) => {
    const slug = 'notes/reason-mcp';
    try {
      const call = async (params: Record<string, unknown>) => {
        const result = await dispatchToolCall(engine, 'put_page', params, { remote: false, transport: 'stdio', sourceId: 'default', writeWaitMs: 8000,
          config: { engine: engine.kind, embedding_disabled: true } as never, logger });
        return { isError: result.isError === true, text: shape((result.content[0] as { text: string }).text) };
      };
      const created = await call({ slug, content: content('Reason MCP', 'First body.') });
      const updated = await call({ slug, content: content('Reason MCP', 'Second body.'), reason: 'fix a typo',
        expected_revision: await revisionOf(engine, slug) });
      const answer = { created, updated, body: (await engine.getPage(slug))?.compiled_truth, reasons: await reasons(engine, slug) };
      expect(answer.updated.isError).toBe(false);
      expect(answer.body).toContain('Second body.');
      expect(answer.reasons).toContain('fix a typo');
      return answer;
    } finally { await disposePersistenceConsumer(engine); }
  });
});
