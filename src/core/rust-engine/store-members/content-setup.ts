/**
 * Content-root setup on the Rust store (engine-sql/content-setup.ts; rust/docs/store/content-setup.md). The store
 * creates its brain when it opens one, so a database is fresh exactly when this open created it (`info().created`).
 */
import type { ContentSetupSource } from '../../engine-sql/content-setup.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readFreshContentDatabase: StoreMember<[], boolean> = async (brain) => {
  const info = await storeCall({ member: 'readFreshContentDatabase' }, () => brain.info()) as { created?: unknown };
  return info.created === true;
};

export const readContentSetupSource: StoreMember<[sourceId: string], ContentSetupSource | null> = (brain, sourceId) =>
  storeCall({ member: 'readContentSetupSource', sourceId }, () => brain.readContentSetupSource(sourceId)) as Promise<ContentSetupSource | null>;
