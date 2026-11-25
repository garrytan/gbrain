/**
 * A read that finds no page answers with the id exactly as the caller typed it, in the message and in the printed fix,
 * so an agent that re-runs the fix sends what it sent.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: `get_page` (and every read `withNormalizedSlugParams` wraps) by a missing mixed-case slug throws
 *     `page_not_found` whose message, `fix.argv` and `fix.mcp.arguments.slug` carry the caller's bytes, not the
 *     normal form the wrapper tried first.
 *  2. Regression: full CI on #9944 (serial-tests 4, test/agent-injection-http-view.serial.test.ts): the fix argv came
 *     back lowercased (`.../PWNED` -> `.../pwned`).
 *  3. Existing coverage: that serial test, through the CLI; this one is the cheap operation-level pin.
 *  4. Seam: none. A real PGLite engine and the registry operation.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('get_page by a missing mixed-case slug names that slug as typed, in the message and the fix', async () => {
  const typed = 'a;Touch $(X)/PWNED';
  const ctx = { engine, config: { engine: 'pglite' } as never, remote: false, sourceId: 'default', dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  let caught: { code?: string; message?: string; fix?: { argv?: string[]; mcp?: { arguments?: { slug?: string } } } } = {};
  try { await operationsByName.get_page!.handler(ctx, { slug: typed }); } catch (err) { caught = err as typeof caught; }
  expect({ code: caught.code, message: caught.message, argv: caught.fix?.argv?.at(-1), mcp: caught.fix?.mcp?.arguments?.slug })
    .toEqual({ code: 'page_not_found', message: `Page not found: ${typed}`, argv: typed, mcp: typed });
});
