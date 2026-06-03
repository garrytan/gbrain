/**
 * Regression guard for the put_page rich-page overwrite guard.
 *
 * Contract: agent / remote callers (ctx.remote !== false) cannot overwrite a
 * page whose existing compiled_truth is >= RICH_PAGE_MIN_CHARS via put_page,
 * unless they pass force=true. Trusted local CLI callers (ctx.remote === false)
 * are never constrained and the guard does not even read the existing page.
 *
 * The guard runs BEFORE the dry-run short-circuit, so:
 *   - blocked cases reject regardless of dryRun (a preview surfaces the block),
 *   - allowed cases fall through to the dry-run early-return, which lets these
 *     tests stay hermetic (no real importFromContent / engine write needed).
 */

import { describe, test, expect } from 'bun:test';
import { operations, RICH_PAGE_MIN_CHARS, type OperationContext } from '../src/core/operations.ts';
import type { Page } from '../src/core/types.ts';

const STUB_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };
const STUB_CONFIG = {} as unknown as Parameters<typeof operations[number]['handler']>[0]['config'];

type EngineArg = Parameters<typeof operations[number]['handler']>[0]['engine'];

function findOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`operation ${name} not found`);
  return op;
}

// Engine stub whose getPage returns a fixed page (or null). Every OTHER method
// throws — proving the guard short-circuits before any write and that the
// allowed paths reach the dry-run early-return, not a real engine write.
function stubEngineReturning(page: Page | null): EngineArg {
  return new Proxy({} as never, {
    get(_t, prop: string) {
      if (prop === 'getPage') return async () => page;
      return () => { throw new Error(`engine.${prop} should not have been called — guard/dry-run gate failed`); };
    },
  }) as EngineArg;
}

// Engine stub where EVERY method throws — used for the local-caller case to
// prove the guard is skipped entirely (getPage is never even called).
function stubEngineNeverCalled(): EngineArg {
  return new Proxy({} as never, {
    get(_t, prop: string) {
      return () => { throw new Error(`engine.${prop} should not have been called — local caller must bypass the guard`); };
    },
  }) as EngineArg;
}

function makePage(compiledTruthLen: number): Page {
  // Only compiled_truth is read by the guard; cast past the full Page shape.
  return { slug: 'people/alice', compiled_truth: 'x'.repeat(compiledTruthLen) } as unknown as Page;
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: stubEngineReturning(null),
    config: STUB_CONFIG,
    logger: STUB_LOGGER,
    dryRun: true,        // allowed cases short-circuit at the dry-run return
    remote: true,        // agent / remote caller by default
    viaSubagent: false,  // not a subagent → skip namespace check, reach the guard
    ...overrides,
  } as OperationContext;
}

const put_page = findOp('put_page');
const CONTENT = '---\ntitle: x\n---\nnew body';

describe('put_page — rich-page overwrite guard', () => {
  test('BLOCKS remote overwrite of a page at exactly the threshold (>= is inclusive), no force', async () => {
    const ctx = makeCtx({ dryRun: false, engine: stubEngineReturning(makePage(RICH_PAGE_MIN_CHARS)) });
    await expect(put_page.handler(ctx, { slug: 'people/alice', content: CONTENT }))
      .rejects.toMatchObject({ code: 'rich_page_overwrite_blocked' });
  });

  test('BLOCKS even on a dry-run preview (guard precedes the dry-run short-circuit)', async () => {
    const ctx = makeCtx({ dryRun: true, engine: stubEngineReturning(makePage(500)) });
    await expect(put_page.handler(ctx, { slug: 'people/alice', content: CONTENT }))
      .rejects.toMatchObject({ code: 'rich_page_overwrite_blocked' });
  });

  test('ALLOWS when the existing page is thin (< threshold)', async () => {
    const ctx = makeCtx({ engine: stubEngineReturning(makePage(RICH_PAGE_MIN_CHARS - 1)) });
    const res = await put_page.handler(ctx, { slug: 'people/alice', content: CONTENT });
    expect(res).toMatchObject({ dry_run: true, action: 'put_page' });
  });

  test('ALLOWS when no page exists yet (getPage -> null)', async () => {
    const ctx = makeCtx({ engine: stubEngineReturning(null) });
    const res = await put_page.handler(ctx, { slug: 'people/alice', content: CONTENT });
    expect(res).toMatchObject({ dry_run: true });
  });

  test('ALLOWS a rich-page overwrite when force=true', async () => {
    const ctx = makeCtx({ engine: stubEngineReturning(makePage(500)) });
    const res = await put_page.handler(ctx, { slug: 'people/alice', content: CONTENT, force: true });
    expect(res).toMatchObject({ dry_run: true });
  });

  test('ALLOWS trusted local CLI callers (remote=false) and never reads the page', async () => {
    const ctx = makeCtx({ remote: false, engine: stubEngineNeverCalled() });
    const res = await put_page.handler(ctx, { slug: 'people/alice', content: CONTENT });
    expect(res).toMatchObject({ dry_run: true });
  });
});
