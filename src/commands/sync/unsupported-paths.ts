/**
 * Classic sync's byte-path routing (GBRA-133): the delta paths the lossless
 * parser (`computeLosslessSyncDelta`) could not turn into page paths become
 * `unsupported_path` holds in the classic hold store, and gitlinks that appeared
 * are reported once, in the run that advances past them. Neither ever gates
 * the bookmark. Key, display, item id and fix live in core/sync-byte-paths.ts.
 */
import { serr } from '../../core/console-prefix.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { RECOVERY_VERSION } from '../../core/frontmatter-recovery.ts';
import { writeGitHold } from '../../core/persistence/sync-holds.ts';
import { bytePathItemId, displayBytePath, encodeBytePathKey } from '../../core/sync-byte-paths.ts';
import type { LosslessDelta, UnsupportedGitPath } from '../../core/sync-delta.ts';
import type { SyncPlan } from './sync-run.ts';
import type { LegacyHolds } from './holds.ts';

declare module '../sync.ts' {
  interface SyncResult {
    /** GBRA-133: gitlinks (submodules, embedded repositories) that appeared in this run's range; their contents are not synced. */
    gitlinks_not_followed?: string[];
  }
}

/** What the text manifest cannot carry, filtered to this run and in the mode's path form. */
export interface BytePaths { unsupported: UnsupportedGitPath[]; gone: Buffer[]; gitlinks: string[] }

export const NO_BYTE_PATHS: BytePaths = { unsupported: [], gone: [], gitlinks: [] };

/**
 * Keeps the byte paths this run syncs: the same scope, exclude and syncability filters as the text manifest, applied to
 * the name with each undecodable byte read as U+FFFD and each control character as `_` (so a `notes/caf<E9>.md` counts as
 * Markdown and a binary in an excluded folder is left alone), then made relative to the mode's root by `modeRel`.
 */
export function selectBytePaths(delta: Pick<LosslessDelta, 'unsupported' | 'gone' | 'gitlinks'>, filter: {
  inScope: (path: string) => boolean; excluded: (path: string) => boolean; selected: (path: string) => boolean; modeRel: (path: string) => string;
}): BytePaths {
  // eslint-disable-next-line no-control-regex
  const probe = (raw: Buffer) => raw.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '_');
  const keep = (raw: Buffer) => { const path = probe(raw); return filter.inScope(path) && !filter.excluded(path) && filter.selected(path); };
  const rel = (raw: Buffer) => {
    const path = probe(raw);
    return raw.subarray(Buffer.byteLength(path.slice(0, path.length - filter.modeRel(path).length)));
  };
  return {
    unsupported: delta.unsupported.filter(entry => keep(entry.raw)).map(entry => ({ ...entry, raw: rel(entry.raw) })),
    gone: delta.gone.filter(raw => filter.inScope(probe(raw))).map(rel),
    gitlinks: delta.gitlinks.filter(path => filter.inScope(path) && !filter.excluded(path)).map(filter.modeRel),
  };
}

/** Holds each unsupported path (never gating the bookmark), schedules the holds of gone ones to clear, and reports new gitlinks. */
export async function holdUnsupportedPaths(engine: BrainEngine, holds: LegacyHolds | null, paths: BytePaths): Promise<void> {
  if (paths.gitlinks.length) {
    serr(`  ${paths.gitlinks.length} gitlink(s) not followed (gitlink_not_followed): ${paths.gitlinks.slice(0, 20).join(', ')}. `
      + 'Submodule and embedded-repository contents are not synced; add a checkout of one as its own source to index it.');
  }
  if (!holds) return;
  for (const raw of paths.gone) {
    const key = encodeBytePathKey(raw);
    if (holds.existing.has(key)) holds.gone.push(key);
  }
  for (const { raw, reason } of paths.unsupported) {
    const key = encodeBytePathKey(raw), shown = displayBytePath(raw), item = bytePathItemId(raw);
    const message = `${shown} (item ${item}) ${reason === 'not_utf8' ? 'has a name that is not valid UTF-8' : 'has a control character in its name'}, `
      + 'so sync cannot use it as a page path; rename the file to import it.';
    await engine.transaction(tx => writeGitHold(tx, {
      source_id: holds.sourceId, incarnation: holds.incarnation, path: key, source_path: key, slug: null, page_id: null,
      code: 'unsupported_path', message, upstream_version: null, observed_at: holds.observedAt, run_id: holds.runId, mode: 'legacy',
      meta: { reason, recovery_version: RECOVERY_VERSION },
    }));
    holds.heldPaths.push(key);
    serr(`  Held ${shown} (unsupported_path/${reason}, item ${item}): not imported, the sync continues.`);
  }
}

/** The run result's gitlink field (empty when none appeared). */
export function gitlinkFields(plan: Pick<SyncPlan, 'gitlinks'>): { gitlinks_not_followed?: string[] } {
  return plan.gitlinks.length ? { gitlinks_not_followed: plan.gitlinks } : {};
}
