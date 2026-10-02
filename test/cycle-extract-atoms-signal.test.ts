/**
 * #5833 adjacent: the routine cycle's extract_atoms phase honors the cycle
 * signal.
 *
 * Protects: an autopilot-cycle timeout (external signal) or a duck-typed stub
 * signal flipped mid-phase stops extract_atoms before its next page, with no
 * failure strike on the interrupted page. Regression caught: the phase got no
 * signal at all, so after a timeout it kept extracting (and refreshing the
 * cycle lock) through the rest of its work list. Existing cycle abort tests
 * only check phase boundaries, never the inside of a running phase.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-xa-signal-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const atomsAnswer = (): ChatResult => {
  const text = JSON.stringify([{ title: 'A durable decision', atom_type: 'insight', body: 'The decision body prose.' }]);
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  } as ChatResult;
};

async function cycleWithSignal(signal: AbortSignal, onFirstCall: () => void): Promise<{ calls: number; failCounts: number[] }> {
  for (const slug of ['notes/xa-one', 'notes/xa-two', 'notes/xa-three']) {
    await engine.putPage(slug, {
      type: 'note', title: slug, compiled_truth: 'A durable decision recorded in prose. '.repeat(20),
    } as never, { sourceId: 'default' });
  }
  let calls = 0;
  __setChatTransportForTests(async () => {
    calls++;
    if (calls === 1) onFirstCall();
    await new Promise((r) => setTimeout(r, 150));
    return atomsAnswer();
  });
  try {
    await withEnv({ GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: 'gbrain-creator' }, () =>
      runCycle(engine, { brainDir, phases: ['extract_atoms'], signal }).catch(() => undefined));
    // An unsignalled phase keeps running after the cycle returns; give it room.
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    __setChatTransportForTests(null);
  }
  const rows = await engine.executeRaw<{ fail_count: number }>('SELECT fail_count FROM extract_atoms_page_state');
  return { calls, failCounts: rows.map((r) => Number(r.fail_count)) };
}

describe('routine cycle extract_atoms honors the cycle signal', () => {
  test('an aborted cycle signal stops the phase before the next page, with no failure strike', async () => {
    const controller = new AbortController();
    const { calls, failCounts } = await cycleWithSignal(controller.signal, () => controller.abort(new Error('timeout')));
    expect(calls).toBe(1);
    expect(failCounts.filter((n) => n > 0)).toEqual([]);
  }, 60_000);

  test('a duck-typed { aborted } stub flipped mid-phase also stops it', async () => {
    const stub = { aborted: false, reason: undefined as unknown } as unknown as AbortSignal;
    const { calls } = await cycleWithSignal(stub, () => {
      (stub as unknown as { aborted: boolean; reason: unknown }).aborted = true;
      (stub as unknown as { aborted: boolean; reason: unknown }).reason = new Error('timeout');
    });
    expect(calls).toBe(1);
  }, 60_000);
});
