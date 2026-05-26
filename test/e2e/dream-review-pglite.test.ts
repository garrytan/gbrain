/**
 * E2E dream review — PGLite, deterministic chat, no writes.
 *
 * Review mode is allowed to read config and call a chat model. It must not
 * write pages, completion timestamps, queue jobs, or files under the brain
 * repo. This test uses the real PGLite schema so those boundaries are checked
 * against actual tables instead of a fake engine call log.
 *
 * Run: bun test test/e2e/dream-review-pglite.test.ts
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runDream } from '../../src/commands/dream.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { __testing as synthTesting } from '../../src/core/cycle/synthesize.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  synthTesting.setMinionQueueFactoryForTests(null);
});

describe('E2E dream review — PGLite no-write contract', () => {
  test('CLI review returns proposals without writing pages, config timestamps, queue jobs, or brain files', async () => {
    const rig = await setupRig();
    const inputFile = writeTranscript('Sawyer described a useful review-only memory workflow.\n'.repeat(20));
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode = 0;

    __setChatTransportForTests(async (opts): Promise<ChatResult> => ({
      text: JSON.stringify({
        source_path: inputFile,
        source_date: '2026-05-26',
        proposals: [
          {
            slug: 'wiki/originals/ideas/review-only-memory-workflow',
            title: 'Review Only Memory Workflow',
            page_type: 'original',
            rationale: 'The transcript proposes a safe review lane before durable writes.',
            evidence_quotes: ['useful review-only memory workflow'],
            runtime_truth_warnings: [],
            draft_markdown: '# Review Only Memory Workflow\n\nProposed, not written.',
          },
        ],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const logSpy = spyOn(console, 'log').mockImplementation((msg: unknown) => {
      stdout.push(String(msg));
    });
    const errSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
      stderr.push(String(msg));
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new Error('EXIT');
    });

    try {
      const pagesBefore = await countRows(rig.engine, 'pages');
      const jobsBefore = await countRows(rig.engine, 'minion_jobs');
      const filesBefore = listFiles(rig.brainDir);

      try {
        await runDream(rig.engine, [
          'review',
          '--input',
          inputFile,
          '--model',
          'anthropic:claude-sonnet-4-6',
          '--json',
        ]);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== 'EXIT') throw e;
      }

      const parsed = JSON.parse(stdout.join('\n')) as {
        status: string;
        details: {
          review_only: boolean;
          pages_written: number;
          model: string;
          proposals: Array<{ slug: string; allowed: boolean }>;
        };
      };

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(parsed.status).toBe('ok');
      expect(parsed.details.review_only).toBe(true);
      expect(parsed.details.pages_written).toBe(0);
      expect(parsed.details.model).toBe('anthropic:claude-sonnet-4-6');
      expect(parsed.details.proposals).toHaveLength(1);
      expect(parsed.details.proposals[0]).toMatchObject({
        slug: 'wiki/originals/ideas/review-only-memory-workflow',
        allowed: true,
      });

      expect(await countRows(rig.engine, 'pages')).toBe(pagesBefore);
      expect(await rig.engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
      expect(await countRows(rig.engine, 'minion_jobs')).toBe(jobsBefore);
      expect(listFiles(rig.brainDir)).toEqual(filesBefore);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
      rmSync(dirname(inputFile), { recursive: true, force: true });
      await rig.cleanup();
    }
  }, 30_000);

  test('CLI review succeeds when queue construction is forbidden', async () => {
    const rig = await setupRig();
    const inputFile = writeTranscript('Review mode should stay independent of workers.\n'.repeat(20));
    let queueConstructed = false;

    installReviewChatStub(inputFile);
    synthTesting.setMinionQueueFactoryForTests(() => {
      queueConstructed = true;
      throw new Error('dream review must not construct MinionQueue');
    });

    try {
      const result = await runReviewCliJson(rig, inputFile);

      expect(result.exitCode).toBe(0);
      expect(result.parsed.status).toBe('ok');
      expect(result.parsed.details.review_only).toBe(true);
      expect(queueConstructed).toBe(false);
    } finally {
      rmSync(dirname(inputFile), { recursive: true, force: true });
      await rig.cleanup();
    }
  }, 30_000);
});

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-review-brain-'));
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('dream.synthesize.min_chars', '1');
  return {
    engine,
    brainDir,
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* best-effort */ }
      try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeTranscript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-review-transcript-'));
  const filePath = join(dir, 'session.txt');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function installReviewChatStub(inputFile: string): void {
  __setChatTransportForTests(async (opts): Promise<ChatResult> => ({
    text: JSON.stringify({
      source_path: inputFile,
      source_date: '2026-05-26',
      proposals: [],
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: opts.model ?? 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  }));
}

async function runReviewCliJson(
  rig: TestRig,
  inputFile: string,
): Promise<{
  exitCode: number;
  parsed: { status: string; details: { review_only: boolean } };
}> {
  const stdout: string[] = [];
  let exitCode = 0;
  const logSpy = spyOn(console, 'log').mockImplementation((msg: unknown) => {
    stdout.push(String(msg));
  });
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new Error('EXIT');
  });

  try {
    await runDream(rig.engine, [
      'review',
      '--input',
      inputFile,
      '--model',
      'anthropic:claude-sonnet-4-6',
      '--json',
    ]);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'EXIT') throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    exitCode,
    parsed: JSON.parse(stdout.join('\n')) as { status: string; details: { review_only: boolean } },
  };
}

async function countRows(engine: PGLiteEngine, table: string): Promise<number> {
  const rows = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  return Number(rows[0]?.count ?? 0);
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(entry => String(entry))
    .filter(entry => statSync(join(root, entry)).isFile())
    .map(entry => relative(root, join(root, entry)))
    .sort();
}
