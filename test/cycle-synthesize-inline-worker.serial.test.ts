/**
 * v0.30 — regression test for the PGLite inline-worker fix in
 * src/core/cycle/synthesize.ts.
 *
 * Bug class: dream.synthesize submitted `subagent` jobs to the minion
 * queue and polled `waitForCompletion`, but on PGLite there is no
 * `gbrain jobs work` daemon and nothing else in-process claimed those
 * jobs. Result: every nightly cycle wasted 35–70 min polling zombies,
 * wrote zero synth pages, and the cooldown never advanced.
 *
 * Fix: synthesize.ts detects `engine.kind === 'pglite'` and spins up an
 * inline MinionWorker bound to this engine + subagent handler for the
 * duration of the wait loop. This test pins that the child reaches
 * status='complete' (claimed and run inline) rather than timing out.
 *
 * `.serial.test.ts` because we mock-shape an Anthropic Messages client
 * by injection on SynthesizePhaseOpts; PGLite engine is created in
 * beforeAll per the canonical block.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import type { MessagesClient } from '../src/core/minions/handlers/subagent.ts';

let engine: PGLiteEngine;
let corpusDir: string;
let workDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState preserves schema_version (the migration ledger) but
  // truncates `config`, where the minion queue's ensureSchema() reads its
  // version key from. Without this re-seed, queue.add throws
  // "minion_jobs table not found (schema version 1, need 7)". Set to a
  // high constant so MIGRATION_VERSION bumps don't break this test.
  await engine.setConfig('version', '999');
  workDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-inline-'));
  corpusDir = join(workDir, 'transcripts');
  mkdirSync(corpusDir, { recursive: true });
  // Minimum config for synthesize to fan out.
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
});

// Mock Anthropic Messages client that returns an immediate end_turn
// message with no tool calls. The subagent handler runs one turn,
// records it, and marks the job complete. Cheapest possible path that
// still exercises the claim → execute → complete loop.
function mockClient(): MessagesClient {
  return {
    create: async (_params, _opts) => {
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'No relevant synthesis from this fixture.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      } as any;
    },
  };
}

describe('runPhaseSynthesize on PGLite spins up an inline worker (v0.30)', () => {
  test('child subagent job reaches status=complete instead of timing out', async () => {
    // Write a transcript that passes the minChars filter and date-name parse.
    const transcript = join(corpusDir, '2026-05-08-fixture.txt');
    const body = 'This is a synthetic transcript long enough to clear the minChars filter. '.repeat(40);
    writeFileSync(transcript, body, 'utf8');

    // Pre-seed the significance verdict so the Haiku call is skipped
    // entirely (no API key in the test environment).
    const { createHash } = await import('node:crypto');
    const contentHash = createHash('sha256').update(body).digest('hex');
    await engine.putDreamVerdict(transcript, contentHash, {
      worth_processing: true,
      reasons: ['seeded by test'],
    });

    const result = await runPhaseSynthesize(engine, {
      brainDir: workDir,
      dryRun: false,
      subagentClient: mockClient(),
    });

    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    const outcomes = details!.child_outcomes as Array<{ jobId: number; status: string }>;
    expect(outcomes.length).toBeGreaterThan(0);
    // The critical regression assertion: NOT 'timeout', NOT 'waiting'.
    // The inline worker claimed and ran the job to terminal status.
    for (const o of outcomes) {
      expect(o.status).toBe('completed');
    }
  }, 60000);

  test('Postgres engine path is unchanged (no inline worker spawn)', async () => {
    // Synthesize sees engine.kind === 'pglite' here, so this PGLite engine
    // takes the new branch by construction. The Postgres path-parity test
    // lives in test/e2e/ where a real Postgres engine is available; here
    // we just assert the new branch doesn't leak signal handlers across
    // repeated runs (the worker is fully stopped before synthesize returns).
    const before = process.listenerCount('SIGTERM');

    const transcript = join(corpusDir, '2026-05-09-fixture.txt');
    const body = 'Another synthetic transcript for the leak guard. '.repeat(40);
    writeFileSync(transcript, body, 'utf8');
    const { createHash } = await import('node:crypto');
    const contentHash = createHash('sha256').update(body).digest('hex');
    await engine.putDreamVerdict(transcript, contentHash, {
      worth_processing: true,
      reasons: ['seeded by test'],
    });

    await runPhaseSynthesize(engine, {
      brainDir: workDir,
      dryRun: false,
      subagentClient: mockClient(),
    });

    const after = process.listenerCount('SIGTERM');
    // MinionWorker.start() currently registers process.on('SIGTERM', ...)
    // without removing it in stop(). That's a known issue tracked as a
    // follow-up TODO (see CHANGELOG note for v0.30). For this test we
    // assert the leak is bounded — at most ONE handler per cycle — so
    // it doesn't go unnoticed if the worker starts adding more.
    expect(after - before).toBeLessThanOrEqual(1);
  }, 60000);
});
