/**
 * Batching guidance (Cat 40 Hard round 4): the answering clause keeps separate
 * parts of a question in separate searches but tells agents to resolve a list
 * of names or codes in one call and to issue independent calls together, and
 * `search` says keyword mode takes OR across quoted names.
 *
 * Protects: readers resolved 13-45 names one search per turn and ran out of
 * turns; the old clause said "Run separate searches for separate parts of a
 * question" and nothing mentioned keyword OR or `entity` names.
 */
import { describe, expect, test } from 'bun:test';
import { buildMcpInstructions, GBRAIN_MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { SEARCH_DESCRIPTION } from '../src/core/operations-descriptions.ts';

const answering = (text: string) => text.split('\n').find(l => l.includes('Answering from the brain')) ?? '';
const only = (...names: string[]) => ({ tools: { callable: (op: string) => names.includes(op) } });

describe('batching guidance', () => {
  test('the default contract batches lists through entity names or one keyword OR search and keeps going', () => {
    const clause = answering(GBRAIN_MCP_INSTRUCTIONS);
    expect(clause).toContain('keep going until the evidence is complete');
    expect(clause).toContain('Keep separate parts of a question in separate searches, but batch lists');
    expect(clause).toContain('(`entity` with `names` or one keyword `search` for "A" OR "B" OR …)');
    expect(clause).toContain('issue independent calls together in one turn, not one per turn');
    expect(clause).not.toContain('Run separate searches');
  });

  test('only callable tools are named', () => {
    expect(answering(buildMcpInstructions(only('search')))).toContain('in one call (one keyword `search` for "A" OR "B" OR …)');
    expect(answering(buildMcpInstructions(only('search')))).not.toContain('`entity` with `names`');
    expect(answering(buildMcpInstructions(only('query', 'entity')))).toContain('in one call (`entity` with `names`)');
    const neither = answering(buildMcpInstructions(only('query')));
    expect(neither).toContain('resolve many names or codes in one call, and issue independent calls together');
  });

  test('search says keyword mode takes OR across quoted names and points to entity names', () => {
    expect(SEARCH_DESCRIPTION).toContain('match: "keyword" pages every keyword match and takes OR across quoted names or codes ("A" OR "B" OR …)');
    expect(SEARCH_DESCRIPTION).toContain('one call lists every page matching any');
    expect(SEARCH_DESCRIPTION).toContain("Name lists: entity names.");
  });
});
