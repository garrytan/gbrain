/**
 * Default-embedder swap: ollama:bge-m3 @ 1024 with a loud hosted fallback.
 *
 * ZeroEntropy's hosted API (the previous default) sunsets 2026-09-04. The
 * new default is open-weight + local (cannot be sunset); when Ollama is
 * unreachable at `gbrain init`, init lands on the hosted fallback
 * (openai:text-embedding-3-small @ 1024) — loudly, with the way back — and
 * persists the `embedding_default_fallback` marker so `gbrain doctor`
 * re-checks for Ollama on every run.
 *
 * Reachability is stubbed via `__setOllamaProbeForTests` (no fake daemon);
 * the probe's own network behavior is covered only for the no-server case
 * (dead port → fail-open), which needs no listener.
 *
 * Master-discrimination: the "declared default" and "fallback resolution"
 * tests fail BEHAVIORALLY on pre-swap code (wrong model/dims resolved, no
 * marker, no notice) — see also test/e2e/init-fresh-pglite.test.ts, whose
 * updated subprocess tests prove the same through the real CLI.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import {
  __setOllamaProbeForTests,
  probeOllamaModel,
  ollamaApiBase,
  type OllamaProbeResult,
} from '../src/core/ai/ollama-detect.ts';

/**
 * withEnv overrides that clear every embedding-provider auth key
 * (enumerated from the recipe registry, not hardcoded) so resolution is
 * deterministic on dev machines with ambient keys.
 */
async function embeddingKeyClears(): Promise<Record<string, undefined>> {
  const { RECIPES } = await import('../src/core/ai/recipes/index.ts');
  const overrides: Record<string, undefined> = {};
  for (const recipe of RECIPES.values()) {
    if (!recipe.touchpoints.embedding) continue;
    for (const key of recipe.auth_env?.required ?? []) overrides[key] = undefined;
  }
  return overrides;
}

describe('declared default: ollama:bge-m3 @ 1024', () => {
  test('DEFAULT_EMBEDDING_MODEL / DIMENSIONS are ollama:bge-m3 @ 1024', async () => {
    const defaults = await import('../src/core/ai/defaults.ts');
    expect(defaults.DEFAULT_EMBEDDING_MODEL).toBe('ollama:bge-m3');
    // bge-m3's NATIVE width. Matryoshka free-truncation was measured for
    // other families, not bge-m3 — do not "round" this in either direction.
    expect(defaults.DEFAULT_EMBEDDING_DIMENSIONS).toBe(1024);
  });

  test('fallback is openai:text-embedding-3-small @ 1024 (same width as the default)', async () => {
    const defaults = await import('../src/core/ai/defaults.ts');
    expect(defaults.FALLBACK_EMBEDDING_MODEL).toBe('openai:text-embedding-3-small');
    // 1024, not the model's native 1536: pinning the fallback at bge-m3's
    // width makes the later fallback→default migration a vector-only
    // rebuild (no column ALTER, no HNSW rebuild). Valid because OpenAI
    // text-embedding-3-* accepts any Matryoshka width ≤ native.
    expect(defaults.FALLBACK_EMBEDDING_DIMENSIONS).toBe(1024);
    const { isValidOpenAITextEmbedding3Dim } = await import('../src/core/ai/dims.ts');
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 1024)).toBe(true);
  });

  test('resolveSchemaEmbeddingDim ACCEPTS both the default and the fallback config', async () => {
    const { resolveSchemaEmbeddingDim } = await import('../src/core/embedding-dim-check.ts');
    const {
      DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS,
      FALLBACK_EMBEDDING_MODEL, FALLBACK_EMBEDDING_DIMENSIONS,
    } = await import('../src/core/ai/defaults.ts');
    for (const [model, dims] of [
      [DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS],
      [FALLBACK_EMBEDDING_MODEL, FALLBACK_EMBEDDING_DIMENSIONS],
    ] as const) {
      const got = resolveSchemaEmbeddingDim({ embedding_model: model, embedding_dimensions: dims });
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.dim).toBe(dims);
    }
  });

  test('the default costs $0 in the embedding price table', async () => {
    const { lookupEmbeddingPrice } = await import('../src/core/embedding-pricing.ts');
    const { DEFAULT_EMBEDDING_MODEL } = await import('../src/core/ai/defaults.ts');
    const price = lookupEmbeddingPrice(DEFAULT_EMBEDDING_MODEL);
    expect(price.kind).toBe('known');
    if (price.kind === 'known') expect(price.pricePerMTok).toBe(0);
  });
});

describe('ollama probe (no daemon involved)', () => {
  test('ollamaApiBase strips /v1 and trailing slashes from OLLAMA_BASE_URL', () => {
    expect(ollamaApiBase({} as NodeJS.ProcessEnv)).toBe('http://localhost:11434');
    expect(ollamaApiBase({ OLLAMA_BASE_URL: 'http://box:11434/v1' } as NodeJS.ProcessEnv)).toBe('http://box:11434');
    expect(ollamaApiBase({ OLLAMA_BASE_URL: 'http://box:11434/' } as NodeJS.ProcessEnv)).toBe('http://box:11434');
  });

  test('unreachable server → fail-open {ok:false, serverUp:false}, never a throw', async () => {
    const res = await probeOllamaModel('bge-m3', {
      env: { OLLAMA_BASE_URL: 'http://127.0.0.1:9' } as NodeJS.ProcessEnv,
      timeoutMs: 800,
    });
    expect(res.ok).toBe(false);
    expect(res.serverUp).toBe(false);
    expect(res.reason).toBe('unreachable');
  });
});

