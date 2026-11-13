/**
 * GST-363: whether a brain serves several people. A brain does when config
 * access.serves says `several`, or when it is unset and the brain has two or
 * more enabled members; an explicit `one` or `several` wins over the member
 * count. The member count is the flag a trigger on access_members keeps in
 * config access.serves_derived (migration v309), which a remote request reads
 * from its config snapshot (servesPolicyFrom); `since` is when the brain first
 * served several people, which starts the unscoped-read grace.
 * `gbrain setup <harness> --serves several` writes the explicit value; the
 * doctor checks and setup's refusal read it here. Everything lives in the
 * database, so a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { appliedRules } from './policy.ts';
import { SERVES_DERIVED_KEY, SERVES_KEY, SERVES_SINCE_KEY, servesPolicyFrom } from '../search/private-visibility.ts';

export { SERVES_KEY };

export interface ServesView {
  serves: 'one' | 'several';
  /** `config` when access.serves decided it, `members` when the enabled-member count did. */
  from: 'config' | 'members';
  enabled_members: string[];
  /** When the brain first served several people (config access.serves_since), or null. */
  since: string | null;
}

export async function brainServes(engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>): Promise<ServesView> {
  const members = (await engine.executeRaw<{ id: string }>(
    'SELECT id FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id')).map(r => r.id);
  const [explicit, derived, since] = await Promise.all([engine.getConfig(SERVES_KEY), engine.getConfig(SERVES_DERIVED_KEY), engine.getConfig(SERVES_SINCE_KEY)]);
  const policy = servesPolicyFrom({ [SERVES_KEY]: explicit ?? undefined, [SERVES_DERIVED_KEY]: derived ?? undefined });
  return { serves: policy.several ? 'several' : 'one', from: policy.from, enabled_members: members, since: since?.trim() || null };
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
