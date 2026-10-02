/**
 * S7/S8 operator surfaces in process through `runDecideCommand` (so the lane
 * registrations load exactly as the CLI loads them): the cat35 and
 * grounding-labels dataset builders, calibrate/qualify through the unpacked
 * production-shaped adapters (one request per window or unit, transcript
 * value = max window), and receipts --what-if-threshold replay for triage and
 * grounding. Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { __resetDecideStoreForTests, listCalibrations } from '../../src/core/ai/decide/store.ts';
import { parseDatasetJsonl } from '../../src/core/ai/decide/dataset.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';

let engine: PGLiteEngine;
let dir: string;
const SIGNAL = 'I decided to hire Alice Example as CTO and move the launch to March.';

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out.push(String(chunk)); return true; }) as never);
  try {
    return { code: await runDecideCommand(engine, args), out: out.join('\n'), err: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
}

function turns(n: number, text: string): string {
  return Array.from({ length: n }, (_, i) => `[${i % 2 ? 'assistant' : 'user'}]\n${text} (${i})\n`).join('\n');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-decide-datasets-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as never);
  // A Cat 35-shaped corpus: 40 transcripts, half with a buried decision.
  mkdirSync(join(dir, 'cat35', 'gold'), { recursive: true });
  mkdirSync(join(dir, 'cat35', 'transcripts-txt'), { recursive: true });
  for (let i = 0; i < 40; i++) {
    const id = `scenario-${String(i).padStart(2, '0')}`;
    const high = i % 2 === 0;
    const body = high ? `${turns(20, 'Check the build status and the grocery list please.')}\n[user]\n${SIGNAL}\n` : turns(12, 'Check the build status and the grocery list please.');
    writeFileSync(join(dir, 'cat35', 'gold', `${id}.json`), JSON.stringify({ transcript_id: id, expected_triage: high ? 'high' : 'low', scenario: 'mixed' }));
    writeFileSync(join(dir, 'cat35', 'transcripts-txt', `2026-08-01-${id}.txt`), body);
  }
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
});

describe('dataset builders', () => {
  test('cat35: one item per transcript, label from expected_triage, window-count slices, frozen split', async () => {
    const out = join(dir, 'triage.jsonl');
    const r = await run(['dataset', '--slot', 'triage', '--from', 'cat35', join(dir, 'cat35'), '--out', out]);
    expect(r.code).toBe(0);
    const items = parseDatasetJsonl(readFileSync(out, 'utf8'));
    expect(items).toHaveLength(40);
    expect(items.filter((i) => i.label === true)).toHaveLength(20);
    expect(new Set(items.map((i) => i.slice))).toEqual(new Set(['windows:1-4']));
    expect(items.some((i) => i.split === 'calibrate') && items.some((i) => i.split === 'eval')).toBe(true);
    expect(items[0]!.inputs.transcript).toContain('[user]');
  });

  test('grounding-labels: production window selection stored, weak coverage protected', async () => {
    const transcript = 'User: we charge for durability because reliable memories should survive every tool.\nAssistant: Understood.';
    const path = join(dir, 'labels.jsonl');
    writeFileSync(path, [
      { id: 'u1', page: 'p1', claim: 'Reliable memories should survive every tool change.', transcript, label: 'supported' },
      { id: 'u2', page: 'p1', claim: 'Quarterly offsites happen in coastal towns with volleyball.', transcript, label: false },
    ].map((x) => JSON.stringify(x)).join('\n'));
    const out = join(dir, 'grounding.jsonl');
    expect((await run(['dataset', '--slot', 'grounding', '--from', 'grounding-labels', path, '--out', out])).code).toBe(0);
    const items = parseDatasetJsonl(readFileSync(out, 'utf8'));
    expect(items.map((i) => i.label)).toEqual([true, false]);
    expect(items[0]!.inputs.sources).toContain('reliable memories should survive every tool');
    expect(items[0]!.protected).toBeUndefined();
    expect(items[1]!.protected).toBe(true);
    expect(items[1]!.slice).toBe('weak');
  });
});

describe('calibrate and qualify through the unpacked adapters', () => {
  test('S7: one request per window, transcript value = max window, calibration and qualification stored', async () => {
    const dataset = join(dir, 'triage-cal.jsonl');
    await run(['dataset', '--slot', 'triage', '--from', 'cat35', join(dir, 'cat35'), '--out', dataset]);
    await engine.setConfig('decide.provider', 'typesafe:jev-1.13.0');
    await engine.setConfig('decide.calibrate.retest_n', '2');
    let requests = 0;
    let maxQuestions = 0;
    __setDecideTransportForTests(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      requests++;
      maxQuestions = Math.max(maxQuestions, Object.keys(body.questions).length);
      const answers = Object.fromEntries(Object.entries<any>(body.questions).map(([id, q]) => [id, { type: 'noul', noul: String(q.instructions.window).includes('decided to hire') ? 0.9 : 0.1 }]));
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 1 } }));
    });
    const cal = await run(['calibrate', '--slot', 'triage', '--dataset', dataset, '--json']);
    expect(cal.code).toBe(0);
    expect(maxQuestions).toBe(1);
    expect(requests).toBeGreaterThan(40);
    const row = (await listCalibrations(engine, { slot: 'triage' }))[0]!;
    expect(row.call_site).toBe('dream');
    expect(row.pack_shape).toContain('max=1');
    expect(row.threshold).toBeGreaterThan(0.1);
    expect(row.threshold).toBeLessThanOrEqual(0.9);
    const q = await run(['qualify', '--slot', 'triage', '--dataset', dataset, '--json']);
    const parsed = JSON.parse(q.out);
    expect(parsed.calibration).toBe(`local:${row.id}`);
    expect(parsed.actions).toBeGreaterThan(0);
    expect(['qualified', 'insufficient_n']).toContain(parsed.status);
  }, 60_000);
});

describe('receipts --what-if-threshold', () => {
  test('triage replays the transcript maximum; grounding replays weak coverage as insufficient_context', async () => {
    const seed = async (slot: string, decision: string, value: number, outcome: string, prot = false) => engine.executeRaw(
      `INSERT INTO decision_receipts (decision_id, slot, mode, provider, outcome, call_site, lane, answer_value, protected)
       VALUES ($1, $2, 'on', 'typesafe:jev-1.13.0', $3, 'dream', 'background', $4, $5)`, [decision, slot, outcome, value, prot]);
    await seed('triage', 't1', 0.1, 'pass'); await seed('triage', 't1', 0.7, 'pass');
    await seed('triage', 't2', 0.2, 'reject'); await seed('triage', 't2', 0.1, 'reject');
    const t = JSON.parse((await run(['receipts', '--slot', 'triage', '--what-if-threshold', '0.8', '--json'])).out);
    expect(t.what_if).toEqual({ pass: 0, reject: 4, margin_hold: 0 });
    await seed('grounding', 'g1', 0.1, 'quarantine'); await seed('grounding', 'g1', 0.1, 'insufficient_context', true); await seed('grounding', 'g1', 0.9, 'pass');
    const g = JSON.parse((await run(['receipts', '--slot', 'grounding', '--what-if-threshold', '0.95', '--json'])).out);
    expect(g.what_if).toEqual({ pass: 0, quarantine: 1, insufficient_context: 1, margin_hold: 1 });
  });
});
