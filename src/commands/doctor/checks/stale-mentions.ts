/**
 * stale_mentions doctor check (#3674, lands PR #3711) — auto-linked mentions
 * the current gazetteer no longer produces.
 *
 * `extract links --by-mention` writes through addLinksBatch, which is purely
 * additive, and put_page reconciliation deliberately excludes 'mentions'. So
 * a link survives its own justification: rewrite a body so it stops naming
 * the entity, delete or retype the entity page, or change the tokenizer, and
 * the row stays. Re-running the scan does not help — it adds today's correct
 * links ALONGSIDE the old ones.
 *
 * READ-ONLY by design; the write-side repair is the opt-in
 * `gbrain extract links --by-mention --rebuild` sweep (same issue). No
 * RemediationStep here — a destructive write doesn't belong on a doctor
 * check's back.
 *
 * Never 'fail': the data is wrong but a per-pair `gbrain unlink` workaround
 * (or the --rebuild sweep) exists, which is the p2 bar.
 *
 * Lives in the doctor module dir per the peeled-façade rule — new code goes
 * here, not back into doctor.ts.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { scanStaleMentions } from '../../../core/by-mention.ts';

export async function staleMentionsCheck(engine: BrainEngine): Promise<Check> {
  try {
    const res = await scanStaleMentions(engine);
    // Say what was NOT covered rather than implying the whole brain was.
    const coverage = res.pagesScanned < res.totalPagesWithMentions
      ? ` (sampled ${res.pagesScanned} of ${res.totalPagesWithMentions} pages carrying mentions links)`
      : '';

    if (res.totalPagesWithMentions === 0) {
      return {
        name: 'stale_mentions',
        status: 'ok',
        message: 'No by-mention links in this brain.',
      };
    }
    if (res.staleLinks === 0) {
      return {
        name: 'stale_mentions',
        status: 'ok',
        message: `Re-derived ${res.linksScanned} by-mention link(s) across ${res.pagesScanned} page(s)${coverage}; all still follow from the current gazetteer.`,
      };
    }
    const kinds = Object.entries(res.staleByKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    const eg = res.examples.map(e => `${e.from} -> ${e.to}`).join(', ');
    // An empty gazetteer makes EVERY mentions row unreproducible, which is
    // a different diagnosis from ordinary drift — name it, or the operator
    // reads "everything is stale" and starts deleting real links.
    const why = res.emptyGazetteer
      ? 'This brain currently has NO linkable entity pages, so every mentions row is unreproducible — check whether entity pages were deleted or retyped before treating these as garbage. '
      : '';
    return {
      name: 'stale_mentions',
      status: 'warn',
      message:
        `${res.staleLinks} of ${res.linksScanned} by-mention link(s) no longer follow from the current gazetteer${coverage} (${kinds}). ` +
        `${why}Re-running the scan will NOT remove them — the write path is additive. ` +
        `Remove individually with: gbrain unlink <from> <to> --link-type mentions --link-source mentions. ` +
        `e.g. ${eg}`,
    };
  } catch (e) {
    return {
      name: 'stale_mentions',
      status: 'warn',
      message: `stale-mentions scan skipped: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
