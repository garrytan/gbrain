/**
 * #1307: brainstorm/lsd cross-generation must honor the configured
 * chat_model (not a hardcoded Anthropic id) and expose a --model flag.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { resolveBrainstormModel } from '../../src/core/brainstorm/orchestrator.ts';
import { parseBrainstormArgs } from '../../src/commands/brainstorm.ts';

afterAll(() => {
  resetGateway();
});

describe('resolveBrainstormModel (#1307)', () => {
  test('explicit override wins', () => {
    expect(resolveBrainstormModel('openai:gpt-4o')).toBe('openai:gpt-4o');
  });

  test('falls back to the configured chat_model, not hardcoded anthropic', () => {
    configureGateway({ chat_model: 'deepseek:deepseek-chat', env: {} });
    expect(resolveBrainstormModel()).toBe('deepseek:deepseek-chat');
  });

  test('unconfigured gateway degrades to the historical default', () => {
    resetGateway();
    expect(resolveBrainstormModel()).toBe('anthropic:claude-sonnet-4-6');
  });
});

describe('--model CLI flag (#1307)', () => {
  test('parses into args.model', () => {
    const parsed = parseBrainstormArgs(['why?', '--model', 'openai:gpt-4o']);
    expect(parsed.model).toBe('openai:gpt-4o');
    expect(parsed.error).toBeUndefined();
  });

  test('missing value errors', () => {
    const parsed = parseBrainstormArgs(['why?', '--model']);
    expect(parsed.error).toContain('--model requires a model id');
  });
});
