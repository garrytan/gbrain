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

async function cycleAbortedOnSecondCall(transport: (opts: ChatOpts, job: AbortController) => Promise<ChatResult>) {
  const job = new AbortController();
  let calls = 0;
  __setChatTransportForTests(async (opts) => {
    calls++;
    if (calls === 1) return answer('A narrative about the first concept.');
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
});
