import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configCommand = readFileSync(resolve('src/commands/config.ts'), 'utf8');
const cycle = readFileSync(resolve('src/core/cycle.ts'), 'utf8');

describe('embedding model switch contract', () => {
  test('CLI validates before invalidation, rebuilds immediately, and only rolls back before commit', () => {
    const validateAt = configCommand.indexOf('detectEmbeddingDimensions(nextModel, provisionalDimensions)');
    const saveAt = configCommand.indexOf('saveConfig(candidate)');
    const invalidateAt = configCommand.indexOf('forceReembed: Boolean(previousModel)');
    const rebuildAt = configCommand.indexOf('runEmbedCore(engine, { stale: true, catchUp: true })');

    expect(validateAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(validateAt);
    expect(invalidateAt).toBeGreaterThan(saveAt);
    expect(rebuildAt).toBeGreaterThan(invalidateAt);
    expect(configCommand).toContain('if (!committed)');
    expect(configCommand).toContain('saveConfig(current)');
  });

  test('default Dream cycles retain the stale-embedding resume phase', () => {
    expect(cycle).toMatch(/export const ALL_PHASES[\s\S]*?'embed'/);
    expect(cycle).toContain('runEmbedCore(engine, { stale: true, dryRun })');
    expect(readFileSync(resolve('src/commands/embed.ts'), 'utf8')).toContain(
      'invalidateMismatchedEmbeddingModels(engine, getEmbeddingModel())',
    );
  });
});
