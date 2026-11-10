/**
 * GST-363: whether a brain serves several people. A brain does when config
 * access.serves says `several`, or when it is unset and the brain has two or
 * more enabled members; an explicit `one` or `several` wins over the member
 * count. `gbrain setup <harness> --serves several` writes the explicit value;
 * the doctor check unlabeled_people_folders and setup's refusal read it here.
 * Everything lives in the database, so a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';

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
