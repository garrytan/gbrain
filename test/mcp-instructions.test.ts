import { describe, test, expect } from 'bun:test';
import { operations, MCP_INSTRUCTIONS } from '../src/core/operations.ts';

describe('MCP instructions', () => {
  test('MCP_INSTRUCTIONS is a non-empty string', () => {
    expect(typeof MCP_INSTRUCTIONS).toBe('string');
    expect(MCP_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  test('includes domain-specific trigger context', () => {
    expect(MCP_INSTRUCTIONS).toContain('people, companies, technical concepts');
  });

  test('includes negative list', () => {
    expect(MCP_INSTRUCTIONS).toContain('Do not use for');
    expect(MCP_INSTRUCTIONS).toContain('library documentation');
  });

  test('does not contain write-back directives', () => {
    expect(MCP_INSTRUCTIONS).not.toContain('write back');
    expect(MCP_INSTRUCTIONS).not.toContain('Also write');
  });

  test('stays within character budget (under 600 chars)', () => {
    // The instructions design targets under 500 chars to force focus; 600
    // leaves a small margin before triggering a review. Bloat here dilutes the signal.
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(600);
  });
});

describe('core tool descriptions include trigger context', () => {
  test('search description frames keyword lookup as candidate discovery', () => {
    const search = operations.find(op => op.name === 'search');
    expect(search).toBeDefined();
    expect(search!.description).toContain('Keyword candidate discovery');
    expect(search!.description).toContain('exact names');
    expect(search!.description).toContain('chunks are not answer evidence');
    expect(search!.description).toContain('call retrieve_context or read_context');
    expect(search!.description).not.toContain('Returns matching pages with relevance scores');
  });

  test('query description frames semantic lookup as candidate discovery', () => {
    const query = operations.find(op => op.name === 'query');
    expect(query).toBeDefined();
    expect(query!.description).toContain('Semantic candidate discovery');
    expect(query!.description).toContain('conceptual');
    expect(query!.description).toContain('chunks are not answer evidence');
    expect(query!.description).toContain('call retrieve_context or read_context');
    expect(query!.description).not.toContain('best recall');
  });

  test('retrieve_context description makes it the preferred agent probe', () => {
    const retrieveContext = operations.find(op => op.name === 'retrieve_context');
    expect(retrieveContext).toBeDefined();
    expect(retrieveContext!.description).toContain('required canonical reads');
    expect(retrieveContext!.description).toContain('read_context');
  });

  test('read_context description marks it as the evidence boundary', () => {
    const readContext = operations.find(op => op.name === 'read_context');
    expect(readContext).toBeDefined();
    expect(readContext!.description).toContain('bounded canonical evidence');
    expect(readContext!.description).toContain('before answering factual questions');
  });

  test('get_page description references compiled truth + timeline', () => {
    const getPage = operations.find(op => op.name === 'get_page');
    expect(getPage).toBeDefined();
    expect(getPage!.description).toContain('compiled truth');
    expect(getPage!.description).toContain('timeline');
  });

  test('put_page description explains when to use it', () => {
    const putPage = operations.find(op => op.name === 'put_page');
    expect(putPage).toBeDefined();
    expect(putPage!.description).toContain('record new information');
    expect(putPage!.description).toContain('compiled truth + timeline');
  });

  test('add_link description surfaces both people/deal and technical link types', () => {
    const addLink = operations.find(op => op.name === 'add_link');
    expect(addLink).toBeDefined();
    // Technical knowledge-map link types must be discoverable at the MCP
    // decision point, not only in skills.
    expect(addLink!.description).toContain('implements');
    expect(addLink!.description).toContain('depends_on');
    // People/deal examples are still first-class.
    expect(addLink!.description).toMatch(/invested_in|works_at/);
    // link_type param description also lists both families.
    expect(addLink!.params.link_type.description).toContain('implements');
    expect(addLink!.params.link_type.description).toContain('layer_of');
  });

  test('sync_brain accepts no_embed because agent rules pass it after writes', () => {
    const syncBrain = operations.find(op => op.name === 'sync_brain');
    expect(syncBrain).toBeDefined();
    expect(syncBrain!.params.no_embed).toBeDefined();
    expect(syncBrain!.params.no_embed.type).toBe('boolean');
  });
});
