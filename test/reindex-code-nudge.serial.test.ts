/**
 * v0.37.3 — code-model nudge: pure helper + CLI integration coverage.
 *
 * SERIAL: this file mutates process.env AND monkey-patches process.stderr.write
 * to capture the nudge output. Both are process-global; running alongside
 * other tests in the same shard would race.
 *
 * shouldNudgeCodeModel() is a pure function over the bare model name
 * (what getEmbeddingModelName() returns — the gateway strips the
 * provider prefix). The nudge fires from runReindexCode (not the CLI
 * wrapper) so dry-run AND execute paths both surface it. The integration
 * tests guard the three suppression flags (--json, GBRAIN_NO_CODE_MODEL_NUDGE,
 * --no-embed) + the stderr-vs-stdout placement contract.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  shouldNudgeCodeModel,
  runReindexCode,
} from '../src/commands/reindex-code.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

describe('shouldNudgeCodeModel — pure function', () => {
  test('text-embedding-3-large → nudge fires', () => {
    const d = shouldNudgeCodeModel('text-embedding-3-large');
    expect(d.shouldNudge).toBe(true);
    if (d.shouldNudge) {
      expect(d.currentModel).toBe('text-embedding-3-large');
      expect(d.recommendedModel).toBe('voyage:voyage-code-3');
    }
  });

  test('text-embedding-3-small → nudge fires', () => {
    const d = shouldNudgeCodeModel('text-embedding-3-small');
    expect(d.shouldNudge).toBe(true);
  });

  test('voyage-4-large (general-purpose Voyage) → nudge fires', () => {
    // Voyage's general flagships are NOT code-tuned; nudge still fires.
    const d = shouldNudgeCodeModel('voyage-4-large');
    expect(d.shouldNudge).toBe(true);
  });

  test('voyage-code-3 (already optimal) → no nudge', () => {
    const d = shouldNudgeCodeModel('voyage-code-3');
    expect(d.shouldNudge).toBe(false);
  });

  test('Voyage-Code-3 (case-insensitive) → no nudge', () => {
    const d = shouldNudgeCodeModel('Voyage-Code-3');
    expect(d.shouldNudge).toBe(false);
  });

  test('empty / null / undefined / whitespace → no nudge (fail-open)', () => {
    expect(shouldNudgeCodeModel('').shouldNudge).toBe(false);
    expect(shouldNudgeCodeModel('   ').shouldNudge).toBe(false);
    expect(shouldNudgeCodeModel(null).shouldNudge).toBe(false);
    expect(shouldNudgeCodeModel(undefined).shouldNudge).toBe(false);
  });
});

describe('runReindexCode — nudge integration (dry-run path reaches nudge)', () => {
  let engine: PGLiteEngine;
  let prevNudgeEnv: string | undefined;
  let stderrBuf: string;
  let stdoutBuf: string;
  let origStderr: typeof process.stderr.write;
  let origStdout: typeof process.stdout.write;

  beforeAll(async () => {
    prevNudgeEnv = process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Seed one code page so totalPages > 0 (nudge gate requires work).
    await engine.putPage('src-foo-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/foo.ts (typescript)',
      compiled_truth: 'export function foo() { return 42; }',
      timeline: '',
      frontmatter: { language: 'typescript', file: 'src/foo.ts' },
    });
  });

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    if (prevNudgeEnv === undefined) delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    else process.env.GBRAIN_NO_CODE_MODEL_NUDGE = prevNudgeEnv;
  }, 30_000);

  function captureStreams() {
    stderrBuf = '';
    stdoutBuf = '';
    origStderr = process.stderr.write.bind(process.stderr);
    origStdout = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (s: string | Uint8Array) => {
      stderrBuf += typeof s === 'string' ? s : Buffer.from(s).toString();
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (s: string | Uint8Array) => {
      stdoutBuf += typeof s === 'string' ? s : Buffer.from(s).toString();
      return true;
    };
  }

  function restoreStreams() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origStderr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origStdout;
  }

  test('non-code-tuned model + default invocation → nudge fires on stderr (NOT stdout)', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    captureStreams();
    try {
      await runReindexCode(engine, { dryRun: true });
    } finally {
      restoreStreams();
    }
    expect(stderrBuf).toContain('[reindex-code]');
    expect(stderrBuf).toContain('voyage:voyage-code-3');
    expect(stderrBuf).toContain('text-embedding-3-large'); // current model echoed
    expect(stdoutBuf).toBe(''); // nudge MUST NOT pollute stdout
    resetGateway();
  });

  test('--no-embed (noEmbed: true) → nudge suppressed even on non-code-tuned model', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    captureStreams();
    try {
      await runReindexCode(engine, { dryRun: true, noEmbed: true });
    } finally {
      restoreStreams();
    }
    expect(stderrBuf).not.toContain('[reindex-code]');
    resetGateway();
  });

  test('json mode (opts.json: true) → no nudge anywhere', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    captureStreams();
    try {
      await runReindexCode(engine, { dryRun: true, json: true });
    } finally {
      restoreStreams();
    }
    expect(stderrBuf).not.toContain('[reindex-code]');
    expect(stdoutBuf).toBe(''); // runReindexCode never writes stdout itself
    resetGateway();
  });

  test('GBRAIN_NO_CODE_MODEL_NUDGE=1 → nudge suppressed', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    process.env.GBRAIN_NO_CODE_MODEL_NUDGE = '1';
    captureStreams();
    try {
      await runReindexCode(engine, { dryRun: true });
    } finally {
      restoreStreams();
      delete process.env.GBRAIN_NO_CODE_MODEL_NUDGE;
    }
    expect(stderrBuf).not.toContain('[reindex-code]');
    resetGateway();
  });

  test('voyage-code-3 configured (already optimal) → no nudge', async () => {
    configureGateway({
      embedding_model: 'voyage:voyage-code-3',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'pa-test' },
    });
    captureStreams();
    try {
      await runReindexCode(engine, { dryRun: true });
    } finally {
      restoreStreams();
    }
    expect(stderrBuf).not.toContain('[reindex-code]');
    expect(stderrBuf).not.toContain('Switch:');
    resetGateway();
  });
});
