**Thin-page filling can now start with the people you actually meet and message, and can stay under a daily spending cap.**

<!-- behavior-change: enrich_thin_owner_contact_default -->

### Added
- `gbrain enrich --thin --order owner-contact` ranks thin person and company pages by recent contact: meetings, conversations, email threads and chronicle events from the last 90 days that link to or mention the page (newer counts more), open loops with that person, and one point when the page links to or from your own page, divided by how full the page already is. A page you met three times this week now comes before one linked from 200 old imports. The ranking is one SQL query with no model call, so it works on a keyless brain, and `--dry-run` prints the order and each source's candidates in rank order.
- The `enrich_thin` cycle phase uses owner-contact as its default order when gbrain finds your own page with no conflict, and keeps inbound-links otherwise. A `cycle.enrich_thin.order` you set always wins. The phase stays off by default.
- `cycle.enrich_thin.max_daily_cost_usd` and `cycle.enrich_thin.max_daily_pages` cap the phase across every run in your day (`brain.timezone`, UTC when unset), on top of the per-run caps. Unset, there is no daily cap; a cap set to something that is not a number (`$5`) stops the phase until it is fixed, instead of meaning no cap. A run charges each source its full cap before it starts and trues it up after, so a run that dies mid-source never under-counts.
- Without a chat model the phase skips before any spend and still reports the order it would use.
- On a brain with no chat key, `gbrain learned` now says how many people you are in touch with have thin pages ("2 close contacts have thin pages; a chat key would fill them"), with the commands that turn filling on and what it would cost. Only you see it, locally or with your owner token. Nothing is filled and nothing is spent.
- `gbrain learned` now keeps up to five possible duplicate people open at a time, the person groups from `gbrain dedupe --preview` ranked by how recently you met them (preview order when gbrain can't find your own page). Each one shows the exact `gbrain dedupe confirm` and `gbrain dedupe reject` commands for its group, and drops out once you answer; the next best group takes its place on the next cycle, and the best-ranked shows first. Nothing is linked or merged on its own, keyless brains get the list too, and a remote token sees only groups whose pages it can read.

### For contributors
- On an engine with no raw SQL (the Rust engine), the `enrich_thin` phase skips with `engine_capability_missing` before it lists candidates.
- The Rust engine store refuses `listEnrichCandidates` with `order: 'owner-contact'` (`engine_capability_missing`) instead of answering with another order.
- `listEnrichCandidates` returns `contact_score` for the owner-contact order. `test/learning-duplicates.test.ts` covers the duplicate list on PGLite and Postgres.
- `test/enrich-owner-contact.test.ts` covers the ranking on PGLite and Postgres, the default-order fallback, keyless runs and 24 runs in one day; `test/enrich-owner-contact-perf.slow.test.ts` holds the query under 500 ms at 100,000 pages on PGLite.
