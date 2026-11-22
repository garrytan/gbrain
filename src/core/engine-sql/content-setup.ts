/**
 * The two statements of content-root setup that every `gbrain init` runs, the database-only one included
 * (shared-skills/setup.ts `isNewContentDatabase` and `setupSharedBrainContent`), as typed members, so `gbrain init --rust`
 * runs the same setup on the Rust store (rust/docs/store/content-setup.md): whether the database is new, and the active
 * source the setup is for. SQL once for both SQL engines.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The source content setup works on. */
export interface ContentSetupSource { id: string; incarnation: string; local_path: string | null }

/** No pages, config or persistence_brain table yet: a database `gbrain init` is creating (read before initSchema). */
export async function readFreshContentDatabase(exec: Raw): Promise<boolean> {
  const [row] = await exec.executeRaw<{ fresh: boolean }>("SELECT to_regclass('public.pages') IS NULL AND to_regclass('public.config') IS NULL AND to_regclass('public.persistence_brain') IS NULL AS fresh");
  return row?.fresh === true;
}

/** The source when it is registered and not archived, else null. */
export async function readContentSetupSource(exec: Raw, sourceId: string): Promise<ContentSetupSource | null> {
  const [row] = await exec.executeRaw<ContentSetupSource>('SELECT id,incarnation,local_path FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  return row ?? null;
}
