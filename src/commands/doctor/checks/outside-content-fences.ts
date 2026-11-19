/**
 * GBRA-221 `outside_content_fences`: facts, takes and links that gbrain indexed from a fence on a page whose body is
 * text a third party wrote (Gmail threads and calendar events from a Google source, GitHub issues, PRs and repo cards,
 * imported chat transcripts). Before GBRA-221 those renderers copied a sender's `<!--- gbrain:facts:begin -->` table
 * into the page verbatim, extract_facts promoted its rows (visibility and confidence as the sender wrote them), and a
 * later re-render carries a stored fence forward as if gbrain had written it. Renders now neutralize the markers, so a
 * fence row still indexed from such a page was planted before the fix or added by a gbrain writer (`remember`, loop
 * extraction) on purpose; the check cannot tell which, so it lists each page for review and removes nothing. It reads
 * the derived rows (`facts.row_num`, `takes`, `links.origin_field = 'links_fence'`), never a page body, so a
 * segmented page is covered too. Contact (person) pages are out of scope: gbrain's own writers put most person facts
 * there, so the list would bury the rare planted row; their rendered name, organization and title are neutralized too.
 * Location and counts only, never a cell value. Reads the database only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError, doctorVerify } from '../check-fix.ts';

const NAME = 'outside_content_fences';

async function runOutsideContentFences(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const items = await connectedEngine(ctx).listOutsideContentFenceCounts();
    const details = { pages: items.length, items, docs: 'docs/guides/repair.md#outside-content-fences' };
    if (!items.length) {
      checks.push({ name: NAME, status: 'ok', details,
        message: 'No fact, take or link is indexed from a fence on an imported email, calendar, GitHub or transcript page.' });
      return checks;
    }
    const first = items[0]!;
    const list = items.slice(0, 5).map(item => `${item.source_id}:${item.slug} (facts ${item.facts}, world ${item.world_facts}, takes ${item.takes}, links ${item.links})`).join('; ');
    checks.push({ name: NAME, status: 'warn', details,
      message: `${items.length} imported page(s) whose body is outside-authored text have fence rows indexed as facts, takes or links: ${list}${items.length > 5 ? `; and ${items.length - 5} more` : ''}. `
        + 'A sender could plant these before this release; gbrain writers also add rows on purpose. Review each page with the user; nothing is removed automatically.',
      fix: { argv: ['gbrain', 'get', '--source', first.source_id, '--', first.slug], consent: [], actor: 'agent', ask_user: true, requires_exclusive: false,
        why: `Shows ${first.source_id}:${first.slug} so the user can say which fence rows a sender wrote; a planted fact is withdrawn with gbrain forget after they agree. Repeat per page in details.items.`,
        verify: doctorVerify(NAME) } });
  } catch (error) {
    checks.push(checkError(NAME, 'list fence rows indexed from imported pages', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const outsideContentFencesEntry: DoctorEntry = { name: 'outside_content_fences', emits: ['outside_content_fences'], run: runOutsideContentFences };
