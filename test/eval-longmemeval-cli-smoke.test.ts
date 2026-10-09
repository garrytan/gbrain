/**
 * Subprocess smoke: the documented `gbrain eval longmemeval` invocation runs
 * end-to-end through the real CLI (pre-dispatch flag validator included).
 *
 * Invariant: `gbrain eval longmemeval <fixture> --retrieval-only --by-type
 * --no-trajectory --keyword-only --output <tmp>` exits 0 and writes a
 * `by_type_summary` line. Pre-fix the flag registry attributed longmemeval's
 * flags to the `dream` row, so this exact command exited 1 with
 * "unknown flag --retrieval-only for 'gbrain eval'" before any eval code ran.
 *
 * Hermetic: --keyword-only imports with noEmbed and searches keyword-only, so
 * no embedding provider / API key is touched; the eval brings its own
 * in-memory PGLite; GBRAIN_HOME points at an empty tmp dir so no user brain or
 * config is read.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';

const REPO = process.cwd();
const CLI = join(REPO, 'src', 'cli.ts');
const FIXTURE = join(REPO, 'test', 'fixtures', 'longmemeval-mini.jsonl');

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'gbrain-lme-cli-smoke-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]) {
  return spawnSync('bun', [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 180_000,
    env: {
      ...process.env,
      GBRAIN_HOME: join(tmp, 'home'),
      GBRAIN_SKIP_STARTUP_HOOKS: '1',
      GBRAIN_QUIET: '1',
    },
  });
}

describe('gbrain eval longmemeval — documented invocation end-to-end', () => {
  test('--retrieval-only --by-type --no-trajectory --keyword-only exits 0 and emits by_type_summary', () => {
    const out = join(tmp, 'out.jsonl');
    const r = run([
      'eval', 'longmemeval', FIXTURE,
      '--retrieval-only', '--by-type', '--no-trajectory', '--keyword-only',
      '--output', out,
    ]);
    const diag = `status=${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`;
    expect(r.stderr, diag).not.toContain('unknown flag');
    expect(r.status, diag).toBe(0);
    expect(existsSync(out), diag).toBe(true);
    const lines = readFileSync(out, 'utf-8').split('\n').filter(l => l.trim());
    const summaryLines = lines.filter(l => {
      try { return JSON.parse(l).kind === 'by_type_summary'; } catch { return false; }
    });
    expect(summaryLines.length, diag).toBe(1);
    // Emitted as the FINAL line (emitByTypeSummary contract).
    expect(JSON.parse(lines[lines.length - 1]).kind).toBe('by_type_summary');
    const summary = JSON.parse(summaryLines[0]);
    expect(summary.schema_version).toBe(2);
    expect(Object.keys(summary.recall_by_type).length).toBeGreaterThan(0);
    // 5 fixture questions → 5 per-question rows + 1 summary.
    expect(lines.length).toBe(6);
  }, 180_000);

  test('a typo is still refused by the validator before any eval code runs', () => {
    const r = run(['eval', 'longmemeval', FIXTURE, '--retrieval-only', '--frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag --frobnicate for 'gbrain eval'");
    expect(r.stderr).not.toContain('[longmemeval]');
  }, 60_000);
});

// A1 (wave 0): every answered row keeps the reader call's provider usage and
// finish reason, normalized so the two cached-token conventions agree. The
// same 100-token prompt with 60 tokens read from cache and 25 reasoning tokens
// is reported the AI SDK v6 way by both providers (input total includes the
// cache buckets); Anthropic's cache counts ride providerMetadata, OpenAI's the
// SDK's cacheRead detail. Hermetic: the generateText seam replaces only the
// final SDK call, so the gateway's own usage normalization runs.
describe('gbrain eval longmemeval: reader usage on every row (A1)', () => {
  afterEach(() => {
    __setGenerateTextTransportForTests(null);
    resetGateway();
  });

  const PROVIDERS = {
    anthropic: {
      model: 'anthropic:claude-opus-5-5',
      result: { finishReason: 'stop', usage: { inputTokens: 100, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0 }, outputTokens: 30, outputTokenDetails: { textTokens: 5, reasoningTokens: 25 } },
        providerMetadata: { anthropic: { cacheReadInputTokens: 60, cacheCreationInputTokens: 0 } } },
    },
    openai: {
      model: 'openai:gpt-6.1-sol',
      result: { finishReason: 'stop', usage: { inputTokens: 100, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60, cacheWriteTokens: undefined }, outputTokens: 30, outputTokenDetails: { textTokens: 5, reasoningTokens: 25 }, cachedInputTokens: 60 } },
    },
  } as const;

  for (const [provider, { model, result }] of Object.entries(PROVIDERS)) {
    test(`${provider}: reader_usage and reader_finish_reason on each answered row`, async () => {
      configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake' } });
      let calls = 0;
      __setGenerateTextTransportForTests((async () => {
        calls++;
        return { content: [{ type: 'text', text: 'stub reader answer' }], ...result };
      }) as never);
      const engine = await createBenchmarkBrain();
      const out = join(tmp, `usage-${provider}.jsonl`);
      try {
        await runEvalLongMemEval([FIXTURE, '--keyword-only', '--no-trajectory', '--limit', '2', '--model', model, '--output', out], { engine });
      } finally {
        await engine.disconnect();
      }
      const rows = readFileSync(out, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).filter(r => r.kind !== 'by_type_summary');
      expect(rows.length).toBe(2);
      expect(calls).toBe(2);
      for (const row of rows) {
        expect(row.hypothesis).toBe('stub reader answer');
        expect(row.reader_finish_reason).toBe('end_turn');
        expect(row.reader_usage).toEqual({
          total_input_tokens: 100, uncached_input_tokens: 40, cache_read_input_tokens: 60, cache_write_input_tokens: 0,
          output_tokens: 30, reasoning_tokens: 25,
        });
      }
    }, 60_000);
  }
});
