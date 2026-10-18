/**
 * #5304: a provider 404 (`model_not_found`) names the config key that selected
 * the failing model and the one command that changes it, not only the model
 * id. The gateway records each touchpoint's resolution provenance
 * (`gateway-model-sources.ts`); `src/core/ai/model-not-found-hint.ts` turns
 * it into the sentence `normalizeAIError` appends to the 404 fix. Golden per
 * caller: chat (models.tier.reasoning / models.chat / env / config.json pin /
 * built-in default), expansion (models.tier.utility) and embed
 * (embedding_model, a schema-sizing key with its own guard).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AIConfigError, normalizeAIError } from '../../src/core/ai/errors.ts';
import { clearGatewayModelSources, setGatewayModelSource } from '../../src/core/ai/gateway-model-sources.ts';
// Resolved at run time so the fail-first run on a tree without the module reports the missing behaviour, not an import error.
const hint = await import('../../src/core/ai/model-not-found-hint.ts').catch(() => null as never as typeof import('../../src/core/ai/model-not-found-hint.ts'));

const openai404 = (model: string) => Object.assign(new Error(`The model \`${model}\` does not exist or you do not have access to it.`), { statusCode: 404 });

afterEach(() => clearGatewayModelSources());

describe('#5304 model_not_found names the selecting config key', () => {
  test('normalizeAIError appends the route hint to the 404 fix after the model sentence', () => {
    const err = normalizeAIError(openai404('gpt-x'), 'chat(openai:gpt-x)', undefined, 'Selected via models.tier.reasoning. Fix: gbrain config set models.tier.reasoning <provider>:<model>');
    expect(err).toBeInstanceOf(AIConfigError);
    const fix = (err as AIConfigError).fix!;
    expect(fix).toContain('the openai provider does not serve openai:gpt-x');
    expect(fix.indexOf('`gbrain models`')).toBeLessThan(fix.indexOf('Selected via models.tier.reasoning.'));
    expect(fix.endsWith('Fix: gbrain config set models.tier.reasoning <provider>:<model>')).toBe(true);
  });

  test('chat: a tier_config route names models.tier.reasoning and the config set command', () => {
    setGatewayModelSource('chat', 'openai:gpt-x', { source: 'tier_config', origin: 'models.tier.reasoning' });
    const err = normalizeAIError(openai404('gpt-x'), 'chat(openai:gpt-x)', undefined, hint.gatewayModelNotFoundHint('chat', 'openai:gpt-x'));
    expect(err).toBeInstanceOf(AIConfigError);
    const fix = (err as AIConfigError).fix!;
    expect(fix).toContain('the openai provider does not serve openai:gpt-x');
    expect(fix).toContain('Selected via models.tier.reasoning.');
    expect(fix).toContain('gbrain config set models.tier.reasoning <provider>:<model>');
  });

  test('chat: config_key, models_default, deprecated_key and cli_flag routes name their origin', () => {
    expect(hint.modelRouteHint({ source: 'config_key', origin: 'models.chat' }, 'chat')).toBe('Selected via models.chat. Fix: gbrain config set models.chat <provider>:<model>');
    expect(hint.modelRouteHint({ source: 'models_default', origin: 'models.default' }, 'chat')).toBe('Selected via models.default. Fix: gbrain config set models.default <provider>:<model>');
    expect(hint.modelRouteHint({ source: 'deprecated_key', origin: 'chat_model' }, 'chat')).toBe('Selected via chat_model (deprecated key). Fix: gbrain config unset chat_model, then gbrain config set models.chat <provider>:<model>');
    expect(hint.modelRouteHint({ source: 'cli_flag', origin: '--model' }, 'chat')).toBe('Selected via --model. Fix: pass a model the provider serves.');
  });

  test('chat: env and config.json pins say what to clear', () => {
    expect(hint.modelRouteHint({ source: 'env', origin: 'GBRAIN_CHAT_MODEL' }, 'chat')).toBe('Selected via the GBRAIN_CHAT_MODEL environment variable. Fix: unset GBRAIN_CHAT_MODEL or point it at a model the provider serves.');
    expect(hint.modelRouteHint({ source: 'file_config', origin: 'chat_model (config.json)' }, 'chat')).toBe('Selected via chat_model in ~/.gbrain/config.json. Fix: remove chat_model there or set it to a model the provider serves.');
  });

  test('chat: the built-in default names the tier key to set', () => {
    setGatewayModelSource('chat', 'anthropic:claude-old', { source: 'tier_default', origin: 'built-in default' });
    expect(hint.gatewayModelNotFoundHint('chat', 'anthropic:claude-old')).toBe('Selected via the built-in default. Fix: gbrain config set models.tier.reasoning <provider>:<model>');
  });

  test('expansion: the utility tier and models.expansion are named for the expansion touchpoint', () => {
    setGatewayModelSource('expansion', 'openai:gpt-small', { source: 'tier_config', origin: 'models.tier.utility' });
    expect(hint.gatewayModelNotFoundHint('expansion', 'openai:gpt-small')).toBe('Selected via models.tier.utility. Fix: gbrain config set models.tier.utility <provider>:<model>');
    setGatewayModelSource('expansion', 'openai:gpt-small', { source: 'tier_default', origin: 'built-in default' });
    expect(hint.gatewayModelNotFoundHint('expansion', 'openai:gpt-small')).toBe('Selected via the built-in default. Fix: gbrain config set models.tier.utility <provider>:<model>');
    const err = normalizeAIError(openai404('gpt-small'), 'expand(openai:gpt-small)', undefined, hint.gatewayModelNotFoundHint('expansion', 'openai:gpt-small'));
    expect((err as AIConfigError).fix).toContain('models.tier.utility');
  });

  test('embed: embedding_model is named with its schema-sizing guard, never a bare config set', () => {
    const text = hint.embeddingModelNotFoundHint();
    expect(text).toContain('Selected via embedding_model.');
    expect(text).toContain('gbrain doctor');
    expect(text).not.toMatch(/Fix: gbrain config set embedding_model <provider>:<model>$/);
    const err = normalizeAIError(openai404('text-embedding-old'), 'embed(openai:text-embedding-old)', undefined, text);
    expect((err as AIConfigError).fix).toContain('embedding_model');
  });

  test('an unrecorded or stale route adds nothing, and the hint never reaches a non-404 fix', () => {
    expect(hint.gatewayModelNotFoundHint('chat', 'openai:never-recorded')).toBe('');
    setGatewayModelSource('chat', 'openai:gpt-x', { source: 'tier_config', origin: 'models.tier.reasoning' });
    expect(hint.gatewayModelNotFoundHint('chat', 'openai:gpt-other')).toBe('');
    const plain = normalizeAIError(openai404('gpt-x'), 'chat(openai:gpt-x)', undefined, '');
    expect((plain as AIConfigError).fix).toContain('`gbrain models`');
    expect((plain as AIConfigError).fix).not.toContain('Selected via');
    const auth = normalizeAIError(Object.assign(new Error('bad key'), { statusCode: 401 }), 'chat(openai:gpt-x)', undefined, hint.gatewayModelNotFoundHint('chat', 'openai:gpt-x'));
    expect((auth as AIConfigError).fix).toBe('Check your API key is valid and has access to this model.');
  });
});
