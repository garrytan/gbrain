/**
 * Protects relink model batches against strict structured-output rejection.
 * Removing either object constraint must fail; existing relink transports do
 * not validate schemas. Uses the existing gateway seam, with no new API.
 */
import { afterEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { judgeBatch } from '../src/core/facts/relink-model.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

function acceptStrictSchema(schema: Record<string, unknown>): void {
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema.required).toEqual(Object.keys(properties));
    for (const property of Object.values(properties)) acceptStrictSchema(property);
  }
  if (schema.type === 'array') acceptStrictSchema(schema.items as Record<string, unknown>);
}

test('relink model batch is accepted by a strict structured-output backend', async () => {
  let calls = 0;
  __setChatTransportForTests(async opts => {
    calls++;
    expect(opts.responseSchema?.name).toBe('fact_subjects');
    acceptStrictSchema(opts.responseSchema!.schema);
    return {
      text: '{"subjects":[{"i":0,"subject":null}]}',
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:strict-test', providerId: 'openai',
    };
  });

  // A subjectless verdict never queries the engine.
  const verdicts = await judgeBatch({} as BrainEngine, 'default', 'openai:strict-test', [
    { id: 7, fact: 'Slept seven hours.' },
  ]);
  expect(calls).toBe(1);
  expect(verdicts).toEqual([{ id: 7, slug: null, reason: 'no_subject' }]);
});
