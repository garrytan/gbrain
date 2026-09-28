import { describe, expect, test } from 'bun:test';
import { knobsHash, resolveSearchMode } from '../../src/core/search/mode.ts';
import { queryInstructionForModel } from '../../src/core/ai/query-instruct.ts';
import { mergedProviderEnv } from '../../src/core/ai/provider-env.ts';
import { isQwen3EmbeddingModel } from '../../src/core/ai/dims.ts';

const knobs = resolveSearchMode({ mode: 'conservative' });
const hash = (queryInstruction?: string) => knobsHash(knobs, { queryInstruction });

describe('query instruction cache identity', () => {
  test('default, custom and disabled instructions cannot reuse one another’s rows', () => {
    const normal = queryInstructionForModel('qwen3-embedding:4b', {});
    const custom = queryInstructionForModel('qwen3-embedding:4b', { GBRAIN_QUERY_INSTRUCT: 'Retrieve documents' });
    const disabled = queryInstructionForModel('qwen3-embedding:4b', { GBRAIN_QUERY_INSTRUCT: '' });
    expect(new Set([hash(normal), hash(custom), hash(disabled)]).size).toBe(3);
    expect(hash(normal)).toBe(hash(normal));
  });
  test('disabled instruction is distinct from the literal task none', () => {
    expect(hash(undefined)).not.toBe(hash('none'));
  });
  test('non-Qwen models ignore the instruction setting', () => {
    expect(queryInstructionForModel('bge-m3', { GBRAIN_QUERY_INSTRUCT: 'custom' })).toBeUndefined();
    expect(queryInstructionForModel('text-embedding-v4', {})).toBeUndefined();
    expect(isQwen3EmbeddingModel('qwen3-embed-custom')).toBe(false);
  });
  test('environment folding preserves instruction opt-out but not empty credentials', () => {
    const env = mergedProviderEnv({ engine: 'pglite', openai_api_key: 'fixture-key' }, {
      GBRAIN_QUERY_INSTRUCT: '', OPENAI_API_KEY: '',
    });
    expect(env.GBRAIN_QUERY_INSTRUCT).toBe('');
    expect(env.OPENAI_API_KEY).toBe('fixture-key');
    expect(queryInstructionForModel('qwen3-embedding:4b', env)).toBeUndefined();
  });
});
