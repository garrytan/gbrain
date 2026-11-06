/**
 * GST-1493 (HARN-1 QM M1 eval): a schema-less client (QM lists each MCP tool as one line, its description cut to 117
 * characters, and shows parameters only through tool_search) called remember 67 times; 44 were refused invalid_params.
 * Every refused session ran the same three calls: facts: [{text, entity}] (22), then {fact, entity} with no
 * provenance (22), then {fact, entity, provenance}, which saved. These replay those argument shapes with placeholders.
 * provenance stays required: only the refusal text and the description change.
 */
import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const engine = {
  kind: 'pglite',
  getConfig: async () => null,
  executeRaw: async () => [],
} as unknown as BrainEngine;
const OPTS = { remote: true, transport: 'http' as const, sourceId: 'default' };
const FACT = 'Alice Example uses Dock 12 for Acme Example pickups (from 2026-01-05 onward).';

async function call(args: Record<string, unknown>) {
  const out = await dispatchToolCall(engine, 'remember', args, OPTS);
  return { isError: out.isError === true, envelope: JSON.parse(out.content[0]!.text) };
}

/** The first JSON object quoted in a suggestion: the corrected example. */
function quotedExample(suggestion: string): Record<string, unknown> {
  const start = suggestion.indexOf('{');
  let depth = 0;
  for (let i = start; i < suggestion.length; i++) {
    if (suggestion[i] === '{') depth++;
    if (suggestion[i] === '}' && --depth === 0) return JSON.parse(suggestion.slice(start, i + 1));
  }
  throw new Error('no JSON example in: ' + suggestion);
}

describe('remember refusals name the rule and a corrected example (GST-1493)', () => {
  for (const [label, args] of [
    ['facts[] with a top-level entity (18 of 44)', { facts: [{ text: FACT }], entity: 'Alice Example' }],
    ['facts[] with entity inside the item (4 of 44)', { facts: [{ text: FACT, entity: 'Alice Example' }] }],
  ] as const) {
    test(label + ': points at items, says provenance is required, and quotes a call that validates', async () => {
      const { isError, envelope } = await call(args);
      expect(isError).toBe(true);
      expect(envelope.error).toBe('invalid_params');
      expect(envelope.suggestion).toContain('Unknown parameter "facts"');
      expect(envelope.suggestion).toContain('did you mean "items"');
      expect(envelope.suggestion).not.toContain('did you mean "fact"');
      expect(envelope.suggestion).toMatch(/provenance[^.]*required/);
      const example = quotedExample(envelope.suggestion);
      expect(Object.keys(example).sort()).toEqual(['entity', 'fact', 'provenance']);
      for (const value of Object.values(example)) expect(String(value)).toMatch(/^<[^<>]+>$/);
      const retried = await call({ ...example, dry_run: true });
      expect(retried.isError).toBe(false);
      expect(retried.envelope.dry_run).toBe(true);
    });
  }

  test('{fact, entity} with no provenance (22 of 44) is still refused and names provenance', async () => {
    const { isError, envelope } = await call({ fact: FACT, entity: 'Alice Example' });
    expect(isError).toBe(true);
    expect(envelope.error).toBe('invalid_params');
    expect(envelope.message).toBe('Missing required parameter: provenance');
    expect(envelope.suggestion).toContain('provenance: "<where you learned it, with the date>"');
  });

  test('an empty provenance is refused and quotes the placeholder, not a source to copy', async () => {
    const { isError, envelope } = await call({ fact: FACT, entity: 'Alice Example', provenance: ' ' });
    expect(isError).toBe(true);
    expect(envelope.error).toBe('provenance_required');
    expect(envelope.suggestion).toContain('provenance: "<where you learned it, with the date>"');
  });

  test('the saved shape {fact, entity, provenance} validates', async () => {
    const { isError } = await call({ fact: FACT, entity: 'Alice Example', provenance: 'Alice Example told the assistant in a DM, 2026-01-05', dry_run: true });
    expect(isError).toBe(false);
  });

  test('text for fact gets "did you mean fact" and the example', async () => {
    const { isError, envelope } = await call({ text: FACT, entity: 'Alice Example', provenance: 'chat 2026-01-05' });
    expect(isError).toBe(true);
    expect(envelope.suggestion).toContain('did you mean "fact"');
    expect(Object.keys(quotedExample(envelope.suggestion)).sort()).toEqual(['entity', 'fact', 'provenance']);
  });

  test('items[] whose entries use text for fact names fact', async () => {
    const { isError, envelope } = await call({ items: [{ text: FACT, entity: 'Alice Example', provenance: 'chat 2026-01-05' }] });
    expect(isError).toBe(true);
    expect(envelope.error).toBe('invalid_params');
    expect(envelope.suggestion).toContain('fact');
    expect(envelope.suggestion).toMatch(/text[^.]*fact/);
  });

  test('items[] without provenance is still refused', async () => {
    const { isError, envelope } = await call({ items: [{ fact: FACT, entity: 'Alice Example' }] });
    expect(isError).toBe(true);
    expect(envelope.error).toBe('invalid_params');
    expect(envelope.message).toContain('provenance');
  });

  test('a missing fact quotes an example that includes provenance', async () => {
    const { isError, envelope } = await call({ fact: '', entity: 'Alice Example', provenance: 'chat 2026-01-05' });
    expect(isError).toBe(true);
    expect(Object.keys(quotedExample(envelope.suggestion)).sort()).toEqual(['entity', 'fact', 'provenance']);
  });

  test('the description\'s first 117 characters name the call: fact, provenance (required), entity, items', () => {
    // QM lists each MCP tool as its first 117 characters plus "..."; "Save facts" read as a parameter named facts.
    const head = operations.find(o => o.name === 'remember')!.description.slice(0, 117);
    for (const word of ['fact', 'provenance', 'required', 'entity', 'items']) expect(head).toContain(word);
    expect(head).not.toMatch(/\bfacts\b/);
  });
});
