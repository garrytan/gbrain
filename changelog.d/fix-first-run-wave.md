**First-run fixes: setup's summary arrives whole, keyless brains stop showing false warnings, and next-step hints name commands that work.**

### Fixed
- gbrain setup and gbrain init relay their whole first-run summary to the user instead of cutting it at 1,000 characters.
<!-- behavior-change: show_user_relay_whole_gbra789 -->
- Search and query on a brain with embeddings off on purpose no longer report pages "held from embedding" as degraded coverage or point at gbrain embed --held.
<!-- behavior-change: keyless_no_embedding_held_notice_gbra789 -->
- gbrain transcripts ingest suggests gbrain get <slug> for the page it wrote instead of a query for the slug string.
<!-- behavior-change: transcripts_try_it_get_gbra789 -->
- gbrain learned and learned --stats start their default window at the brain's creation on a brain younger than the window, instead of naming a date before the brain existed.
<!-- behavior-change: learned_window_brain_start_gbra789 -->
- gbrain status reads a keyless repo-less brain as healthy (repo-less, embed=off) and shows a completed gbrain dream as the last full cycle.
<!-- behavior-change: status_keyless_repo_less_gbra789 -->
- The page anatomy guide lists the timeline forms gbrain reads (bold-date bullets with `|`, `###` date headings, dated `[Source: …]` citations) and says a plain dated list makes no row.
- Brain-page pointers name the exact get_page or entity {name} call and how to reach get_page from the starter tool list; entity called with slug says to pass it as name.
<!-- behavior-change: pointers_name_exact_calls_gbra789 -->
- gbrain setup exits 1, with the failure on stderr, when a requested --notes, --docs or --transcripts import fails or its folder cannot be read; the wiring that finished stays.
<!-- behavior-change: setup_failed_import_exits_nonzero_gbra789 -->
- AGENTS.md, the README and the company-brain tutorial agree on install time: a few minutes, with the measured machine time (about 10 seconds each for the install and setup) stated apart from the time you spend.
