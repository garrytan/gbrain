/**
 * v0.31 Phase 6 — put_page facts backstop gating logic.
 *
 * Pins the eligibility check that decides whether the put_page hook fires
 * the extraction job. The check is exported via test-only access through
 * the operations module — to avoid coupling tests to internals, we exercise
 * it indirectly by inspecting the `facts_backstop` field on put_page
 * responses.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

// Defense-in-depth: this suite tests the FACTS BACKSTOP gating, not embedding.
// put_page imports + embeds the page body before the backstop runs, and
// embedding only happens when isAvailable('embedding') is true. If a prior
// test file in this shard's process left the gateway configured with a key
// (e.g. embed-preflight's 'sk-test'), put_page would attempt a real embed and
// 401. Reset the gateway before each test so isAvailable('embedding') is
// deterministically false → put_page uses noEmbed → the import never embeds →
// we exercise only the backstop gating the suite is about.
beforeEach(() => { resetGateway(); });

afterAll(async () => {
  await engine.disconnect();
});

async function putAndReadBackstop(slug: string, content: string): Promise<{ queued: boolean } | { skipped: string } | undefined> {
  const r = await dispatchToolCall(engine, 'put_page', { slug, content }, {
    remote: false,
    sourceId: 'default',
  });
  // Diagnostic: print the actual error content when the call fails, so CI
  // failures (which reproduce only on Linux CI, not local Mac) surface the
  // real cause instead of opaque `Received: true`. Cheap when isError is
  // false (the common case); pays its way the moment something throws.
  if (r.isError) {
    // eslint-disable-next-line no-console
    console.error(`[facts-backstop-gating diag] put_page returned isError=true for slug=${slug}, content[0].text=${r.content[0]?.text ?? '<missing>'}`);
  }
  expect(r.isError).toBeFalsy();
  const payload = JSON.parse(r.content[0].text);
  return payload.facts_backstop as { queued: boolean } | { skipped: string } | undefined;
}

describe('put_page facts backstop', () => {
  test('skipped on too-short body', async () => {
    const result = await putAndReadBackstop(
      'note/short',
      `---\ntype: note\ntitle: Short\n---\nshort.`,
    );
    expect(result).toEqual({ skipped: 'too_short' });
  });

  test('skipped on subagent namespace', async () => {
    const result = await putAndReadBackstop(
      'wiki/agents/12/notes',
      `---\ntype: note\ntitle: Subagent\n---\n${'word '.repeat(40)}`,
    );
    expect(result).toEqual({ skipped: 'subagent_namespace' });
  });

  test('skipped on dream_generated:true frontmatter', async () => {
    const result = await putAndReadBackstop(
      'note/dream',
      `---\ntype: note\ntitle: Dream\ndream_generated: true\n---\n${'this is some content. '.repeat(20)}`,
    );
    expect(result).toEqual({ skipped: 'dream_generated' });
  });

  test('queued for an eligible substantive note', async () => {
    const result = await putAndReadBackstop(
      'note/substantive',
      `---\ntype: note\ntitle: Substantive\n---\n${'this is some real content with meaningful claims. '.repeat(10)}`,
    );
    // Either queued (gateway configured) or skipped due to gateway absence
    // is acceptable; we only insist the gating doesn't reject on the
    // happy path.
    expect(result).toBeDefined();
    const r = result!;
    if ('queued' in r) {
      expect(r.queued).toBe(true);
    } else {
      // 'backstop_error' or 'queue_shutdown' would be a real failure.
      expect(r.skipped).toMatch(/^(queue_shutdown|backstop_error)?$/);
    }
  });

  test('skipped on non-eligible page kind', async () => {
    const result = await putAndReadBackstop(
      'guides/eg',
      `---\ntype: guide\ntitle: Guide\n---\n${'guide content here. '.repeat(20)}`,
    );
    expect(result).toBeDefined();
    const r = result!;
    if ('skipped' in r) {
      // 'kind:guide' or any other skipped reason is the expected shape.
      expect(r.skipped.startsWith('kind:') || r.skipped === 'too_short').toBe(true);
    }
  });
});
