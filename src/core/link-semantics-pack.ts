/**
 * Temporal typed edges: pack-declared relation semantics.
 *
 * A schema pack declares `link_types[].temporal: state | event`; the built-in
 * table in link-validity.ts is the default. Semantics are brain-wide, keyed by
 * relation name: the union of the brain's active pack and every per-source
 * pack (`schema_pack.source.<id>`). When two packs disagree, `state` wins, so
 * a relation that can end is never treated as permanent. `mentions` is never
 * temporal.
 *
 * Write entry points (derived-link replacement, add_link / remove_link, the
 * extract sweep, the contradiction phase) call `primeRelationSemantics` before
 * they derive or refresh relationship state, so every writer in the process
 * agrees with the pack. Reads use the semantics stored on each relationship.
 */

import type { BrainEngine } from './engine.ts';
import { setPackRelationSemantics } from './link-validity.ts';
import type { SchemaPackManifest } from './schema-pack/manifest-v1.ts';

const SOURCE_PACK_PREFIX = 'schema_pack.source.';

/** Pure: merge pack declarations; `state` wins a disagreement; `mentions` is ignored. */
export function packRelationSemantics(manifests: ReadonlyArray<Pick<SchemaPackManifest, 'link_types'> | null | undefined>): Map<string, 'state' | 'event'> {
  const out = new Map<string, 'state' | 'event'>();
  for (const m of manifests) {
    for (const lt of m?.link_types ?? []) {
      if (!lt.temporal || lt.name === 'mentions') continue;
      if (out.get(lt.name) !== 'state') out.set(lt.name, lt.temporal);
    }
  }
  return out;
}

/**
 * Load the active packs for `engine` and install their semantics. Fail-soft:
 * an unreadable pack keeps the previous semantics (the built-in table on a
 * fresh process).
 */
export async function primeRelationSemantics(engine: Partial<Pick<BrainEngine, 'getConfig' | 'listConfigKeys'>>): Promise<void> {
  if (!engine.getConfig || !engine.listConfigKeys) return;
  const configured = engine as Pick<BrainEngine, 'getConfig' | 'listConfigKeys'>;
  try {
    // The key read is issued at once (not after the module load), so a caller pipelining this keeps its statement order.
    const [{ loadActivePackForLocalEngine }, sourceKeys] = await Promise.all([import('./schema-pack/best-effort.ts'),
      configured.listConfigKeys(SOURCE_PACK_PREFIX).catch(() => [] as string[])]);
    const sourceIds = [...new Set(sourceKeys.map(k => k.slice(SOURCE_PACK_PREFIX.length)).filter(Boolean))];
    const packs = await Promise.all([
      loadActivePackForLocalEngine(configured),
      ...sourceIds.map(sourceId => loadActivePackForLocalEngine(configured, { sourceId })),
    ]);
    if (packs.every(p => p === null)) return;
    setPackRelationSemantics(packRelationSemantics(packs.map(p => p?.manifest)));
  } catch {
    // keep the semantics already installed
  }
}
