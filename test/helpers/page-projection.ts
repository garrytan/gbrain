import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';

/** Install an explicitly authored synthetic fixture as a complete, revision-bound projection. */
export async function installFixtureChunks(engine: BrainEngine, slug: string, chunks: ChunkInput[], opts?: { sourceId?: string }) {
  const snapshot = await readProjectionSnapshot(engine, slug, opts?.sourceId ?? 'default', { allowUnsealed: true });
  if (!snapshot) throw new Error(`Missing fixture page: ${slug}`);
  await installPageProjection(engine, snapshot, chunks, { seal: true });
}