describe('init embedding resolution (probe stubbed)', () => {
  afterEach(() => {
    __setOllamaProbeForTests(null);
  });

  /** Run resolveEmbeddingByEnv with stubbed probe + controlled env, capturing stderr. */
  async function resolveWith(
    probe: OllamaProbeResult,
    envKeys: Record<string, string>,
  ): Promise<{ out: import('../src/commands/init.ts').ResolvedAIOptions; notice: string }> {
    __setOllamaProbeForTests(async () => probe);
    const clears = await embeddingKeyClears();
    const errLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
    try {
      return await withEnv({ ...clears, ...envKeys }, async () => {
        const { resolveEmbeddingByEnv } = await import('../src/commands/init.ts');
        const out: import('../src/commands/init.ts').ResolvedAIOptions = {};
        await resolveEmbeddingByEnv(out, /* nonInteractive */ true);
        return { out, notice: errLines.join('\n') };
      });
    } finally {
      console.error = origError;
    }
  }

  test('happy path: Ollama + bge-m3 available → the default wins, even over env keys', async () => {
    // A hosted key present must NOT shadow the default.
    const { out, notice } = await resolveWith(
      { ok: true, serverUp: true, reason: 'ok' },
      { OPENAI_API_KEY: 'sk-test' },
    );
    expect(out.embedding_model).toBe('ollama:bge-m3');
    expect(out.embedding_dimensions).toBe(1024);
    expect(out.embeddingFallback).toBeUndefined();
    expect(notice).toContain('Detected Ollama with bge-m3');
  });

  test('fallback path: Ollama absent + OPENAI_API_KEY → hosted fallback, marker, LOUD notice', async () => {
    const { out, notice } = await resolveWith(
      { ok: false, serverUp: false, reason: 'unreachable' },
      { OPENAI_API_KEY: 'sk-test' },
    );
    expect(out.embedding_model).toBe('openai:text-embedding-3-small');
    expect(out.embedding_dimensions).toBe(1024);
    expect(out.embeddingFallback).toBe(true);
    // Visible, not silent: names the default, the reason, the trade-off,
    // and the paste-ready way back.
    expect(notice).toContain('default embedder is ollama:bge-m3');
    expect(notice).toContain('Ollama is not reachable');
    expect(notice).toContain('weaker on non-English content');
    expect(notice).toContain('ollama pull bge-m3');
    expect(notice).toContain('gbrain migrate embeddings --to ollama:bge-m3 --dim 1024');
  });

  test('fallback notice distinguishes "running but model not pulled"', async () => {
    const { out, notice } = await resolveWith(
      { ok: false, serverUp: true, reason: 'model_missing' },
      { OPENAI_API_KEY: 'sk-test' },
    );
    expect(out.embeddingFallback).toBe(true);
    expect(notice).toContain('running but bge-m3 is not pulled');
  });

  test('no Ollama, no OpenAI key, one other provider key → existing single-key auto-pick unchanged', async () => {
    const { out } = await resolveWith(
      { ok: false, serverUp: false, reason: 'unreachable' },
      { VOYAGE_API_KEY: 'pa-test' },
    );
    expect(out.embedding_model?.startsWith('voyage:')).toBe(true);
    expect(out.embeddingFallback).toBeUndefined();
  });
});

describe('doctor re-check: embedding_default_fallback', () => {
  afterEach(() => {
    __setOllamaProbeForTests(null);
  });

  /** Write a config.json into a throw-away GBRAIN_HOME and run the check there. */
  async function checkWith(
    cfg: Record<string, unknown>,
    probe: OllamaProbeResult | null,
  ): Promise<{ status: string; message: string }> {
    if (probe) __setOllamaProbeForTests(async () => probe);
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-fallback-doctor-'));
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify(cfg));
    try {
      return await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const { checkEmbeddingDefaultFallback } = await import('../src/commands/doctor.ts');
        return checkEmbeddingDefaultFallback({} as never);
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }

  test('warns with the migrate command once Ollama becomes available', async () => {
    const check = await checkWith({
      engine: 'pglite',
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1024,
      embedding_default_fallback: 'ollama:bge-m3',
    }, { ok: true, serverUp: true, reason: 'ok' });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain migrate embeddings --to ollama:bge-m3 --dim 1024');
  });

  test('stays ok (informational) while Ollama is still unavailable', async () => {
    const check = await checkWith({
      engine: 'pglite',
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1024,
      embedding_default_fallback: 'ollama:bge-m3',
    }, { ok: false, serverUp: false, reason: 'unreachable' });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('hosted embedding fallback');
  });

  test('stale marker (user moved off the fallback) is ignored', async () => {
    // Probe stubbed "available" to prove the staleness guard short-circuits
    // before the probe even matters.
    const check = await checkWith({
      engine: 'pglite',
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
      embedding_default_fallback: 'ollama:bge-m3',
    }, { ok: true, serverUp: true, reason: 'ok' });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('stale');
  });

  test('no marker → skip', async () => {
    const check = await checkWith(
      { engine: 'pglite', embedding_model: 'openai:text-embedding-3-small' },
      null,
    );
    expect(check.status).toBe('ok');
    expect(check.message).toContain('skip');
  });
});
