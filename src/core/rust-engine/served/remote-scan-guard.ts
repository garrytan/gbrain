/**
 * The output-aware guard for the one scan-cursor read a remote caller may send over the served wire:
 * `nextLivePageAfter(afterPageId)`, the next live page by id in ANY source, which the exact-phrase scan (search/exact-scan.ts)
 * uses to step past a page that timed out alone. The member itself filters nothing, so for a remote caller the brain server
 * steps past every page the caller may not read (re-calling with the id it was given) and answers the first readable page, or
 * null when the pages end. A cursor of 0 or a cursor that names no page is valid: the member answers the next page after it.
 *
 * The walk is bounded so a brain full of hidden pages cannot hold the call: it ends when the call's read deadline passes (the
 * client's `read_deadline_at`, absent inside a held transaction) and after SCAN_STEP_LIMIT hidden pages. Past either bound the
 * call is refused `permission_denied`, reason `scan_gap_hidden`, and nothing is answered, so a caller learns only that the next
 * pages are not readable, never which page or how many.
 */
import { opError } from '../../ops/contract.ts';
import { readDeadline } from '../../read-deadline.ts';
import type { BrainEngine } from '../../engine.ts';

type Member = (...args: unknown[]) => Promise<unknown>;
type PageRow = { id: number; slug: string; source_id: string };

/** The most hidden pages one call steps past. */
export const SCAN_STEP_LIMIT = 1000;

/** The call target for `nextLivePageAfter` on `engine` for a remote caller: `plain` is the member itself on that engine. */
export function nextReadablePage(engine: object, plain: Member): Member {
  return async (...args) => {
    const { remotePageAccess } = await import('../../persistence/page-visibility.ts');
    let row = await plain(...args) as PageRow | null;
    for (let hidden = 0; row; hidden++) {
      const { readable } = await remotePageAccess(engine as BrainEngine, [{ source_id: row.source_id, slug: row.slug }]);
      if (readable.has(`${row.source_id}\u0000${row.slug}`)) return row;
      const deadline = readDeadline();
      if (hidden >= SCAN_STEP_LIMIT || (deadline !== undefined && Date.now() >= deadline)) throw scanGapHidden(hidden + 1, deadline !== undefined && Date.now() >= deadline);
      row = await plain(Number(row.id)) as PageRow | null;
    }
    return null;
  };
}

function scanGapHidden(steps: number, deadline: boolean): Error {
  return opError('permission_denied', `The next page scan step was refused: the pages after the cursor are not readable by the caller and the walk past them hit its ${deadline ? 'read deadline' : `${SCAN_STEP_LIMIT}-page bound`}, so nothing was answered.`,
    'A remote caller learns of a page only when it may read it; resume the scan from a later cursor.',
    { reason: 'scan_gap_hidden', retryable: false, detail: `member=nextLivePageAfter via=served bound=${deadline ? 'deadline' : 'steps'} stepped=${steps} read=nothing` });
}
