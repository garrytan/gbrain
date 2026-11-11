/**
 * GST-363 (PR 1): unlabeled_people_folders. On a brain that serves several people (config access.serves, else two or
 * more enabled members: core/access/serves.ts), a top-level people/<x>/ folder that holds pages and that no folder
 * rule covers (a rule on people/<x>/ or on people/) is read by every caller entitled to the source, so one person's
 * bot can read another person's notes. Fails per folder; the fix previews the rule `gbrain setup --serves several`
 * would have added, and the user decides who reads it. Not applicable on a brain that serves one person.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { brainServes, unlabeledPeopleFolders } from '../../../core/access/serves.ts';

const NAME = 'unlabeled_people_folders';

async function runUnlabeledPeopleFolders(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const view = await brainServes(engine);
    if (view.serves === 'one') {
      checks.push(infoCheck(NAME, 'Not applicable: this brain serves one person (fewer than two enabled members and no access.serves = several).', 'not_applicable'));
      return checks;
    }
    const unlabeled = await unlabeledPeopleFolders(engine);
    const why = view.from === 'config' ? 'config access.serves is several' : `it has ${view.enabled_members.length} enabled members`;
    if (!unlabeled.length) {
      checks.push({ name: 'unlabeled_people_folders', status: 'ok', details: { serves: view, folders: [] }, message: `This brain serves several people (${why}), and every people/<name>/ folder with pages has a folder rule naming its readers.` });
      return checks;
    }
    const first = unlabeled[0]!;
    const member = first.prefix.slice('people/'.length, -1);
    checks.push({ name: 'unlabeled_people_folders', status: 'fail', details: { serves: view, folders: unlabeled },
      message: `This brain serves several people (${why}), but ${unlabeled.length} people folder(s) hold pages with no folder rule naming their readers: `
        + `${unlabeled.map(u => `${u.source}:${u.prefix} (${u.pages} page(s))`).join(', ')}. Every caller entitled to the source reads them, so one person's bot can read another person's notes.`,
      fix: agentFix(['gbrain', 'access', 'rule', 'add', '--prefix', first.prefix, '--readers', member, '--source', first.source],
        `Previews a rule keeping ${first.prefix} to ${member} (writes nothing without --yes). Ask the user who should read each folder; a folder that is not one person's goes to its own readers or a group.`, NAME,
        { ask_user: true, docs: 'docs/guides/setup.md#a-brain-that-serves-several-people' }) });
  } catch (error) {
    checks.push(checkError(NAME, `run ${NAME}`, error));
  }
  return checks;
}

export const unlabeledPeopleFoldersEntry: DoctorEntry = {
  name: 'unlabeled_people_folders',
  emits: ['unlabeled_people_folders'],
  run: runUnlabeledPeopleFolders,
};
