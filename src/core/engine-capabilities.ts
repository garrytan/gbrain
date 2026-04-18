import type { MBrainConfig } from './config.ts';

export interface EngineCapabilities {
  rawPostgresAccess: boolean;
  parallelWorkers: boolean;
  localVectorPrefilter: 'none' | 'page-centroid';
}

export function getEngineCapabilities(config: Pick<MBrainConfig, 'engine'>): EngineCapabilities {
  switch (config.engine) {
    case 'postgres':
      return {
        rawPostgresAccess: true,
        parallelWorkers: true,
        localVectorPrefilter: 'none',
      };
    case 'sqlite':
    case 'pglite':
      return {
        rawPostgresAccess: false,
        parallelWorkers: false,
        localVectorPrefilter: 'page-centroid',
      };
  }
}
