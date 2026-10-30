/**
 * #7389: strict structured-output backends (OpenAI strict mode and proxies of
 * it) reject a response schema whose object nodes allow extra properties or
 * leave a property optional, so every relink model batch came back
 * `model_unavailable`. The schema is captured through the chat transport seam.
 */
import { afterEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { judgeBatch } from '../src/core/facts/relink-model.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

function strictViolations(schema: Record<string, unknown>, path = '$'): string[] {
  const out: string[] = [];
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties is not false`);
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required ?? []) as string[]);
    for (const [key, property] of Object.entries(properties)) {
      if (!required.has(key)) out.push(`${path}.${key}: not required`);
      out.push(...strictViolations(property, `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && schema.items) out.push(...strictViolations(schema.items as Record<string, unknown>, `${path}[]`));
  return out;
}

test('relink model response schema is strict-mode compatible on every object node', async () => {
  let captured: Record<string, unknown> | undefined;
  __setChatTransportForTests(async opts => {
    expect(opts.responseSchema?.name).toBe('fact_subjects');
    captured = opts.responseSchema!.schema;
    return {
      text: '{"subjects":[{"i":0,"subject":null}]}',
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:strict-test', providerId: 'openai',
    };
  });

  // A subjectless verdict never reaches the engine.
  const verdicts = await judgeBatch({} as BrainEngine, 'default', 'openai:strict-test', [
    { id: 7, fact: 'Slept seven hours.' },
  ]);
  expect(verdicts).toEqual([{ id: 7, slug: null, reason: 'no_subject' }]);
  expect(captured).toBeDefined();
  expect(strictViolations(captured!)).toEqual([]);
});
