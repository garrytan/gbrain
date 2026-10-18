/**
 * #6569: `decide qualify --items-out <path>` writes the item ids behind the
 * harmful actions qualify already judged (0600, a header, no input text),
 * without another provider call and without changing the default output.
 * Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { stableSplit } from '../../src/core/ai/decide/dataset.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';

let engine: PGLiteEngine;
let dir: string;
let dataset: string;
let wrong: string[] = [];
let calls = 0;
const FAMILIES = 24;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); }), spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); })];
  try { return { code: await runDecideCommand(engine, args), stdout: out.join('\n'), stderr: err.join('\n') }; } finally { for (const s of spies) s.mockRestore(); }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-decide-items-out-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as never);
  const lines: string[] = [];
  for (let f = 0; f < FAMILIES; f++) {
    for (let c = 0; c < 4; c++) {
      lines.push(JSON.stringify({
        id: `q${f}:${c}`, family: `q${f}`, slot: 'evidence', split: stableSplit(`q${f}`), state: { query: `question ${f}` },
        inputs: { candidate: c === 0 ? `the answer to question ${f}.` : `unrelated chatter ${c} for ${f}.` }, label: c === 0, rank: c,
      }));
    }
  }
  dataset = join(dir, 'evidence.jsonl');
  writeFileSync(dataset, lines.join('\n') + '\n');
  wrong = Array.from({ length: FAMILIES }, (_, f) => `q${f}`).filter((fam) => stableSplit(fam) === 'eval').slice(0, 2);
  __setDecideTransportForTests(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body as string);
    const answers = Object.fromEntries(Object.entries<any>(body.questions).map(([id, q]) => {
      const text = JSON.stringify(q);
      const fam = /for (\d+)\.|question (\d+)\./.exec(text);
      const family = `q${fam?.[1] ?? fam?.[2]}`;
      const isAnswer = text.includes('the answer to');
      const flipped = wrong.includes(family);
      const p = isAnswer ? (flipped ? 0.1 : 0.9) : (flipped && text.includes('chatter 1 ') ? 0.9 : 0.1);
      return [id, { type: 'noul', noul: p }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 1 } }));
  });
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
  await engine.setConfig('decide.slots.evidence.min_keep', '1');
  expect((await run(['calibrate', '--slot', 'evidence', '--dataset', dataset, '--json'])).code).toBe(0);
});

describe('decide qualify --items-out (#6569)', () => {
  test('lists the wrong harmful actions by item id, 0600, no input text, same calls and same stdout', async () => {
    expect(wrong).toHaveLength(2);
    calls = 0;
    const plain = await run(['qualify', '--slot', 'evidence', '--dataset', dataset, '--json']);
    const plainCalls = calls;
    calls = 0;
    const path = join(dir, 'items.json');
    const withItems = await run(['qualify', '--slot', 'evidence', '--dataset', dataset, '--json', '--items-out', path]);
    expect(calls).toBe(plainCalls);
    expect(withItems.code).toBe(plain.code);
    expect(withItems.stdout).toBe(plain.stdout);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('the answer to');
    expect(raw).not.toContain('chatter');
    const file = JSON.parse(raw) as { header: Record<string, unknown>; items: Array<{ id: string; correct: boolean; family: string; split: string; value: number | null }> };
    expect(file.header).toMatchObject({ slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0' });
    expect(String(file.header.calibration)).toMatch(/^local:\d+$/);
    expect(file.items.filter((i) => !i.correct).map((i) => i.id).sort()).toEqual(wrong.map((f) => `${f}:0`).sort());
    expect(file.items.every((i) => i.split === 'eval' && typeof i.value === 'number')).toBe(true);
  }, 60_000);

  test('an unwritable --items-out path refuses before any provider call', async () => {
    calls = 0;
    const r = await run(['qualify', '--slot', 'evidence', '--dataset', dataset, '--items-out', join(dir, 'missing-dir', 'items.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--items-out');
    expect(calls).toBe(0);
    expect(existsSync(join(dir, 'missing-dir'))).toBe(false);
  }, 60_000);
});
