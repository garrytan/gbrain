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
 * #9427: an imported transcript the owner accepted with `gbrain transcripts accept-fences` leaves the list while its
 * rows and importer provenance stay exactly as accepted (core/transcripts/fence-acceptance.ts).
 * Location and counts only, never a cell value. Reads the database only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { lacksRawSql } from '../../../core/engine-capabilities.ts';
import { fenceItem, isAccepted, listOutsideFencePages, loadFenceAcceptance } from '../../../core/transcripts/fence-acceptance.ts';

const NAME = 'outside_content_fences';

async function runOutsideContentFences(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    // A Rust brain has no raw SQL, so it cannot read the importer provenance or fingerprint the rows an acceptance binds
    // (listOutsideFencePages), and `transcripts accept-fences` refuses there (engine_capability_missing raw_sql): nobody
    // can have accepted a page on it. It serves the per-page counts it served before #9427 and lists every page.
    const rustCounts = lacksRawSql(engine);
    const [listed, acceptance] = rustCounts ? [[], []] : await Promise.all([listOutsideFencePages(engine), loadFenceAcceptance(engine)]);
    const open = listed.filter(page => !isAccepted(page, acceptance));
    const transcripts = open.filter(page => page.imported_transcript).length;
    const items = rustCounts ? await engine.listOutsideContentFenceCounts() : open.map(fenceItem);
    const accepted = listed.length - open.length;
    const details = { pages: items.length, items, ...(accepted ? { accepted_transcripts: accepted } : {}), docs: 'docs/guides/repair.md#outside-content-fences' };
    if (!items.length) {
      checks.push({ name: NAME, status: 'ok', details,
        message: 'No fact, take or link is indexed from a fence on an imported email, calendar, GitHub or transcript page.'
          + (accepted ? ` ${accepted} imported transcript page(s) are accepted as reviewed by the owner.` : '') });
      return checks;
    }
    const first = items[0]!;
    const list = items.slice(0, 5).map(item => `${item.source_id}:${item.slug} (facts ${item.facts}, world ${item.world_facts}, takes ${item.takes}, links ${item.links})`).join('; ');
    checks.push({ name: NAME, status: 'warn', details,
      message: `${items.length} imported page(s) whose body is outside-authored text have fence rows indexed as facts, takes or links: ${list}${items.length > 5 ? `; and ${items.length - 5} more` : ''}. `
        + 'A sender could plant these before this release; gbrain writers also add rows on purpose. Review each page with the user; nothing is removed automatically.'
        + (transcripts ? ` ${transcripts} of them are imported transcripts, which the user can review in one pass: gbrain transcripts accept-fences previews them.` : ''),
      fix: transcripts
        ? { argv: ['gbrain', 'transcripts', 'accept-fences', '--json'], consent: [], actor: 'agent', ask_user: true, requires_exclusive: false,
          why: `Lists the ${transcripts} imported transcript page(s) and a plan_hash, read-only; if the user accepts them as reviewed, apply with --yes --expect <plan_hash>. Other pages still need per-page review (gbrain get).`,
          verify: doctorVerify(NAME) }
        : { argv: ['gbrain', 'get', '--source', first.source_id, '--', first.slug], consent: [], actor: 'agent', ask_user: true, requires_exclusive: false,
          why: `Shows ${first.source_id}:${first.slug} so the user can say which fence rows a sender wrote; a planted fact is withdrawn with gbrain forget after they agree. Repeat per page in details.items.`,
          verify: doctorVerify(NAME) } });
  } catch (error) {
    checks.push(checkError(NAME, 'list fence rows indexed from imported pages', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const outsideContentFencesEntry: DoctorEntry = { name: 'outside_content_fences', emits: ['outside_content_fences'], run: runOutsideContentFences };
