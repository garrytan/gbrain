import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('src/main/index.ts'), 'utf8');

describe('desktop simple-model database sync', () => {
  test('writes both legacy chat_model and canonical models.default', () => {
    expect(source).toContain("['config', 'set', 'chat_model', chatModel]");
    expect(source).toContain("['config', 'set', 'models.default', chatModel]");
  });

  test('explicit setup clears stale advanced Dream routing but migration preserves it', () => {
    expect(source).toContain("['config', 'unset', '--pattern', 'models.tier.']");
    expect(source).toContain("['config', 'unset', '--pattern', 'models.dream.']");
    expect(source).toContain('syncModelDefaultsToDatabase({ resetAdvanced: true })');
    expect(source).toContain('await syncModelDefaultsToDatabase();');
  });
});
