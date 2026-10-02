/**
 * `gbrain eval retrieval-quality --decide ...` on a connected brain with a
 * fixture decide transport (no provider is called).
 *
 * Protects: the command never writes decide config to the operator's brain;
 * a missing provider or consent refuses with the catalogued line (exit 1);
 * write-only flags (--decide-force-on) are refused (exit 2); with the brain's
 * own provider + consent, an S3 arm adds a `decide` block (flags, per-query
 * receipts, roll-up) to the JSON while the all-off JSON has none. The embed
 * transport throws, so this also pins S3 on the vector-failure keyword
 * fallback (searchVectorFallback).
 * Serial: mutates the process-global gateway, transports, process.exit and GBRAIN_DECIDE_SLOTS.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { enableDecideEvalOverride } from '../src/core/ai/decide/config.ts';
import { resetDecideSearchCache } from '../src/core/search/decide-stage.ts';
import { runEvalRetrievalQuality } from '../src/commands/eval-retrieval-quality.ts';
import { NAMEDTHING_FIXTURE_PATH, seedNamedThingCorpus } from './fixtures/retrieval-quality/namedthing/corpus.ts';

let engine: PGLiteEngine;
const prevEnv = process.env.GBRAIN_DECIDE_SLOTS;

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const exit = process.exit, log = console.log, error = console.error;
  let out = '', err = '';
  console.log = (...a: unknown[]) => { out += a.join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.join(' ') + '\n'; };
  process.exit = ((code?: number) => { throw Object.assign(new Error('exit'), { code: code ?? 0 }); }) as typeof process.exit;
  try {
    await runEvalRetrievalQuality(engine, [NAMEDTHING_FIXTURE_PATH, '--json', ...args]);
    return { code: 0, out, err };
  } catch (e) {
    if ((e as { code?: number }).code === undefined) throw e;
    return { code: (e as { code: number }).code, out, err };
  } finally {
    process.exit = exit; console.log = log; console.error = error;
    enableDecideEvalOverride(false);
    if (prevEnv === undefined) delete process.env.GBRAIN_DECIDE_SLOTS;
    else process.env.GBRAIN_DECIDE_SLOTS = prevEnv;
  }
}

beforeAll(async () => {
  __setEmbedTransportForTests(() => { throw new Error('stub: no embed'); });
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 60, output_tokens: 0 } }));
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedNamedThingCorpus(engine);
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('eval retrieval-quality --decide', () => {
  test('refusals: no provider, no consent (exit 1); write-only flags (exit 2); nothing is written', async () => {
    const noProvider = await run(['--decide', 'evidence=on']);
    expect(noProvider.code).toBe(1);
    expect(noProvider.err).toContain('no_provider');
    await engine.setConfig('decide.provider', 'typesafe:jev-1.13.0');
    const noConsent = await run(['--decide', 'evidence=on']);
    expect(noConsent.code).toBe(1);
    expect(noConsent.err).toContain('egress_class_denied');
    const write = await run(['--decide', 'evidence=on', '--decide-force-on', 'evidence']);
    expect(write.code).toBe(2);
    expect(write.err).toContain('never writes its config');
    const keys = await engine.executeRaw<{ key: string }>(`SELECT key FROM config WHERE key LIKE 'decide.%' ORDER BY key`);
    expect(keys.map((k) => k.key)).toEqual(['decide.provider']);
  }, 120_000);

  test('an S3 arm on a consented brain adds the decide block; all-off JSON has none', async () => {
    for (const [k, v] of Object.entries({
      'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow',
      'decide.slots.evidence.threshold': '0.5', 'decide.slots.evidence.force_on': 'true',
    })) await engine.setConfig(k, v);
    resetDecideSearchCache();
    const off = await run([]);
    expect(JSON.parse(off.out).decide).toBeUndefined();
    const arm = await run(['--decide', 'evidence=on']);
    const payload = JSON.parse(arm.out);
    expect(payload.decide).toMatchObject({ slots: { evidence: 'on' }, gbrain_decide_slots: 'evidence=on' });
    expect(payload.decide.queries.length).toBe(payload.report.total);
    expect(payload.decide.queries[0].decide.evidence).toMatchObject({ mode: 'on', effective: 'on' });
    expect(payload.decide.summary.evidence.rows).toBe(payload.report.total);
  }, 180_000);
});
