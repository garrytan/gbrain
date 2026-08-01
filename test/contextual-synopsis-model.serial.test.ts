/**
 * Task 5: provider-neutral contextual synopsis model routing.
 * Hermetic resolver coverage; no DB or provider credentials required.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { TIER_DEFAULTS, resolveModel } from '../src/core/model-config.ts';
import { runModels } from '../src/commands/models.ts';
import {
  makeContextualReindexHandler,
  resolveContextualSynopsisLeaseSettings,
  resolveContextualSynopsisModel,
} from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import type { ReembedPageArgs } from '../src/core/contextual-retrieval-service.ts';
import {
  __setGenerateTextTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  validateModelId,
} from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

class StubConfigEngine {
  private readonly config = new Map<string, string>();
  readonly reads: string[] = [];

  set(key: string, value: string): void {
    this.config.set(key, value);
  }

  unset(key: string): void {
    this.config.delete(key);
  }

  async getConfig(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.config.get(key) ?? null;
  }

  async getPage(): Promise<{ source_id: string }> {
    return { source_id: 'default' };
  }
}

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('contextual synopsis model resolution', () => {
  test('isolates rate leases by resolved model', () => {
    expect(resolveContextualSynopsisLeaseSettings('openai:gpt-5.2', {})).toMatchObject({
      key: 'contextual-synopsis:openai:gpt-5.2',
    });
    expect(resolveContextualSynopsisLeaseSettings('anthropic:claude-haiku-4-5', {})).toMatchObject({
      key: 'contextual-synopsis:anthropic:claude-haiku-4-5',
    });
  });

  test('prefers the canonical synopsis RPM setting over the Haiku alias', () => {
    expect(resolveContextualSynopsisLeaseSettings('openai:gpt-5.2', {
      GBRAIN_CONTEXTUAL_SYNOPSIS_RPM: '17',
      GBRAIN_CONTEXTUAL_HAIKU_RPM: '9',
    })).toEqual({
      key: 'contextual-synopsis:openai:gpt-5.2',
      maxConcurrent: 17,
    });
  });

  test('retains the Haiku RPM alias and the existing default', () => {
    expect(resolveContextualSynopsisLeaseSettings('anthropic:claude-haiku-4-5', {
      GBRAIN_CONTEXTUAL_HAIKU_RPM: '9',
    })).toEqual({
      key: 'contextual-synopsis:anthropic:claude-haiku-4-5',
      maxConcurrent: 9,
    });

    expect(resolveContextualSynopsisLeaseSettings('openai:gpt-5.2', {})).toEqual({
      key: 'contextual-synopsis:openai:gpt-5.2',
      maxConcurrent: 50,
    });
  });

  test('uses the canonical precedence and utility tier keeps caller fallback unreachable', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.contextual_synopsis', 'codex-proxy:new-key');
    engine.set('contextual_retrieval.haiku_model', 'codex-proxy:deprecated-key');
    engine.set('models.default', 'codex-proxy:global-default');
    engine.set('models.tier.utility', 'codex-proxy:utility-tier');

    await withEnv({ GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL: 'codex-proxy:env-model' }, async () => {
      expect(await resolveContextualSynopsisModel(engine as never, 'codex-proxy:explicit')).toBe(
        'codex-proxy:explicit',
      );

      expect(await resolveContextualSynopsisModel(engine as never)).toBe('codex-proxy:new-key');

      engine.unset('models.contextual_synopsis');
      expect(await resolveContextualSynopsisModel(engine as never)).toBe(
        'codex-proxy:deprecated-key',
      );

      engine.unset('contextual_retrieval.haiku_model');
      expect(await resolveContextualSynopsisModel(engine as never)).toBe(
        'codex-proxy:global-default',
      );

      engine.unset('models.default');
      expect(await resolveContextualSynopsisModel(engine as never)).toBe(
        'codex-proxy:utility-tier',
      );

      engine.unset('models.tier.utility');
      expect(await resolveContextualSynopsisModel(engine as never)).toBe(
        'codex-proxy:env-model',
      );
    });

    expect(await resolveContextualSynopsisModel(engine as never)).toBe(TIER_DEFAULTS.utility);

    expect(
      await resolveModel(engine as never, {
        configKey: 'models.contextual_synopsis',
        deprecatedConfigKey: 'contextual_retrieval.haiku_model',
        envVar: 'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL',
        tier: 'utility',
        fallback: 'codex-proxy:caller-fallback-must-not-win',
      }),
    ).toBe(TIER_DEFAULTS.utility);
  });

  test('reports the contextual synopsis route in gbrain models JSON', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.contextual_synopsis', 'codex-proxy:gpt-5.6-luna');

    let stdout = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await runModels(engine as never, ['--json']);
    } finally {
      process.stdout.write = originalWrite;
    }

    const report = JSON.parse(stdout) as {
      per_task: Array<{
        key: string;
        tier: string;
        resolved: string;
        source: string;
        description: string;
      }>;
    };
    expect(report.per_task).toContainEqual({
      key: 'models.contextual_synopsis',
      tier: 'utility',
      resolved: 'codex-proxy:gpt-5.6-luna',
      source: 'config: models.contextual_synopsis',
      description: 'Per-chunk contextual synopsis generation',
    });
  });

  test('models report honors the synopsis deprecated key and dedicated env', async () => {
    const engine = new StubConfigEngine();
    engine.set('contextual_retrieval.haiku_model', 'codex-proxy:deprecated-report');

    await withEnv({
      GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL: 'codex-proxy:dedicated-env',
      GBRAIN_MODEL: 'codex-proxy:wrong-generic-env',
    }, async () => {
      const deprecatedReport = await captureModelsReport(engine);
      expect(deprecatedReport.per_task.find((entry) =>
        entry.key === 'models.contextual_synopsis'
      )).toMatchObject({
        resolved: 'codex-proxy:deprecated-report',
        source: 'config: contextual_retrieval.haiku_model',
      });

      engine.unset('contextual_retrieval.haiku_model');
      const envReport = await captureModelsReport(engine);
      expect(envReport.per_task.find((entry) =>
        entry.key === 'models.contextual_synopsis'
      )).toMatchObject({
        resolved: 'codex-proxy:dedicated-env',
        source: 'env: GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL',
      });
    });
  });

  test('handler resolves once and passes synopsisModel to the service seam', async () => {
    const engine = new StubConfigEngine();
    engine.set('models.contextual_synopsis', 'codex-proxy:gpt-5.6-luna');
    const serviceCalls: ReembedPageArgs[] = [];
    const handler = makeContextualReindexHandler({
      engine: engine as never,
      reembedPage: async (args) => {
        serviceCalls.push(args);
        return {
          kind: 'success',
          mode_applied: 'per_chunk_synopsis',
          chunks_embedded: 1,
          corpus_generation: 'test-generation',
        };
      },
    });
    const controller = new AbortController();

    const result = await handler({
      id: 42,
      name: 'contextual_reindex_per_chunk',
      data: { page_slug: 'wiki/provider-neutral' },
      signal: controller.signal,
    } as never);

    expect(result).toEqual({
      ok: true,
      mode_applied: 'per_chunk_synopsis',
      chunks_embedded: 1,
    });
    expect(engine.reads.filter((key) => key === 'models.contextual_synopsis')).toHaveLength(1);
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]?.synopsisModel).toBe('codex-proxy:gpt-5.6-luna');
  });

  test('handler registers canonical native synopsis model before service gateway chat', async () => {
    await expectHandlerRegistersNativeSynopsisRoute({
      configKey: 'models.contextual_synopsis',
      model: 'openai:gpt-5.6-luna-contextual-canonical',
    });
  });

  test('handler registers deprecated native synopsis model before service gateway chat', async () => {
    await expectHandlerRegistersNativeSynopsisRoute({
      configKey: 'contextual_retrieval.haiku_model',
      model: 'openai:gpt-5.6-luna-contextual-deprecated',
    });
  });

  test('handler registers env native synopsis model before service gateway chat', async () => {
    await expectHandlerRegistersNativeSynopsisRoute({
      envModel: 'openai:gpt-5.6-luna-contextual-env',
    });
  });
});

async function expectHandlerRegistersNativeSynopsisRoute(opts: {
  configKey?: string;
  model?: string;
  envModel?: string;
}): Promise<void> {
  const engine = new StubConfigEngine();
  const expectedModel = opts.envModel ?? opts.model;
  if (!expectedModel) throw new Error('expectedModel required');
  if (opts.configKey && opts.model) engine.set(opts.configKey, opts.model);

  const generatedModels: string[] = [];
  __setGenerateTextTransportForTests((async (callOpts: { model?: { modelId?: string } }) => {
    generatedModels.push(`openai:${callOpts.model?.modelId ?? '<missing>'}`);
    return {
      text: 'ok',
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
      providerMetadata: {},
    };
  }) as never);

  await withEnv(
    {
      OPENAI_API_KEY: 'test-openai-key',
      GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL: opts.envModel,
      GBRAIN_MODEL: 'openai:gpt-5.2',
    },
    async () => {
      configureGateway({
        chat_model: 'openai:gpt-5.2',
        expansion_model: 'openai:gpt-5.2',
        embedding_model: 'openai:text-embedding-3-small',
        embedding_dimensions: 1536,
        env: process.env as Record<string, string | undefined>,
      });

      const handler = makeContextualReindexHandler({
        engine: engine as never,
        reembedPage: async (args) => {
          expect(args.synopsisModel).toBe(expectedModel);
          const chatResult = await chat({
            model: args.synopsisModel,
            system: 'test',
            messages: [{ role: 'user', content: 'test' }],
          });
          expect(chatResult.model).toBe(expectedModel);
          return {
            kind: 'success',
            mode_applied: 'per_chunk_synopsis',
            chunks_embedded: 1,
            corpus_generation: 'test-generation',
          };
        },
      });

      await expect(handler({
        id: 42,
        name: 'contextual_reindex_per_chunk',
        data: { page_slug: 'wiki/provider-neutral' },
        signal: new AbortController().signal,
      } as never)).resolves.toEqual({
        ok: true,
        mode_applied: 'per_chunk_synopsis',
        chunks_embedded: 1,
      });
    },
  );

  expect(generatedModels).toEqual([expectedModel]);
  expect(validateModelId(expectedModel, 'chat').ok).toBe(true);
  expect(validateModelId(expectedModel, 'expansion').ok).toBe(false);
}

async function captureModelsReport(engine: StubConfigEngine): Promise<{
  per_task: Array<{ key: string; resolved: string; source: string }>;
}> {
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runModels(engine as never, ['--json']);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(stdout) as {
    per_task: Array<{ key: string; resolved: string; source: string }>;
  };
}
