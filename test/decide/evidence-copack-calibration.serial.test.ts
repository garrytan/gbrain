/**
 * S3 calibration records the pack shape it actually sent: with S5 on, the
 * calibrate/qualify requests carry the co-packed injection questions (the
 * production S3 request shape) and the row's pack_shape says
 * evidence+injection; with S5 off, evidence questions only. Serial: mutates
 * the process-global gateway and decide transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { __resetDecideStoreForTests, listCalibrations } from '../../src/core/ai/decide/store.ts';
import { stableSplit } from '../../src/core/ai/decide/dataset.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';

let engine: PGLiteEngine;
let dir: string;
let dataset: string;

async function run(args: string[]): Promise<number> {
  const quiet = [spyOn(console, 'log').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {})];
  try { return await runDecideCommand(engine, args); } finally { for (const s of quiet) s.mockRestore(); }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-decide-copack-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as never);
  const lines: string[] = [];
  for (let f = 0; f < 12; f++) {
    const family = `q${f}`;
    for (let c = 0; c < 4; c++) {
      lines.push(JSON.stringify({
        id: `${family}:${c}`, family, slot: 'evidence', split: stableSplit(family), state: { query: `question ${f}` },
        inputs: { candidate: c === 0 ? `the answer to question ${f}` : `unrelated chatter ${c}` }, label: c === 0, rank: c,
      }));
    }
  }
  dataset = join(dir, 'evidence.jsonl');
  writeFileSync(dataset, lines.join('\n') + '\n');
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%'`);
  for (const t of ['decision_receipts', 'decide_spend', 'decide_calibrations']) await engine.executeRaw(`DELETE FROM ${t}`);
  __resetDecideStoreForTests();
  await engine.setConfig('decide.provider', 'typesafe:jev-1.13.0');
  await engine.setConfig('decide.calibrate.retest_n', '2');
});

function recordingTransport(ids: string[][]): void {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const qs = Object.keys(body.questions);
    ids.push(qs);
    const answers = Object.fromEntries(Object.entries<any>(body.questions).map(([id, q]) => [id, { type: 'noul', noul: JSON.stringify(q).includes('the answer to') ? 0.9 : 0.1 }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 1 } }));
  });
}

describe('S3 calibration pack shape follows S5 co-packing', () => {
  test('S5 off: evidence questions only, pack_shape slots=evidence', async () => {
    const sent: string[][] = [];
    recordingTransport(sent);
    expect(await run(['calibrate', '--slot', 'evidence', '--dataset', dataset, '--json'])).toBe(0);
    expect(sent.flat().some((id) => id.startsWith('injection:'))).toBe(false);
    const row = (await listCalibrations(engine, { slot: 'evidence' }))[0]!;
    expect(row.pack_shape).toMatch(/slots=evidence$/);
  }, 60_000);

  test('S5 on: every request co-packs injection questions, pack_shape slots=evidence+injection', async () => {
    await engine.setConfig('decide.slots.injection.mode', 'on');
    const sent: string[][] = [];
    recordingTransport(sent);
    expect(await run(['calibrate', '--slot', 'evidence', '--dataset', dataset, '--json'])).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
    for (const qs of sent) {
      expect(qs.filter((id) => id.startsWith('injection:')).length).toBe(qs.filter((id) => id.startsWith('evidence:')).length);
    }
    const row = (await listCalibrations(engine, { slot: 'evidence' }))[0]!;
    expect(row.pack_shape).toMatch(/slots=evidence\+injection$/);
    expect(row.threshold).toBeGreaterThan(0.1);
  }, 60_000);
});
