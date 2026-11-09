/**
 * #7986: synthesize_concepts had no bound but a whole-run LLM error. With a slow model the phase kept calling
 * the model and publishing concept pages after its job timed out: the cycle's abort signal never reached it.
 * The phase now takes the cycle's signal, hands it to the model call and checks it before each concept's
 * spend and publication, so an abort stops it before the next page.
 *
 * runCycle on PGLite under the gbrain-creator pack (which declares the phase), with a stubbed chat transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runCycle } from '../../src/core/cycle.ts';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { emptyHome, withEnv } from '../helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-7986-'));
}, 60_000);
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); rmSync(brainDir, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  for (const c of ['alpha', 'beta', 'gamma']) {
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`atoms/${c}-${i}`, { title: `${c} atom ${i}`, type: 'atom', compiled_truth: `A synthetic insight ${i} about ${c}.`,
        frontmatter: { concepts: [`concepts/${c}`] } });
    }
  }
});

const answer = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' });

async function conceptPages(): Promise<string[]> {
  return (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE 'concepts/%' AND deleted_at IS NULL ORDER BY slug")).map(r => r.slug);
}

async function cycleAbortedOnSecondCall(transport: (opts: ChatOpts, job: AbortController) => Promise<ChatResult>,
  first: ChatResult = answer('A narrative about the first concept.'), job = new AbortController()) {
  let calls = 0;
  __setChatTransportForTests(async (opts) => {
    calls++;
    if (calls === 1) return first;
    return transport(opts, job);
  });
  try {
    const outcome = await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: 'gbrain-creator', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
      () => runCycle(engine, { brainDir, phases: ['synthesize_concepts'], signal: job.signal })).then(report => ({ report }), error => ({ error }));
    await Bun.sleep(300);
    return { outcome, calls, pages: await conceptPages() };
  } finally {
    __setChatTransportForTests(null);
  }
}

describe('#7986 synthesize_concepts stops on the cycle abort signal', () => {
  test('a job that times out during a slow model call publishes no later concept page and calls the model no more', async () => {
    const run = await cycleAbortedOnSecondCall(async (_opts, job) => {
      job.abort(new Error('job timed out'));
      await Bun.sleep(50);
      return answer('A narrative the slow model finished after the job timed out.');
    });
    expect(run.pages).toEqual(['concepts/alpha']);
    expect(run.outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(run.calls).toBe(2);
  }, 60_000);

  test('the model call gets the signal, and an aborted call is not published as a template fallback', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const run = await cycleAbortedOnSecondCall(async (opts, job) => {
      seen.push(opts.abortSignal);
      job.abort(new Error('job timed out'));
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    });
    expect(run.pages).toEqual(['concepts/alpha']);
    expect(run.outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(seen[0]?.aborted).toBe(true);
    expect(run.calls).toBe(2);
  }, 60_000);

  test('a job aborted while the first concept is being prepared for publication publishes nothing', async () => {
    const job = new AbortController();
    const getPage = PGLiteEngine.prototype.getPage;
    // A this-preserving wrapper: a transaction's engine inherits it and must still read on its own connection.
    engine.getPage = async function (this: PGLiteEngine, slug: string, opts?: Parameters<typeof getPage>[1]) {
      if (slug.startsWith('concepts/')) job.abort(new Error('job timed out'));
      return getPage.call(this, slug, opts);
    } as typeof engine.getPage;
    try {
      const run = await cycleAbortedOnSecondCall(async () => answer('never reached'), undefined, job);
      expect(run.pages).toEqual([]);
      expect(run.outcome).toMatchObject({ error: { name: 'AbortError' } });
      expect(run.calls).toBe(1);
    } finally {
      delete (engine as { getPage?: unknown }).getPage;
    }
  }, 60_000);

  test('an aborted run still records the spend and the failed attempts of the calls it finished', async () => {
    const clipped = { ...answer('A clipped narr'), stopReason: 'length' as const };
    const run = await cycleAbortedOnSecondCall(async (_opts, job) => {
      job.abort(new Error('job timed out'));
      return answer('A narrative the slow model finished after the job timed out.');
    }, clipped);
    expect(run.outcome).toMatchObject({ error: { name: 'AbortError' } });
    const [rollup] = await engine.executeRaw<{ cost_usd: number; round_completed_count: number }>(
      "SELECT cost_usd::float8 AS cost_usd, round_completed_count FROM extract_rollup_7d WHERE kind = 'concepts' AND source_id = 'default'");
    expect(rollup?.cost_usd).toBeGreaterThan(0);
    expect(rollup?.round_completed_count).toBe(0);
    expect(await engine.getConfig('dream.concepts.failed_attempts')).toContain('concepts/alpha');
  }, 60_000);
});
