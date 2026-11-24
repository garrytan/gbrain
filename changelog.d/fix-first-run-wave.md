**First-run fixes: setup's summary arrives whole, keyless brains stop showing false warnings, and next-step hints name commands that work.**

### Fixed
- gbrain setup and gbrain init relay their whole first-run summary to the user instead of cutting it at 1,000 characters.
<!-- behavior-change: show_user_relay_whole_gbra789 -->
- Search and query on a brain with embeddings off on purpose no longer report pages "held from embedding" as degraded coverage or point at gbrain embed --held.
<!-- behavior-change: keyless_no_embedding_held_notice_gbra789 -->
- gbrain transcripts ingest suggests gbrain get <slug> for the page it wrote instead of a query for the slug string.
<!-- behavior-change: transcripts_try_it_get_gbra789 -->
