import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetAiTelemetryForTests,
  aiTelemetrySettings,
  initializeAiTelemetry,
  isAiTelemetryEnabled,
} from '../src/core/ai/telemetry.ts';
import { __listDrainerNamesForTest } from '../src/core/background-work.ts';

const KEYS = [
  'GBRAIN_OTEL_ENABLED',
  'GBRAIN_OTEL_RECORD_INPUTS',
  'GBRAIN_OTEL_RECORD_OUTPUTS',
  'GBRAIN_OTEL_PROVIDERS',
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  __resetAiTelemetryForTests();
});

describe('AI gateway telemetry settings', () => {
  test('disabled by default with no telemetry settings', async () => {
    expect(isAiTelemetryEnabled()).toBe(false);
    expect(aiTelemetrySettings({
      functionId: 'gbrain.ai.chat',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })).toBeUndefined();
    await initializeAiTelemetry();
    expect(__listDrainerNamesForTest()).toContain('ai-telemetry');
  });

  test('enabled settings omit sensitive inputs and outputs by default', () => {
    process.env.GBRAIN_OTEL_ENABLED = 'true';
    expect(aiTelemetrySettings({
      functionId: 'gbrain.ai.chat',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      metadata: { 'gbrain.prompt_cache.enabled': true },
    })).toEqual({
      isEnabled: true,
      functionId: 'gbrain.ai.chat',
      recordInputs: false,
      recordOutputs: false,
      metadata: {
        'gbrain.provider': 'anthropic',
        'gbrain.model': 'claude-sonnet-4-6',
        'gbrain.prompt_cache.enabled': true,
      },
    });
  });

  test('content recording requires independent explicit opt-ins', () => {
    process.env.GBRAIN_OTEL_ENABLED = '1';
    process.env.GBRAIN_OTEL_RECORD_INPUTS = 'yes';
    process.env.GBRAIN_OTEL_RECORD_OUTPUTS = 'on';
    const settings = aiTelemetrySettings({
      functionId: 'gbrain.ai.expand',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(settings?.recordInputs).toBe(true);
    expect(settings?.recordOutputs).toBe(true);
  });

  test('provider filter can limit traces to native Anthropic', () => {
    process.env.GBRAIN_OTEL_ENABLED = 'true';
    process.env.GBRAIN_OTEL_PROVIDERS = 'anthropic';
    expect(aiTelemetrySettings({
      functionId: 'gbrain.ai.chat',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    })).toBeDefined();
    expect(aiTelemetrySettings({
      functionId: 'gbrain.ai.chat',
      provider: 'openai',
      model: 'gpt-5',
    })).toBeUndefined();
  });
});
