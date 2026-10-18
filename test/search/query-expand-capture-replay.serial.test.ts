/**
 * Eval capture and replay of `query`'s expansion now that the default follows
 * the search mode (GBRA-81 item 1b): capture records the raw `expand` param
 * (null when the caller left it unset) next to `expansion_applied`, and
 * `eval replay` maps a null back to the mode default instead of forcing
 * expansion off. Serial: spies on module exports.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import * as hybrid from '../../src/core/search/hybrid.ts';
import { replayCore } from '../../src/commands/eval-replay.ts';
import type { EvalCandidateInput } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

let engine: PGLiteEngine;
const tmp = mkdtempSync(join(tmpdir(), 'query-expand-replay-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/capture-example', { type: 'note', title: 'Capture Example', compiled_truth: 'Osmiumfeather capture fixture.' });
  await installFixtureChunks(engine, 'notes/capture-example', [
    { chunk_index: 0, chunk_text: 'Osmiumfeather capture fixture.', chunk_source: 'compiled_truth' },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval capture records the raw expand param', () => {
  test('unset → null, explicit true/false recorded as passed, expansion_applied alongside', async () => {
    const captured: EvalCandidateInput[] = [];
    const spy = spyOn(engine, 'logEvalCandidate').mockImplementation(async (input: EvalCandidateInput) => { captured.push(input); return 1; });
    const ctx: OperationContext = {
      engine, remote: false, sourceId: 'default', config: { engine: 'pglite', eval: { capture: true } } as OperationContext['config'],
      logger: console, dryRun: false,
    };
    try {
      for (const expand of [undefined, true, false] as const) {
        await operationsByName.query.handler(ctx, { query: 'Osmiumfeather capture', ...(expand === undefined ? {} : { expand }) });
      }
      for (let i = 0; i < 50 && captured.length < 3; i++) await new Promise(r => setTimeout(r, 10));
    } finally {
      spy.mockRestore();
    }
    expect(captured.map(c => c.expand_enabled)).toEqual([null, true, false]);
    for (const c of captured) {
      expect(c.tool_name).toBe('query');
      expect(typeof c.expansion_applied).toBe('boolean');
    }
  });
});

describe('eval replay maps a null expand to the mode default', () => {
  test('null → undefined (mode decides), true/false passed through', async () => {
    const row = (id: number, expand: boolean | null) => JSON.stringify({
      schema_version: 1, id, tool_name: 'query', query: 'Osmiumfeather capture', retrieved_slugs: ['notes/capture-example'],
      expand_enabled: expand, latency_ms: 5,
    });
    const file = join(tmp, 'captured.ndjson');
    writeFileSync(file, [row(1, null), row(2, true), row(3, false)].join('\n') + '\n');
    const seen: Array<boolean | undefined> = [];
    const original = hybrid.hybridSearch;
    const spy = spyOn(hybrid, 'hybridSearch').mockImplementation(async (db, query, opts) => {
      seen.push(opts?.expansion);
      return original(db, query, opts);
    });
    try {
      const { results } = await replayCore(engine, { against: file });
      expect(results.every(r => !r.errored)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([undefined, true, false]);
  });
});
