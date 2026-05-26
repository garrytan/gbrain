import type { MBrainConfig } from './config.ts';

export interface EngineCapabilities {
  targetRuntime: boolean;
  legacyLocalRuntime: boolean;
  rawPostgresAccess: boolean;
  parallelWorkers: boolean;
  stagedImportConcurrency: boolean;
  localVectorPrefilter: 'none' | 'page-centroid';
}

export function getEngineCapabilities(config: Pick<MBrainConfig, 'engine'>): EngineCapabilities {
  switch (config.engine) {
    case 'postgres':
      return {
        targetRuntime: true,
        legacyLocalRuntime: false,
        rawPostgresAccess: true,
        parallelWorkers: true,
        stagedImportConcurrency: true,
        localVectorPrefilter: 'none',
      };
    case 'sqlite':
    case 'pglite':
      return {
        targetRuntime: false,
        legacyLocalRuntime: true,
        rawPostgresAccess: false,
        parallelWorkers: false,
        stagedImportConcurrency: true,
        localVectorPrefilter: 'page-centroid',
      };
  }
}
