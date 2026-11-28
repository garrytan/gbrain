/**
 * BrainEngine parity: get_backlinks answers the same for a page the caller cannot read and a page that does not exist.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a remote world-only caller, get_backlinks on a slug whose only page in scope is one the caller may
 *    not read (`visibility: private`, or `readable_by` naming someone else) gives exactly the answer it gives for a slug
 *    with no page: with `group: "page"` the empty page (`total: 0`), with or without a `type` filter, an unknown `type`
 *    included; in array mode the empty list. When the same slug also holds a readable page in another source the
 *    caller may read, that page answers, as it does when the hidden page is absent. A trusted local caller still has
 *    an unknown `type` refused on a private page it can read.
 *  - Regression: the target lookup ignored the caller's read policy, so a hidden target reached the type check and an
 *    unknown `type` was refused, where a missing target answered empty; and a hidden page in the first source in scope
 *    shadowed a readable page with the same slug in a later one.
 *  - Why existing coverage misses it: backlinks-type-exists-gbra449.test.ts checks which types a refusal names, and
 *    its unknown-type reads all target a readable page.
 *  - Seam: none. Real engines, through the operation handler and the MCP dispatcher. The Rust engine does not serve
 *    the referrer read (raw SQL), so the handler cases declare `requires: 'raw_sql'` and the Rust arm must stop on
 *    that typed refusal; the MCP case runs on every arm and compares the hidden and missing answers byte for byte.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest, arms } = parityArms(testBackends());

const HIDDEN = { 'notes/hidden-private': { visibility: 'private' }, 'notes/hidden-readers': { readable_by: ['alice-example'] } } as const;
const MISSING = 'notes/missing';
const UNKNOWN_TYPE = 'zz-not-a-type';

async function seed(engine: BrainEngine): Promise<void> {
  __resetPrivateVisibilityCacheForTests();
  for (const [slug, frontmatter] of Object.entries(HIDDEN)) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Hidden.', timeline: '', frontmatter: { ...frontmatter } });
  }
  await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'Open.', timeline: '' });
}

function remoteCtx(engine: BrainEngine, backend: ParityBackend, extra: Partial<OperationContext> = {}): OperationContext {
  return { engine, config: { engine: backend === 'rust' ? 'pglite' : backend }, remote: true, transport: 'stdio', dryRun: false,
    sourceId: 'default', takesHoldersAllowList: ['world'], logger: { info() {}, warn() {}, error() {} }, emitNotice() {}, ...extra } as unknown as OperationContext;
}

/** The op's answer as the caller sees it: the result, or the error's code, message and hint. */
async function answer(ctx: OperationContext, params: Record<string, unknown>): Promise<unknown> {
  try {
    return { ok: await operationsByName.get_backlinks!.handler(ctx, params) };
  } catch (e) {
    const err = e as { code?: string; message?: string; suggestion?: string; detail?: string };
    if (err.code === 'engine_capability_missing') throw e;
    return { error: { code: err.code, message: err.message, suggestion: err.suggestion, detail: err.detail } };
  }
}

const READS: Array<Record<string, unknown>> = [
  { group: 'page', type: UNKNOWN_TYPE },
  { group: 'page', type: 'note' },
  { group: 'page' },
  { type: UNKNOWN_TYPE },
  {},
];

describe('engine parity: get_backlinks hidden target equals missing target', () => {
  parityTest('a hidden target answers like a missing one, on every read shape', { methods: ['putPage'], requires: 'raw_sql' }, async (engine, backend) => {
    await seed(engine);
    const ctx = remoteCtx(engine, backend);
    const out: Record<string, unknown> = {};
    for (const params of READS) {
      const key = JSON.stringify(params);
      const missing = await answer(ctx, { slug: MISSING, ...params });
      for (const hidden of Object.keys(HIDDEN)) {
        expect({ hidden, params, got: await answer(ctx, { slug: hidden, ...params }) }).toEqual({ hidden, params, got: missing });
      }
      out[key] = missing;
    }
    expect(out[JSON.stringify(READS[0])]).toMatchObject({ ok: { total: 0, rows: [] } });
    return out;
  });

  parityTest('a hidden page does not shadow a readable page with the same slug in another source', { methods: ['putPage', 'addLink'], requires: 'raw_sql' }, async (engine, backend) => {
    await createSource(engine, backend, 'source-b');
    __resetPrivateVisibilityCacheForTests();
    const b = { sourceId: 'source-b' };
    await engine.putPage('notes/shared', { type: 'note', title: 'Shared', compiled_truth: 'Readable.', timeline: '' }, b);
    await engine.putPage('notes/ref', { type: 'note', title: 'Ref', compiled_truth: 'Points at notes/shared.', timeline: '' }, b);
    await engine.addLink('notes/ref', 'notes/shared', 'Points at notes/shared.', 'mentions', 'markdown', undefined, undefined, { fromSourceId: 'source-b', toSourceId: 'source-b' });
    const ctx = remoteCtx(engine, backend, { auth: { allowedSources: ['default', 'source-b'] } } as Partial<OperationContext>);
    // `coverage` is the brain-wide mention-pass state, not an answer about this slug, and writing the hidden page moves it.
    const withoutCoverage = (a: unknown) => {
      const ok = (a as { ok?: Record<string, unknown> }).ok;
      if (!ok) return a;
      const { coverage: _coverage, ...rest } = ok;
      return { ok: rest };
    };
    const read = async () => ({ page: withoutCoverage(await answer(ctx, { slug: 'notes/shared', group: 'page' })),
      typed: withoutCoverage(await answer(ctx, { slug: 'notes/shared', group: 'page', type: UNKNOWN_TYPE })) });
    const absent = await read();
    await engine.putPage('notes/shared', { type: 'note', title: 'Shared', compiled_truth: 'Hidden.', timeline: '', frontmatter: { visibility: 'private' } });
    __resetPrivateVisibilityCacheForTests();
    const hidden = await read();
    expect(hidden).toEqual(absent);
    expect(absent.page).toMatchObject({ ok: { total: 1, rows: [{ slug: 'notes/ref', source_id: 'source-b' }] } });
    // Row dates are each arm's own write time: compare the rest across arms.
    return JSON.parse(JSON.stringify(absent, (k, v) => (k === 'date' ? undefined : v)));
  });

  parityTest('a trusted local caller still has an unknown type refused on a private page', { methods: ['putPage'], requires: 'raw_sql' }, async (engine, backend) => {
    await seed(engine);
    const got = await answer({ ...remoteCtx(engine, backend), remote: false, takesHoldersAllowList: undefined } as OperationContext,
      { slug: 'notes/hidden-private', group: 'page', type: UNKNOWN_TYPE });
    expect(got).toMatchObject({ error: { code: 'invalid_params' } });
    return got;
  });

  test('MCP: the hidden and missing answers are byte-identical on every arm', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      await seed(arm.engine);
      const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config: { engine: arm.backend } };
      for (const params of READS) {
        const call = async (slug: string) => JSON.stringify(await dispatchToolCall(arm.engine, 'get_backlinks', { slug, ...params }, opts as never));
        const missing = await call(MISSING);
        for (const hidden of Object.keys(HIDDEN)) {
          expect({ backend: arm.backend, hidden, params, got: await call(hidden) }).toEqual({ backend: arm.backend, hidden, params, got: missing });
        }
      }
    }
  }, 120_000);
});
