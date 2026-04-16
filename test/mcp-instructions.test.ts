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
    // RFC §6.2 targets under 500 chars to force focus; 600 leaves a small
    // margin before triggering a review. Bloat here dilutes the signal.
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(600);
  });
});

describe('core tool descriptions include trigger context', () => {
  test('search description mentions when to use it', () => {
    const search = operations.find(op => op.name === 'search');
    expect(search).toBeDefined();
    expect(search!.description).toContain('BEFORE Grep or WebSearch');
    expect(search!.description).toContain('named entity');
  });

  test('query description explains semantic use case', () => {
    const query = operations.find(op => op.name === 'query');
    expect(query).toBeDefined();
    expect(query!.description).toContain('Semantic search');
    expect(query!.description).toContain('conceptual');
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
});
