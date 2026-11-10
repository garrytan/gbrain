/**
 * GST-363: whether a brain serves several people. A brain does when config
 * access.serves says `several`, or when it is unset and the brain has two or
 * more enabled members; an explicit `one` or `several` wins over the member
 * count. `gbrain setup <harness> --serves several` writes the explicit value;
 * the doctor check unlabeled_people_folders and setup's refusal read it here.
 * Everything lives in the database, so a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { appliedRules } from './policy.ts';

export const SERVES_KEY = 'access.serves';

export interface ServesView {
  serves: 'one' | 'several';
  /** `config` when access.serves decided it, `members` when the enabled-member count did. */
  from: 'config' | 'members';
  enabled_members: string[];
}

export async function brainServes(engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>): Promise<ServesView> {
  const members = (await engine.executeRaw<{ id: string }>(
    'SELECT id FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id')).map(r => r.id);
  const explicit = (await engine.getConfig(SERVES_KEY))?.trim();
  if (explicit === 'one' || explicit === 'several') return { serves: explicit, from: 'config', enabled_members: members };
  return { serves: members.length >= 2 ? 'several' : 'one', from: 'members', enabled_members: members };
}

export interface PeopleFolder { source: string; prefix: string; pages: number }

/** Top-level people/<x>/ folders holding pages that no applied rule covers (a rule on people/<x>/ or on people/). */
export async function unlabeledPeopleFolders(engine: Pick<BrainEngine, 'executeRaw'>): Promise<PeopleFolder[]> {
  const folders = await engine.executeRaw<{ source_id: string; folder: string; pages: number }>(
    `SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY 1, 2`);
  const rulesBySource = new Map<string, string[]>();
  const unlabeled: PeopleFolder[] = [];
  for (const f of folders) {
    if (!rulesBySource.has(f.source_id)) rulesBySource.set(f.source_id, (await appliedRules(engine, f.source_id)).map(r => r.prefix));
    const prefix = `people/${f.folder}/`;
    if (!rulesBySource.get(f.source_id)!.some(p => p === prefix || p === 'people/')) unlabeled.push({ source: f.source_id, prefix, pages: Number(f.pages) });
  }
  return unlabeled;
}
