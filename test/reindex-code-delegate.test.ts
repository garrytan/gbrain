import { describe, expect, test } from 'bun:test';
import { parseReindexCodeDelegateArgs } from '../src/commands/reindex-code-delegate.ts';

describe('resident code reindex arguments', () => {
  test('keyless source-scoped recovery stays explicit', () => {
    expect(parseReindexCodeDelegateArgs(['--source', 'code-example', '--force', '--no-embed', '--json'])).toEqual({
      sourceId: 'code-example', force: true, noEmbed: true, json: true,
    });
  });

  test('unknown argument values never appear in errors', () => {
    try {
      parseReindexCodeDelegateArgs(['--token=synthetic-credential-value']);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_params' });
      expect((error as Error).message).not.toContain('synthetic-credential-value');
    }
  });

  for (const args of [['--workers', '0'], ['--workers', '65'], ['--max-cost', '0'], ['--source']]) {
    test(`invalid recovery options are refused: ${args.join(' ')}`, () => {
      expect(() => parseReindexCodeDelegateArgs(args)).toThrow();
    });
  }
});
