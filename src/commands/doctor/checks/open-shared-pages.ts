/**
 * GST-2670 (GBRA-502): open_shared_pages. On a brain that serves several people, the pages no rule or readable_by
 * restricts are read by every member's key (core/access/open-pages.ts). Warns while any of them is a DM, chat,
 * conversation or mail page; reports other open pages as information, since a team may share them on purpose.
 * Read-only: the fix asks the user who should read them and lists the pages with a read-only command. A remote caller
 * (run_doctor) gets totals only, never folder names. Not applicable on a brain that serves one person.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { brainServes } from '../../../core/access/serves.ts';
import { openPagesHeadline, openPagesLines, readOpenPages } from '../../../core/access/open-pages.ts';

const NAME = 'open_shared_pages';

async function runOpenSharedPages(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    if ((await brainServes(engine)).serves === 'one') {
      checks.push(infoCheck(NAME, 'Not applicable: this brain serves one person, so its own keys read its own pages.', 'not_applicable'));
      return checks;
    }
    const read = await readOpenPages(engine);
    const o = read.open_pages;
    if (!o) {
      const error = read.open_pages_error!;
      checks.push(ctx.remote
        ? checkError(NAME, "count the pages every member's key can read", new Error(`${error.code}; ask the brain host's operator to run gbrain doctor --only open_shared_pages`), { details: { open_pages: null, code: error.code } })
        : checkError(NAME, "count the pages every member's key can read", new Error(error.message), { details: { open_pages: null, open_pages_error: error } }));
      return checks;
    }
    const details = ctx.remote ? { total: o.total, sensitive: o.sensitive, members: o.members } : { open_pages: o };
    const message = `This brain serves several people. ${openPagesHeadline(o)}`;
    if (!o.total) {
      checks.push({ name: 'open_shared_pages', status: 'ok', message, details });
      return checks;
    }
    if (!o.sensitive || !o.members.reading) {
      checks.push({ name: 'open_shared_pages', status: 'ok', severity: 'info', readiness_state: 'ok', details,
        message: o.members.reading
          ? `${message} A team may share these on purpose; to keep a folder to some members, name its readers (gbrain access rule add --prefix <folder>/ --readers <list>).`
          : `${message} A member key made later will read them unless they name their readers first.` });
      return checks;
    }
    const top = o.top_sensitive!;
    checks.push({ name: 'open_shared_pages', status: 'warn', details,
      message: ctx.remote ? `${message} Ask the brain host's operator to run gbrain doctor --only open_shared_pages.` : `${message} A key bound to a member reads a page with no readers like any other key.`,
      ...(ctx.remote ? {} : { fix: agentFix(['gbrain', 'list', '--type', top.type, '--source-id', top.source, '--json'],
        'Read-only: lists the pages of the largest open DM, chat or mail type (pages that already name readers are listed too, 50 at a time), so the user can say who should read the open ones.', NAME,
        { ask_user: true, docs: 'docs/guides/access-designations.md#pages-every-members-key-can-read', user_message: openPagesLines(read, { prefix: '' }).join('\n') }) }) });
  } catch (error) {
    checks.push(checkError(NAME, `run ${NAME}`, error));
  }
  return checks;
}

export const openSharedPagesEntry: DoctorEntry = {
  name: 'open_shared_pages',
  emits: ['open_shared_pages'],
  run: runOpenSharedPages,
};
