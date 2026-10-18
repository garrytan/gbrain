/**
 * d5b: the served brief clause names only the reference fields the agent
 * receives. A compact `entity names` row carries no `referenced_by`, so the
 * clause puts the walk on the single-name card and says what a `names` row
 * holds on this brain: a row-level `next` to the card when
 * `entity.names_references` is on (default), `records` by type when
 * `entity.record_types` enrolls types (default none). Every transport reads
 * both keys through readInstructionContent; the static contract
 * (GBRAIN_MCP_INSTRUCTIONS, bootstrap's instructions file, the SDK
 * constructor fallback) is the defaults rendering.
 *
 * Protects: instruction 7 advised "call `entity`, then walk `referenced_by`"
 * while agents batched names with `entity` `names`, whose rows carried no
 * references.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildMcpInstructions, GBRAIN_MCP_INSTRUCTIONS, readInstructionContent } from '../src/mcp/instructions.ts';
import {
  ENTITY_NAMES_REFERENCES_KEY, ENTITY_RECORD_TYPES_KEY, parseNamesReferences, parseRecordTypes, readEntityReferencesConfig,
} from '../src/core/entity-references-config.ts';

const SURFACES = ['verbs', 'starter', 'full'] as const;
const CARD = "walk the `entity` card's `referenced_by`";
const NEXT = "`next` opens the card";
const RECORDS = 'lists `records` by type';
const briefLine = (text: string) => text.split('\n').find(l => l.includes('For a brief on an account')) ?? '';
const render = (surface: typeof SURFACES[number], references?: { namesRow: boolean; records: boolean }) => {
  const listed = new Set(filterOpsForSurface(operations, surface).map(o => o.name));
  return { listed, text: buildMcpInstructions({ tools: { callable: n => listed.has(n) }, ...(references ? { references } : {}) }) };
};

describe('brief clause follows the names-row reference fields', () => {
  for (const surface of SURFACES) {
    for (const namesRow of [false, true]) {
      for (const records of [false, true]) {
        test(`${surface}: names-row ${namesRow ? 'on' : 'off'}, records ${records ? 'enrolled' : 'off'}`, () => {
          const { listed, text } = render(surface, { namesRow, records });
          const line = briefLine(text);
          if (!listed.has('entity')) {
            expect(text).not.toContain('`names` row');
            return;
          }
          expect(line).toContain(CARD);
          expect(line).not.toContain('call `entity`, then walk');
          expect(line.includes(NEXT)).toBe(namesRow);
          expect(line.includes(RECORDS)).toBe(records);
          expect(line.includes('`names` row')).toBe(namesRow || records);
        });
      }
    }
  }

  test('the standalone brief clause (no search or query) carries the same fields', () => {
    const only = new Set(['entity', 'recall', 'remember']);
    const text = buildMcpInstructions({ tools: { callable: n => only.has(n) }, references: { namesRow: true, records: true } });
    expect(text).not.toContain('Answering from the brain');
    expect(text).toContain("5. For a brief on an account, person or company, walk the `entity` card's `referenced_by` by type; a `names` row lists `records` by type, and its `next` opens the card.");
  });

  test('the static contract is the defaults rendering (names-row on, no records)', () => {
    expect(buildMcpInstructions({ references: { namesRow: true, records: false } })).toBe(GBRAIN_MCP_INSTRUCTIONS);
    expect(briefLine(GBRAIN_MCP_INSTRUCTIONS)).toContain("by type; a `names` row's `next` opens the card.");
    expect(GBRAIN_MCP_INSTRUCTIONS).not.toContain('`records`');
  });
});

describe('entity references config reader', () => {
  test('parsing: names-row off only for an explicit falsy value; record types trimmed and deduplicated in order', () => {
    expect([undefined, null, '', 'true', 'on', 'garbage'].map(v => parseNamesReferences(v))).toEqual([true, true, true, true, true, true]);
    expect(['false', 'OFF', ' 0 ', 'no'].map(v => parseNamesReferences(v))).toEqual([false, false, false, false]);
    expect(parseRecordTypes(' contract, amendment ,,contract,Order ')).toEqual(['contract', 'amendment', 'Order']);
    expect(parseRecordTypes(null)).toEqual([]);
  });

  test('a read error fails closed to the defaults', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); } };
    expect(await readEntityReferencesConfig(broken)).toEqual({ namesRow: true, recordTypes: [] });
    expect((await readInstructionContent(broken)).references).toEqual({ namesRow: true, records: false });
  });

  describe('on PGLite', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }, 120_000);
    afterAll(async () => { await engine?.disconnect(); });

    test('unset keys read as the defaults; set keys drive the instruction content', async () => {
      expect((await readInstructionContent(engine)).references).toEqual({ namesRow: true, records: false });
      await engine.setConfig(ENTITY_NAMES_REFERENCES_KEY, 'false');
      await engine.setConfig(ENTITY_RECORD_TYPES_KEY, 'contract, amendment');
      expect(await readEntityReferencesConfig(engine)).toEqual({ namesRow: false, recordTypes: ['contract', 'amendment'] });
      const content = await readInstructionContent(engine);
      expect(content.references).toEqual({ namesRow: false, records: true });
      const line = briefLine(buildMcpInstructions(content));
      expect(line).toContain('a `names` row lists `records` by type.');
      expect(line).not.toContain(NEXT);
    });
  });
});
