/**
 * Sources holding an adopted skill pack (#6076), shared by doctor
 * `source_routing_health` (a skills source has no pages by design) and
 * `sync_freshness` (a read-only catalog pack has no commits to sync).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

/**
 * Non-default sources holding an adopted skill pack: a `shared_skill_packs`
 * row for the source's current incarnation with at least one live
 * (`NOT deleted`) `shared_skill_heads` row. A pack left behind by an earlier
 * incarnation does not count. A schema without the shared-skills tables (or
 * `sources.incarnation`) has no adopted packs; any other error throws.
 */
export async function adoptedSkillPackSourceIds(engine: BrainEngine): Promise<Set<string>> {
  try {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT s.id FROM sources s
        WHERE s.id <> 'default' AND EXISTS (
          SELECT 1 FROM shared_skill_packs p
            JOIN shared_skill_heads h ON h.source_id = p.source_id AND h.source_incarnation = p.source_incarnation
                                     AND h.pack_id = p.pack_id AND NOT h.deleted
           WHERE p.source_id = s.id AND p.source_incarnation = s.incarnation)`,
    );
    return new Set(rows.map((r) => r.id));
  } catch (e) {
    if (isMissingSchemaObject(e, 'table', ['shared_skill_packs', 'shared_skill_heads']) || isMissingSchemaObject(e, 'column', 'incarnation')) return new Set();
    throw e;
  }
}

/**
 * The adopted-pack sources whose content is a read-only catalog: no commit
 * history recorded (`last_commit` NULL) and, when the caller may read the local
 * checkout (`localOnly`), no `.git` under its root. A git-backed pack is not
 * one: its commits can move, so its freshness is still judged. Errors never
 * escape: the adopted-pack read failing exempts nothing and returns a `note`,
 * and a source whose checkout cannot be probed is judged normally.
 */
export async function readOnlyCatalogPackSourceIds(
  engine: BrainEngine,
  sources: ReadonlyArray<{ id: string; local_path: string | null; last_commit: string | null }>,
  localOnly: boolean,
): Promise<{ ids: Set<string>; note: string | null }> {
  let adopted: Set<string>;
  try { adopted = await adoptedSkillPackSourceIds(engine); }
  catch (e) { return { ids: new Set(), note: `read-only skill-pack exemption unavailable (${e instanceof Error ? e.message : String(e)}); those sources were judged as git sources` }; }
  const ids = new Set<string>();
  for (const source of sources) {
    if (!adopted.has(source.id) || source.last_commit) continue;
    try {
      if (localOnly && source.local_path && existsSync(join(source.local_path, '.git'))) continue;
    } catch { continue; }
    ids.add(source.id);
  }
  return { ids, note: null };
}
