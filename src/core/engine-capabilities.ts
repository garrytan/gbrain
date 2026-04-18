import type { MBrainConfig } from './config.ts';

export interface EngineCapabilities {
  rawPostgresAccess: boolean;
  parallelWorkers: boolean;
  stagedImportConcurrency: boolean;
  localVectorPrefilter: 'none' | 'page-centroid';
}

export function getEngineCapabilities(config: Pick<MBrainConfig, 'engine'>): EngineCapabilities {
  switch (config.engine) {
    case 'postgres':
      return {
        rawPostgresAccess: true,
        parallelWorkers: true,
        stagedImportConcurrency: true,
        localVectorPrefilter: 'none',
      };
    case 'sqlite':
    case 'pglite':
      return {
        rawPostgresAccess: false,
        parallelWorkers: false,
        stagedImportConcurrency: true,
        localVectorPrefilter: 'page-centroid',
      };
  }
}
