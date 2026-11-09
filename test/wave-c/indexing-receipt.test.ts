/**
 * Wave C 1H-a (spec §3.1 step 8, T-E2/T-DX2): a strict git-first write whose door commit landed answers with an
 * `indexing` receipt: non-terminal, the index object kept, CLI exit 10, and a poll delay that never ages into an
 * operator inspection (the write is committed in Git and waits only for its index step).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportFailure } from '../../src/cli/commands/append.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { writeHealth } from '../../src/core/persistence/health.ts';
import { admittedPendingReceipt, isTerminalWriteState } from '../../src/core/persistence/types.ts';
import { PENDING_WRITE_EXIT_CODE } from '../../src/core/exit-codes.ts';
import { writeErrorExitCode } from '../../src/core/persistence/write-wait.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

test('indexing is non-terminal and its poll delay never escalates to an owner inspection', () => {
  expect(isTerminalWriteState('indexing')).toBe(false);
  const created = new Date(0);
  for (const age of [0, 31_000, 600_000]) {
    expect(writeHealth({ state: 'indexing', created_at: created }, {}, age)).toEqual({ retry_after_ms: 5000,
      diagnostic: { age_ms: age, assessment: 'pending', reason: 'pending', next_action: 'poll' } });
  }
});

test('the upload client never suggests resending a write whose receipt is indexing', async () => {
  const requestId = '00000000-0000-4000-8000-0000000000aa';
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const stdout = process.stdout.write.bind(process.stdout);
  const exitCode = process.exitCode;
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
  (process.stdout as { write: unknown }).write = () => true;
  try {
    for (const state of ['indexing', 'queued'] as const) {
      const error = new OperationError('write_pending', 'pending', 'poll');
      error.writeRequest = { request_id: requestId, state, retry_after_ms: 5000 };
      await reportFailure(error, 'append', true, requestId);
    }
  } finally {
    (process.stderr as { write: unknown }).write = write;
    (process.stdout as { write: unknown }).write = stdout;
    process.exitCode = exitCode;
  }
  const text = lines.join('');
  expect(text).toContain(`The append is committed in Git and is being indexed; do not resend it. Poll gbrain write-request -- ${requestId}.`);
  expect(text.match(/Retry the same append/g)?.length).toBe(1);
});

for (const backend of testBackends()) describe(`[${backend}] the indexing receipt`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a 2 MiB strict put answers write_pending with an indexing receipt carrying the index object; the CLI exits 10', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/receipt', pageBody(2 * MiB, 'MARKERRECEIPT'), 'put');
    expect(row.state).toBe('indexing');
    const receipt = admittedPendingReceipt((row.error as { toJSON(): unknown }).toJSON());
    expect(receipt).toMatchObject({ state: 'indexing', retry_after_ms: 5000,
      outcome: { index: { state: 'pending', commit: row.outcome?.persistence.git_commit } } });
    expect(writeErrorExitCode(row.error, false)).toBe(PENDING_WRITE_EXIT_CODE);
    expect(PENDING_WRITE_EXIT_CODE).toBe(10);
  }, { databaseUrl, setup }), 180_000);
});
