/**
 * `gbrain transcripts accept-fences [--source-id S] [--json] [--yes --expect <plan_hash>]` (#9427): the owner's one-pass
 * review of `outside_content_fences` for imported transcripts (logic in core/transcripts/fence-acceptance.ts).
 * Without --yes it previews and changes nothing; --yes --expect <plan_hash> records the previewed pages as accepted,
 * and a plan that moved since the preview refuses preview_changed. Only pages the transcript importer wrote qualify.
 */
import type { BrainEngine } from '../core/engine.ts';
import { usageError, writeCliError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';

export const TRANSCRIPTS_ACCEPT_FENCES_HELP = `Usage:
  gbrain transcripts accept-fences [--source-id S] [--json] [--yes --expect <plan_hash>]

Doctor's outside_content_fences check lists imported pages whose body someone
else wrote and that have facts, takes or links indexed from a fence, and asks
for a review of each page. For imported transcripts the answer is the same for
every page, so this reviews them in one pass: it lists every conversation page
that gbrain transcripts ingest wrote and that the check lists, with counts
(never a value) and a plan_hash. Nothing changes until you run it again with
--yes --expect <plan_hash>, which records those pages as reviewed; the check
then leaves them out while their rows stay exactly as reviewed. Nothing in a
page or its rows changes, and nothing is removed.

Email, calendar and GitHub pages, and a conversation page that anything other
than the importer last wrote (a remote agent's put_page included), are never
accepted here: they stay listed for review one page at a time.

  --source-id S        Only pages in this source (default: every source)
  --yes --expect <h>   Accept the pages the preview with plan_hash <h> listed
  --json               Machine-readable result
`;

const SHOWN = 20;

export async function runTranscriptsAcceptFences(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(TRANSCRIPTS_ACCEPT_FENCES_HELP); return; }
  const json = args.includes('--json');
  try {
    let sourceId: string | undefined, expect: string | undefined, yes = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--json') continue;
      if (a === '--yes') { yes = true; continue; }
      if ((a === '--source-id' || a === '--expect') && args[i + 1] && !args[i + 1]!.startsWith('-')) {
        if (a === '--source-id') sourceId = args[++i]; else expect = args[++i];
        continue;
      }
      throw usageError(`gbrain transcripts accept-fences does not accept ${a}; nothing was changed.`, 'Run `gbrain transcripts accept-fences --json` to preview.');
    }
    const preview = ['gbrain', 'transcripts', 'accept-fences', ...(sourceId ? ['--source-id', sourceId] : []), '--json'];
    if (yes !== (expect !== undefined)) {
      throw usageError('Accepting needs both --yes and --expect <plan_hash> from the preview; nothing was changed.', `Preview first: ${preview.join(' ')}`);
    }
    const { applyFenceAcceptance, planFenceAcceptance } = await import('../core/transcripts/fence-acceptance.ts');
    const plan = await planFenceAcceptance(engine, { sourceId });
    const apply = plan.pages.length ? ['gbrain', 'transcripts', 'accept-fences', ...(sourceId ? ['--source-id', sourceId] : []), '--yes', '--expect', plan.plan_hash] : null;
    if (!yes) {
      if (json) { console.log(JSON.stringify({ dry_run: true, ...plan, ...(apply ? { apply } : {}) }, null, 2)); return; }
      console.log(plan.pages.length
        ? `${plan.pages.length} imported transcript page(s) have fence rows the user can accept as reviewed (${plan.already_accepted} already accepted):`
        : `No imported transcript page waits for review (${plan.already_accepted} already accepted).`);
      for (const p of plan.pages.slice(0, SHOWN)) console.log(`  ${p.source_id}:${p.slug}  facts ${p.facts}, world ${p.world_facts}, takes ${p.takes}, links ${p.links}`);
      if (plan.pages.length > SHOWN) console.log(`  and ${plan.pages.length - SHOWN} more (--json lists every one)`);
      if (plan.not_eligible.length) console.log(`${plan.not_eligible.length} other listed page(s) are not importer-written transcripts and need review one at a time (gbrain get).`);
      if (apply) console.log(`plan_hash: ${plan.plan_hash}\nAccept, only after the user agrees: ${apply.join(' ')}`);
      return;
    }
    if (expect !== plan.plan_hash) {
      throw opError('preview_changed', `The transcript pages changed since the preview (--expect ${expect}, current plan ${plan.plan_hash}); nothing was accepted.`,
        'Preview again, show the user the new list, and accept with its plan_hash only if they agree.',
        { why: 'An acceptance covers exactly the pages and rows the user saw.',
          fix: { argv: preview, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current list and its plan_hash; changes nothing.' } });
    }
    const accepted = await applyFenceAcceptance(engine, plan);
    if (json) console.log(JSON.stringify({ dry_run: false, plan_hash: plan.plan_hash, accepted, not_eligible: plan.not_eligible.length }, null, 2));
    else console.log(`Accepted ${accepted} imported transcript page(s) as reviewed. gbrain doctor --only outside_content_fences confirms.`);
  } catch (e) {
    setCliExitVerdict(writeCliError(e, 'transcripts', { json }));
  }
}
