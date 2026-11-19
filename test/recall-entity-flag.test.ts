/**
 * #7166: `foresights recall --entity <x>` matches the recall op's `entity`
 * parameter (the bare positional's meaning). PGLite only, synthetic names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecall } from '../src/commands/recall.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';

let engine: PGLiteEngine;
const origWrite = process.stdout.write.bind(process.stdout);
let captured = '';

async function recallJson(args: string[]): Promise<{ facts: Array<{ fact: string }> }> {
  captured = '';
  process.stdout.write = ((chunk: string) => { captured += chunk; return true; }) as typeof process.stdout.write;
  try {
    await runRecall(engine, [...args, '--json', '--source', 'default']);
  } finally {
    process.stdout.write = origWrite;
  }
  return JSON.parse(captured);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: 'Founder.' } as never);
  await engine.insertFact({ fact: 'prefers morning meetings', kind: 'preference', entity_slug: 'people/alice-example', source: 'test' }, { source_id: 'default' });
  await engine.insertFact({ fact: 'unrelated fact', kind: 'fact', entity_slug: 'people/bob-example', source: 'test' }, { source_id: 'default' });
});

describe('recall --entity', () => {
  test('--entity <slug> recalls the same facts as the positional', async () => {
    const viaFlag = await recallJson(['--entity', 'people/alice-example']);
    const viaPositional = await recallJson(['people/alice-example']);
    expect(viaFlag.facts.map(f => f.fact)).toEqual(['prefers morning meetings']);
    expect(viaFlag.facts).toEqual(viaPositional.facts);
  });

  test('--entity=<name> works too', async () => {
    const res = await recallJson(['--entity=people/alice-example']);
    expect(res.facts.map(f => f.fact)).toEqual(['prefers morning meetings']);
  });

  test('a missing value is refused, not widened to every fact', async () => {
    await expect(recallJson(['--entity'])).rejects.toThrow(/--entity requires/);
  });

  test('a different positional and --entity are refused', async () => {
    await expect(recallJson(['--entity', 'people/alice-example', 'people/bob-example'])).rejects.toThrow(/name different entities/);
  });

  test('the generated flag registry knows --entity for recall', () => {
    expect(CLI_FLAG_REGISTRY.recall).toContain('--entity');
  });
});
