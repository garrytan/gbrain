import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runProviders } from '../../src/commands/providers.ts';

describe('providers list', () => {
  let lines: string[];
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lines = [];
    logSpy = spyOn(console, 'log').mockImplementation((msg?: any) => {
      lines.push(String(msg ?? ''));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('chat-only openai-compatible providers surface expansion as via-chat', async () => {
    await runProviders('list', []);

    const output = lines.join('\n');
    expect(output).toContain('deepseek');
    expect(output).toContain('groq');
    expect(output).toContain('together');
    expect(output).toContain('via-chat');
  });
});
