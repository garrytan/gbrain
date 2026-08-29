/**
 * #4525 — remote put_page must SAY that auto-link reconciliation was skipped.
 *
 * The security posture (auto_link/auto_timeline run for trusted local writers
 * only) is by design; the failure was silence: the tool description never
 * mentioned it, and the bare {skipped: 'remote'} response left MCP agents
 * believing their body wikilinks had been reconciled into the graph.
 *
 * Pins: (1) the op description names the remote skip; (2) the skipped
 * response carries an actionable hint; (3) local writes are unchanged (no
 * skip marker).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 120000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
}, 120000);

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

const CONTENT = '---\ntitle: Hint Test\n---\n\nSee people/alice-example for context.';

describe('put_page remote auto-link disclosure (#4525)', () => {
  test('tool description names the remote auto-link skip', () => {
    expect(putPage.description).toMatch(/[Rr]emote .*callers/);
    expect(putPage.description).toContain('skipped');
  });

  test('remote write reports skipped: remote WITH an actionable hint', async () => {
    const result = (await putPage.handler(
      makeCtx({ remote: true }),
      { slug: 'notes/remote-hint', content: CONTENT },
    )) as { auto_links?: { skipped?: string; hint?: string }; auto_timeline?: { skipped?: string; hint?: string } };
    expect(result.auto_links?.skipped).toBe('remote');
    expect(result.auto_links?.hint).toBeDefined();
    expect(result.auto_links?.hint).toContain('NOT reconciled');
    expect(result.auto_timeline?.skipped).toBe('remote');
    expect(result.auto_timeline?.hint).toBeDefined();
  }, 120000);

  test('local write does not carry the remote skip marker', async () => {
    const result = (await putPage.handler(
      makeCtx({ remote: false }),
      { slug: 'notes/local-no-skip', content: CONTENT },
    )) as { auto_links?: { skipped?: string } };
    expect(result.auto_links?.skipped).not.toBe('remote');
  }, 120000);
});
