/**
 * W3 (GBRA-224): the dream breaker's per-transcript key for content-hashed
 * synthesize keys (#6753/#6924), and `gbrain dream reset-key` accepting every
 * key `--list` prints, `dream:phase:` included (#7505).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { countDeadDreamSubmissions, loadDreamBreaker, recordContainedPaidFailure, dreamSynthFileKey } from '../src/core/cycle/dream-breaker.ts';
import { dreamPaidLoopCheck } from '../src/commands/doctor/checks/dream-breaker.ts';
import { runDreamResetKey } from '../src/commands/dream-reset-key.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seedDead(key: string, queue: string, sourceId = 'default'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, created_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, 'dead', $2::text::jsonb, NULL, now() - interval '1 hour', now() - interval '1 hour')`,
    [queue, JSON.stringify({ source_id: sourceId, __released_idempotency_key: key })]);
}

async function captured(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await run(); } finally { console.log = log; process.stdout.write = write; }
  return lines.join('\n');
}

const synthKey = (identity: string, file: string, hash: string) => `dream:synth-v2:${encodeURIComponent(identity)}:filename:${encodeURIComponent(file)}:${hash}`;

describe('per-transcript synthesize key', () => {
  test('deaths across content keys of one transcript count under its file key; one content key reports only itself', async () => {
    await seedDead(synthKey('default', 'one key.txt', '1111111111111111'), 'q1');
    await seedDead(synthKey('default', 'one key.txt', '1111111111111111'), 'q2');
    expect((await countDeadDreamSubmissions(engine)).map(row => row.base_key)).toEqual([synthKey('default', 'one key.txt', '1111111111111111')]);

    // A managed brain keys by source/incarnation; the per-transcript key uses the source id, so it survives the switch (#6924).
    await seedDead(synthKey('default', 'grows.txt', 'aaaaaaaaaaaaaaaa'), 'q3');
    await seedDead(synthKey('default/1b0e7e7a-0000-4000-8000-000000000000', 'grows.txt', 'bbbbbbbbbbbbbbbb'), 'q4');
    await seedDead(synthKey('default', 'grows.txt', 'cccccccccccccccc'), 'q5');
    const fileKey = dreamSynthFileKey('default', 'grows.txt');
    expect(fileKey).toBe('dream:synth-v2:@file:default:grows.txt');
    const rows = await countDeadDreamSubmissions(engine);
    expect(rows.find(row => row.base_key === fileKey)?.dead_submissions).toBe(3);
    const breaker = (await loadDreamBreaker(engine))!;
    expect(breaker.tripped.get(fileKey)).toBe(3);
    expect([...breaker.tripped.keys()]).toEqual([fileKey]);
    const check = await dreamPaidLoopCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(fileKey);
  });

  test('chunks of one run count once, and other sources keep their own count', async () => {
    await seedDead(`${synthKey('default', 'big.txt', 'aaaaaaaaaaaaaaaa')}:c0of2`, 'q1');
    await seedDead(`${synthKey('default', 'big.txt', 'aaaaaaaaaaaaaaaa')}:c1of2`, 'q1');
    await seedDead(synthKey('default', 'big.txt', 'bbbbbbbbbbbbbbbb'), 'q2');
    await seedDead(synthKey('other', 'big.txt', 'cccccccccccccccc'), 'q3', 'other');
    const rows = await countDeadDreamSubmissions(engine);
    expect(rows.find(row => row.base_key === dreamSynthFileKey('default', 'big.txt'))?.dead_submissions).toBe(2);
    expect(rows.find(row => row.base_key === dreamSynthFileKey('other', 'big.txt'))).toBeUndefined();
  });
});

describe('dream reset-key accepts every key --list prints (#7505)', () => {
  test('round trip: a contained phase key and a per-transcript key reset with the printed command', async () => {
    for (let i = 0; i < 3; i++) await recordContainedPaidFailure(engine, 'synthesize_concepts', 'default');
    for (const [i, hash] of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'].entries()) await seedDead(synthKey('default', 'loop.txt', hash), `q${i}`);
    const listed = JSON.parse(await captured(() => runDreamResetKey(engine, ['--list', '--json']))) as { tripped: Array<{ base_key: string; reset_command: string }> };
    const keys = listed.tripped.map(row => row.base_key).sort();
    expect(keys).toEqual(['dream:phase:synthesize_concepts:default', 'dream:synth-v2:@file:default:loop.txt']);
    for (const row of listed.tripped) {
      const printed = row.reset_command.match(/^gbrain dream reset-key '(.+)'$/)![1]!;
      expect(printed).toBe(row.base_key);
      _resetCliExitVerdictForTests();
      const out = await captured(() => runDreamResetKey(engine, [printed]));
      expect(currentExitCode()).toBe(0);
      expect(out).toContain(`Reset ${row.base_key}`);
    }
    expect(await captured(() => runDreamResetKey(engine, ['--list']))).toContain('No tripped dream keys');
    expect((await dreamPaidLoopCheck(engine)).status).toBe('ok');
  });

  test('an unknown key family is still refused', async () => {
    _resetCliExitVerdictForTests();
    await captured(() => runDreamResetKey(engine, ['dream:other:key']));
    expect(currentExitCode()).not.toBe(0);
    _resetCliExitVerdictForTests();
  });
});
