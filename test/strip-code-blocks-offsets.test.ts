import { describe, test, expect } from 'bun:test';
import { stripCodeBlocks } from '../src/core/link-extraction.ts';

describe('stripCodeBlocks offset preservation', () => {
  test('fenced terminated: output length equals input length', () => {
    const input = 'before\n```js\nconst x = 1;\n```\nafter';
    const output = stripCodeBlocks(input);
    expect(output.length).toBe(input.length);
    expect(output.slice(0, 6)).toBe('before');
    expect(output.slice(-5)).toBe('after');
  });

  test('fenced unterminated: output length equals input length', () => {
    const input = 'before\n```js\nconst x = 1;\nno closing fence here';
    const output = stripCodeBlocks(input);
    expect(output.length).toBe(input.length);
    expect(output.slice(0, 6)).toBe('before');
  });

  test('inline terminated: output length equals input length', () => {
    const input = 'before `code` after';
    const output = stripCodeBlocks(input);
    expect(output.length).toBe(input.length);
    expect(output.slice(0, 6)).toBe('before');
    expect(output.slice(-5)).toBe('after');
  });

  test('inline unterminated: output length equals input length', () => {
    // No closing backtick — current code emits the backtick char and advances.
    const input = 'before `unterminated after';
    const output = stripCodeBlocks(input);
    expect(output.length).toBe(input.length);
    expect(output.slice(0, 6)).toBe('before');
  });

  test('mixed: alternating fenced and inline code', () => {
    const input = '# Title\n\nSome `inline` text.\n\n```\nfenced\n```\n\nMore `inline` text.\n';
    const output = stripCodeBlocks(input);
    expect(output.length).toBe(input.length);
    expect(output.slice(0, 8)).toBe('# Title\n');
  });
});
