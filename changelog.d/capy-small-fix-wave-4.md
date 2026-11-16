**Three fixes from outside bug reports: retired atoms keep their trust tier, a provider answer that cannot be parsed is no longer retried, and doctor stops recommending a sync that refuses a source.**

### Fixed
- An atom a re-extraction retires keeps the trust tier and write origin its extraction gave it, and comes back at that tier when a later extraction produces it again. It used to be stored as `unknown` with no origin, and a revived atom stayed `unknown`. Every derived retirement (chronicle events, synthesis outputs, `gbrain repair stale-atoms`) now stamps its pages this way. Reported and first fixed by @howardpark (#9456).
- A model provider that answers with a success status and a body that is not one JSON document now fails with the non-retryable code `provider_response_unparseable`. A facts job that hits it ends on its first attempt instead of paying for the same failing call again, `gbrain facts retry-dead` leaves it alone, and its recorded error names the parse failure without keeping any response text. Reported by @haumanto and first fixed by @Masashi-Ono0611 (#9466).
- `gbrain doctor`'s `sync_freshness` no longer fails a source whose folder sits inside gbrain's own content directory, and no longer tells you to run `gbrain sync` for it, which refuses such a source with `sync_not_applicable`. It counts the source as a content directory and names `gbrain import <dir> --source <id>` instead. Reported by @railsloes and first fixed by @Masashi-Ono0611 (#9471).

<!-- behavior-change: atom_retirement_keeps_tier_9456 -->
<!-- behavior-change: provider_response_unparseable_9466 -->
<!-- behavior-change: sync_freshness_content_directory_9471 -->
