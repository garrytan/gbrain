/**
 * #3962 — `takes extract --from-pages --json` must emit the structured
 * extraction result instead of the human summary line.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseTakesBeforeCursor, runTakes } from '../src/commands/takes.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const queries: Array<{ sql: string; params: unknown[] }> = [];
const engine = {
  getConfig: async (key: string) => key === 'takes.bootstrap_enabled' ? 'true' : null,
  executeRaw: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return [];
  },
} as unknown as BrainEngine;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

beforeAll(() => {
  configureGateway({
    chat_model: 'openai:gpt-test',
    env: { OPENAI_API_KEY: 'sk-test-takes-json' },
  });
});

afterAll(() => {
  resetGateway();
});

describe('gbrain takes extract --from-pages --json (#3962)', () => {
  test('emits the extraction result as parseable JSON', async () => {
    const stdout = await captureStdout(() =>
      runTakes(engine, ['extract', '--from-pages', '--dry-run', '--json']));

    expect(JSON.parse(stdout)).toEqual({
      pages_scanned: 0,
      claims_extracted: 0,
      next_before: null,
      consent_gate_blocked: false,
      llm_unavailable: false,
      // #4473: md-first skip accounting.
      pages_skipped: 0,
      skipped: [],
      mirror_warnings: 0,
      // B-14: budget stop + fence dedupe accounting.
      budget_exhausted: false,
      duplicates_skipped: 0,
    });
  });

  test('--before reaches the page query as bound parameters, never as SQL text', async () => {
    queries.length = 0;
    const cursorTs = '2031-07-08 09:10:11.654321-05';
    await captureStdout(() =>
      runTakes(engine, ['extract', '--from-pages', '--json', '--dry-run', '--before', `${cursorTs},977`, '--source-id', 'default']));
    const pageQuery = queries.find((q) => q.sql.includes('FROM pages'));
    expect(pageQuery).toBeDefined();
    expect(pageQuery!.sql).not.toContain(cursorTs);
    expect(pageQuery!.sql).not.toContain('977');
    expect(pageQuery!.params).toEqual(['default', cursorTs, 977]);
    // Bound as text, cast in SQL: postgres.js would round a timestamptz-typed bind to milliseconds.
    expect(pageQuery!.sql).toMatch(/\(updated_at, id\) < \(\$2::text::timestamptz, \$3\)/);
    expect(pageQuery!.sql).toMatch(/ORDER BY updated_at DESC, id DESC/);
  });

  test('negative control: without --before the page query carries no cursor condition', async () => {
    queries.length = 0;
    await captureStdout(() => runTakes(engine, ['extract', '--from-pages', '--json', '--dry-run']));
    const pageQuery = queries.find((q) => q.sql.includes('FROM pages'));
    expect(pageQuery!.sql).not.toContain('(updated_at, id) <');
    expect(pageQuery!.params).toEqual([]);
  });
});

describe('takes extract --before cursor validation (#5059)', () => {
  test('a next_before value parses; absent --before is undefined', () => {
    expect(parseTakesBeforeCursor(['--from-pages', '--before', '2030-01-02 03:04:05.123456+00,42'])).toEqual({ updatedAt: '2030-01-02 03:04:05.123456+00', id: 42 });
    expect(parseTakesBeforeCursor(['--from-pages', '--before', '2030-01-02T03:04:05Z,7'])).toEqual({ updatedAt: '2030-01-02T03:04:05Z', id: 7 });
    expect(parseTakesBeforeCursor(['--from-pages'])).toBeUndefined();
  });

  for (const [what, argv] of [
    ['a missing value', ['--from-pages', '--before']],
    ['a flag in the value slot', ['--from-pages', '--before', '--json']],
    ['no page id', ['--from-pages', '--before', '2030-01-02 03:04:05+00']],
    ['a non-positive page id', ['--from-pages', '--before', '2030-01-02 03:04:05+00,0']],
    ['free text', ['--from-pages', '--before', 'acme-example-secret,12']],
  ] as const) {
    test(`${what} is an exit-2 usage error with the contract, never echoing the value`, () => {
      let err: unknown;
      try { parseTakesBeforeCursor(argv); } catch (e) { err = e; }
      const rendered = renderCliError(err, { json: true, command: 'takes', tty: false });
      expect(rendered.exitCode).toBe(2);
      const env = JSON.parse(rendered.stdout!);
      expect(env).toMatchObject({
        code: 'invalid_params',
        fix: { argv: ['gbrain', 'takes', 'extract', '--from-pages', '--dry-run', '--json'], verify: { argv: ['gbrain', 'config', 'get', 'takes.bootstrap_enabled'] } },
      });
      expect(env.message).toContain('--before');
      expect(env.why).toBeTruthy();
      expect(env.fix.next).toBe('run');
      expect(rendered.stdout).not.toContain('acme-example-secret');
    });
  }

  test('the human summary prints the next cursor to pass', async () => {
    const pageEngine = {
      getConfig: async (key: string) => key === 'takes.bootstrap_enabled' ? 'true' : null,
      executeRaw: async (sql: string) => sql.includes('FROM pages')
        ? [{ id: 9, slug: 'concepts/short', source_id: 'default', type: 'concept', compiled_truth: 'too short', updated_at: new Date('2030-01-02T03:04:05.123Z'), resume_at: '2030-01-02 03:04:05.123456+00,9' }]
        : [],
    } as unknown as BrainEngine;
    const stdout = await captureStdout(() => runTakes(pageEngine, ['extract', '--from-pages', '--dry-run']));
    expect(stdout).toContain("next: --before '2030-01-02 03:04:05.123456+00,9'");
  });
});

