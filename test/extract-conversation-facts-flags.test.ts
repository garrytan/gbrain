/**
 * #5934 (absorbed in agent contract v1 D4): extract-conversation-facts
 * rejects malformed --limit / --segment-limit / --sleep values with an
 * invalid_params usage error (exit 2 via renderCliError) before any work.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractConversationFacts } from '../src/commands/extract-conversation-facts.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('extract-conversation-facts numeric flags', () => {
  test.each([
    ['--limit', 'foo', 'a positive integer'],
    ['--limit', '0', 'a positive integer'],
    ['--limit', '-1', 'a positive integer'],
    ['--limit', '1.5', 'a positive integer'],
    ['--limit', '1junk', 'a positive integer'],
    ['--limit', '9007199254740992', 'a positive integer'],
    ['--segment-limit', 'foo', 'a non-negative integer'],
    ['--segment-limit', '-1', 'a non-negative integer'],
    ['--segment-limit', '1.5', 'a non-negative integer'],
    ['--segment-limit', '1junk', 'a non-negative integer'],
    ['--segment-limit', '9007199254740992', 'a non-negative integer'],
    ['--sleep', 'foo', 'a non-negative integer'],
    ['--sleep', '-1', 'a non-negative integer'],
    ['--sleep', '1.5', 'a non-negative integer'],
    ['--sleep', '1junk', 'a non-negative integer'],
    ['--sleep', '9007199254740992', 'a non-negative integer'],
  ])('%s %s is rejected before dry-run work', async (flag, value, expected) => {
    await expect(runExtractConversationFacts(engine, ['--dry-run', '--source-id', 'default', flag, value]))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(`${flag} must be ${expected}`) });
  });

  test.each(['--limit', '--segment-limit', '--sleep'])('%s without a value is rejected', async (flag) => {
    await expect(runExtractConversationFacts(engine, ['--dry-run', '--source-id', 'default', flag]))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(`${flag} requires a value`) });
  });

  test('zero remains valid only for segment-limit and sleep', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--dry-run', '--source-id', 'default', '--segment-limit', '0', '--sleep', '0']);
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toContain('Done: (dry run)');
    } finally {
      log.mockRestore();
    }
  });
});
