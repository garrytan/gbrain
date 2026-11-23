**`gbrain dedupe classes` counts likely duplicate people by their evidence, and `gbrain dedupe sample` exports pairs to check by hand.**

`gbrain dedupe classes` groups every pair of person pages that might be one person by its evidence: a shared email, phone or account id (C1 to C7), your email pages and chat pages (iMessage and chat exports, read only on your machine), and, if you turn it on with your own key, an Exa web search on a name plus one company or job title. It prints how many pairs would link, wait or be marked different. `gbrain dedupe sample --class <c>` picks a seeded random sample of one class for labelling. Both only read: nothing is linked or edited. Web search is off by default, is never used for private, family or minor pages, caches every answer, and stops at a per-run and a total cap; `--exa --dry-run` prints the cost first.

<!-- behavior-change: dedupe_classes_gst3609 -->

### For contributors
- `src/core/entities/evidence/`: `people.ts` (candidate pairs and their base class), `email.ts` (E1, E3, E4), `messaging.ts` (M1 to M3, Mx), `exa.ts` (the opt-in client, cache and caps), `combine.ts` (the rule) and `classes.ts` (counts and the seeded sample).
- New config keys: `dedupe.exa`, `dedupe.exa_run_cap`, `dedupe.exa_total_cap_usd`; internal state `dedupe.exa_spent_usd` and `dedupe.exa_cache.*`. New error code `dedupe_exa_off`.
- test/dedupe-classes-evidence.test.ts covers every class, the contradictions, zero email and chat pages, Exa off by default, the privacy filter on a fake fetch, the cache, both caps and the dry run on a repo-less brain.
