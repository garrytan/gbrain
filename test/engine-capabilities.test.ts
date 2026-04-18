import { describe, expect, test } from 'bun:test';
import { getEngineCapabilities } from '../src/core/engine-capabilities.ts';

describe('engine capabilities', () => {
  test('sqlite is local-first but lacks raw postgres access', () => {
    expect(getEngineCapabilities({ engine: 'sqlite' } as any)).toEqual({
      rawPostgresAccess: false,
      parallelWorkers: false,
      stagedImportConcurrency: true,
      localVectorPrefilter: 'page-centroid',
    });
  });

  test('pglite shares the local capability profile', () => {
    expect(getEngineCapabilities({ engine: 'pglite' } as any)).toEqual({
      rawPostgresAccess: false,
      parallelWorkers: false,
      stagedImportConcurrency: true,
      localVectorPrefilter: 'page-centroid',
    });
  });

  test('postgres keeps raw access and worker fanout', () => {
    expect(getEngineCapabilities({ engine: 'postgres' } as any)).toEqual({
      rawPostgresAccess: true,
      parallelWorkers: true,
      stagedImportConcurrency: true,
      localVectorPrefilter: 'none',
    });
  });
});
