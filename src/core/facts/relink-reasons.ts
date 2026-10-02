/**
 * The one canonical list of `gbrain facts relink` skip reasons (#5836). Human
 * output, `--json`, the attempt memo and the relink guide table all come from
 * this table; `memoized` reasons are model verdicts that stop the model tier
 * from paying for the same fact again unless `--retry-model` is passed.
 */
export const RELINK_REASONS = {
  no_subject: { memoized: true, fix: 'The model found no single person, company or project in the fact. Nothing to fix; rerun with --retry-model to ask again.' },
  ambiguous: { memoized: true, fix: 'The fact names more than one entity, or a name competes with the match. Link it by hand: forget it and remember it again with --entity.' },
  unverified_match: { memoized: true, fix: 'The only match is a bare first name or a name that is not in the fact. Add an alias to the right entity page, then rerun.' },
  no_mention: { memoized: false, fix: 'The fact names no entity. Rerun with the model tier (drop --no-llm), or link it by hand with remember --entity.' },
  no_page: { memoized: false, fix: 'The fact names an entity that has no page. Create the entity page, then rerun.' },
  model_unavailable: { memoized: false, fix: 'The extraction model could not be reached. Configure it with gbrain config set facts.extraction_model <provider:model>. To skip the model tier, run gbrain facts relink --no-llm.' },
  model_unparseable: { memoized: false, fix: 'The model returned output relink could not read. Rerun; if it persists, set a different facts.extraction_model.' },
  withdrawn: { memoized: false, fix: 'This claim was explicitly forgotten for that entity, so relink will not attach it there.' },
  page_file_missing: { memoized: false, fix: 'The entity page exists in the database but its file is missing from the source tree. Restore the file or run gbrain sync, then rerun.' },
  unfenceable: { memoized: false, fix: 'The source writes through to files but has no canonical owner. Bind the source (gbrain sources writer status <source> --json, then gbrain sources writer claim <source> --path <checkout> --admin-intent writer_claim --expected-state <admin_state>), then rerun.' },
  fence_malformed: { memoized: false, fix: 'The entity page has a malformed ## Facts fence. Repair the fence (gbrain doctor names it), then rerun.' },
  claim_unfenceable: { memoized: false, fix: 'The claim text cannot be written to a fence row unchanged (for example it is wrapped in ~~). Forget it and remember a cleaned-up claim with --entity.' },
  visibility_conflict: { memoized: false, fix: 'The entity already has the same claim from the same source with the other visibility, and a page indexes only one. Forget the copy you do not want, then rerun.' },
  fence_owned: { memoized: false, fix: 'The fact lives in another page fence (a transcript). Relink does not move fence-owned facts.' },
  budget_exhausted: { memoized: false, fix: 'The model tier reached --max-usd. Raise --max-usd (or pass off) and rerun with the printed continuation command.' },
  revision_conflict: { memoized: false, fix: 'The fact or the entity page changed while relink ran. Rerun.' },
} as const satisfies Record<string, { memoized: boolean; fix: string }>;

export type RelinkReason = keyof typeof RELINK_REASONS;
export const RELINK_REASON_CODES = Object.keys(RELINK_REASONS) as RelinkReason[];
