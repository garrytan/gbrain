/**
 * F4: instruction 7's governing rule. The record whose terms are in effect on
 * the date asked about governs; a page's date says when it was written, not
 * when its terms take effect; a change not yet effective does not apply yet;
 * drafts, proposals and agent-written notes still do not override records.
 * It replaces "prefer the newest governing source: a later correction,
 * handoff or executed change outranks an older record", which
 * `mcp.instructions_governing_rule: newest` still serves for measurement.
 *
 * Offsets: capped harnesses read the first 2,048 characters. The old sentence
 * started at 2,094 on the full surface (1,943 on starter, ending past 2,048);
 * the rule now leads the answering clause, and its recorded offsets below are
 * the default rendering's (no writeback section, no hidden-tool sentence).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildMcpInstructions, GBRAIN_MCP_INSTRUCTIONS, GOVERNING_RULE_CONFIG_KEY, readInstructionContent } from '../src/mcp/instructions.ts';

const SURFACES = ['verbs', 'starter', 'full'] as const;
const RULE = 'The record whose terms are in effect on the date asked about governs';
const KEEP = 'drafts, proposals and agent-written notes do not override records';
const OLD = 'For what is true now, prefer the newest governing source';
const HARNESS_READ_LIMIT = 2_048;
/** [start, end) of the governing sentence per surface, default rendering. */
const RECORDED_OFFSETS: Record<string, [number, number] | null> = { verbs: null, starter: [1_553, 1_829], full: [1_705, 1_981] };

const render = (surface: typeof SURFACES[number], opts: Parameters<typeof buildMcpInstructions>[0] = {}) => {
  const listed = new Set(filterOpsForSurface(operations, surface).map(o => o.name));
  return { listed, text: buildMcpInstructions({ tools: { callable: n => listed.has(n) }, ...opts }) };
};
const sentence = (text: string): [number, number] | null => {
  const start = text.indexOf(RULE);
  return start < 0 ? null : [start, text.indexOf(`${KEEP}.`, start) + KEEP.length + 1];
};

describe('governing rule (F4)', () => {
  for (const surface of SURFACES) {
    test(`${surface}: recorded offset, inside the harness read limit on every names-row rendering`, () => {
      const { listed, text } = render(surface);
      expect(sentence(text)).toEqual(RECORDED_OFFSETS[surface]);
      for (const namesRow of [false, true]) {
        for (const records of [false, true]) {
          const at = sentence(render(surface, { references: { namesRow, records } }).text);
          if (!listed.has('search') && !listed.has('query')) { expect(at).toBeNull(); continue; }
          expect(at).not.toBeNull();
          expect(at![1]).toBeLessThanOrEqual(HARNESS_READ_LIMIT);
        }
      }
    });
  }

  test('the replacement keeps the drafts rule and drops the recency rule; page dates are named as page dates', () => {
    const line = GBRAIN_MCP_INSTRUCTIONS.split('\n').find(l => l.includes('Answering from the brain')) ?? '';
    expect(line).toContain(`${RULE}: a page's \`date\`/\`effective_date\` is when it was written, not when its terms take effect, and a change not yet effective does not apply yet; ${KEEP}.`);
    expect(line).not.toContain('outranks');
    expect(line).not.toContain(OLD);
    expect(line).toContain('keep going until the evidence is complete');
  });

  test('`date` is named only where `entity` (whose rows carry it) is callable', () => {
    const searchOnly = new Set(['search', 'get_page']);
    const text = buildMcpInstructions({ tools: { callable: n => searchOnly.has(n) } });
    expect(text).toContain("a page's `effective_date` is when it was written");
    expect(text).not.toContain('`date`/');
  });

  test('`newest` serves the earlier sentence at its earlier place, and nothing of the new rule', () => {
    for (const surface of ['starter', 'full'] as const) {
      const { text } = render(surface, { governingRule: 'newest' });
      expect(text).toContain(`${OLD}: a later correction, handoff or executed change outranks an older record, and ${KEEP}.`);
      expect(text).not.toContain(RULE);
      expect(text).toContain('a search returns the best-ranked excerpts, not every relevant page');
    }
  });

  test('the static contract is the `in_effect` rendering', () => {
    expect(buildMcpInstructions({ governingRule: 'in_effect' })).toBe(GBRAIN_MCP_INSTRUCTIONS);
  });

  test('a read error (or an engine with no config reader) fails closed to the defaults', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); } };
    expect((await readInstructionContent(broken)).governingRule).toBe('in_effect');
    const noReader = {} as { getConfig(key: string): Promise<string | null> };
    expect(await readInstructionContent(noReader)).toEqual({ references: { namesRow: true, records: false }, governingRule: 'in_effect' });
  });

  describe('on PGLite', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }, 120_000);
    afterAll(async () => { await engine?.disconnect(); });

    test('unset reads `in_effect`; `newest` switches back; any other value reads `in_effect`', async () => {
      expect((await readInstructionContent(engine)).governingRule).toBe('in_effect');
      await engine.setConfig(GOVERNING_RULE_CONFIG_KEY, 'newest');
      expect((await readInstructionContent(engine)).governingRule).toBe('newest');
      await engine.setConfig(GOVERNING_RULE_CONFIG_KEY, 'bogus');
      expect((await readInstructionContent(engine)).governingRule).toBe('in_effect');
    });
  });
});
