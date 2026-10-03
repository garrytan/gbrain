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
    ['--limit', 'foo', 'positive safe integer'],
    ['--limit', '0', 'positive safe integer'],
    ['--limit', '-1', 'positive safe integer'],
    ['--limit', '1.5', 'positive safe integer'],
    ['--limit', '1junk', 'positive safe integer'],
    ['--limit', '9007199254740992', 'positive safe integer'],
    ['--segment-limit', 'foo', 'non-negative safe integer'],
    ['--segment-limit', '-1', 'non-negative safe integer'],
    ['--segment-limit', '1.5', 'non-negative safe integer'],
    ['--segment-limit', '1junk', 'non-negative safe integer'],
    ['--segment-limit', '9007199254740992', 'non-negative safe integer'],
    ['--sleep', 'foo', 'non-negative safe integer'],
    ['--sleep', '-1', 'non-negative safe integer'],
    ['--sleep', '1.5', 'non-negative safe integer'],
    ['--sleep', '1junk', 'non-negative safe integer'],
    ['--sleep', '9007199254740992', 'non-negative safe integer'],
  ])('%s %s is rejected before dry-run work', async (flag, value, expected) => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
    try {
      await expect(runExtractConversationFacts(engine, ['--dry-run', '--source-id', 'default', flag, value])).rejects.toThrow('exit:1');
      expect(error.mock.calls[0]?.[0]).toContain(`${flag} requires a ${expected}`);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  test.each(['--limit', '--segment-limit', '--sleep'])('%s without a value is rejected', async (flag) => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
    try {
      await expect(runExtractConversationFacts(engine, ['--dry-run', '--source-id', 'default', flag])).rejects.toThrow('exit:1');
      expect(error.mock.calls[0]?.[0]).toContain(`${flag} requires a`);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
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
