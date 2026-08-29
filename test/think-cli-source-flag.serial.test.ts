/**
 * #4508 — `gbrain think "<q>" --source <id>` used to leak the flag into the
 * question.
 *
 * runThinkCli's flag-strip list lacked `--source` (and `--calibration-holder`),
 * so the flag AND its value joined the positional question: the output echoed
 * `# --source X <question>`, exit 0, and the scope was silently ignored. The
 * CLI now parses --source, validates it (unknown source → exit 1), threads
 * sourceId into runThink, and strips --calibration-holder's value too.
 *
 * runThink is mocked (no LLM, no retrieval) — these tests pin the CLI arg
 * surface only. Source validation runs against a stub engine that knows one
 * source: 'workspace'.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

const captured: { opts: Array<Record<string, unknown>> } = { opts: [] };

const stubResult = {
  answer: 'Stub answer.',
  citations: [],
  gaps: [],
  warnings: [],
  modelUsed: 'none',
  pagesGathered: 0,
  takesGathered: 0,
  graphHits: 0,
};

mock.module('../src/core/think/index.ts', () => ({
  runThink: async (_engine: unknown, opts: Record<string, unknown>) => {
    captured.opts.push(opts);
    return JSON.parse(JSON.stringify(stubResult));
  },
  persistSynthesis: async () => ({ slug: 'synthesis/stub', evidenceInserted: 0, warnings: [] }),
  stripGapsSection: (s: string) => s,
}));

const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({
  ...realConfig,
  isThinClient: () => false,
}));

const { runThinkCli } = await import('../src/commands/think.ts');

/** Stub engine: assertSourceExists's query resolves only 'workspace'. */
const stubEngine = {
  executeRaw: async (_sql: string, params?: unknown[]) =>
    params?.[0] === 'workspace' ? [{ id: 'workspace' }] : [],
} as never;

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitSentinel';
  }
}

async function runCli(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;
  try {
    await runThinkCli(stubEngine, args);
    return { code: 0, out, err };
  } catch (e) {
    if (e instanceof ExitSentinel) return { code: e.code, out, err };
    throw e;
  } finally {
    console.log = savedLog;
    console.error = savedError;
    (process as unknown as { exit: typeof savedExit }).exit = savedExit;
  }
}

beforeEach(() => { captured.opts.length = 0; });

describe('#4508 think --source CLI surface', () => {
  test('--source is parsed out of the question and threaded into runThink', async () => {
    const r = await runCli(['what', 'is', 'acme-example', '--source', 'workspace']);
    expect(r.code).toBe(0);
    // The question header is pure — pre-fix it read "# --source workspace what is acme-example".
    expect(r.out[0]).toBe('# what is acme-example\n');
    expect(captured.opts).toHaveLength(1);
    expect(captured.opts[0].question).toBe('what is acme-example');
    expect(captured.opts[0].sourceId).toBe('workspace');
  });

  test('an unknown --source is rejected with exit 1 (never silently ignored)', async () => {
    const r = await runCli(['what', 'is', 'acme-example', '--source', 'nope-source']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('nope-source');
    expect(captured.opts).toHaveLength(0); // never reached runThink
  });

  test('--calibration-holder value no longer leaks into the question', async () => {
    const r = await runCli(['a', 'question', '--with-calibration', '--calibration-holder', 'holder-example']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe('# a question\n');
    expect(captured.opts[0].question).toBe('a question');
    expect(captured.opts[0].calibrationHolder).toBe('holder-example');
  });

  test('omitting --source keeps the default scope (no sourceId key)', async () => {
    const r = await runCli(['plain', 'question']);
    expect(r.code).toBe(0);
    expect(captured.opts[0].sourceId).toBeUndefined();
  });

  test('think --help documents --source', async () => {
    const r = await runCli(['--help']);
    expect(r.out.join('\n')).toContain('--source');
  });
});
