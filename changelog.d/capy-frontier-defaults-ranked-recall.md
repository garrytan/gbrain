**With no model configured, gbrain now uses the newest Claude and GPT models; recall ranks saved facts by your query; a fact saved without a date no longer shows up as a recent event; and re-extracting a conversation keeps its old facts as history.**

<!-- behavior-change: tier_defaults_frontier_9609 -->
<!-- behavior-change: recall_query_ranks_facts_10225 -->
<!-- behavior-change: conversation_facts_expire_10443 -->
<!-- behavior-change: forget_read_only_mirror_10067 -->
<!-- behavior-change: facts_unknown_event_date_10288 -->

### Changed
- The built-in model defaults name the newest model in each family. That means claude-haiku-5-5 for the utility tier and query expansion, claude-sonnet-5-5 for the reasoning and subagent tiers and the default chat model, and claude-opus-5-5 for the deep tier. The `opus`, `sonnet` and `haiku` aliases follow, and so do `book-mirror`, fact extraction, brainstorm and the synthesize verdict model. On an OpenAI-only brain the tiers come from the gpt-6 family (utility gpt-6-luna, the rest gpt-6.2-sol) when the account lists it. A model you set yourself is unchanged. The nightly relationship check now proposes closures instead of writing them when it runs on the default utility model, because claude-haiku-5-5 is not yet certified for apply mode; a certified model or an explicit `dream.edge_contradictions.mode apply` keeps writing them. claude-sonnet-5-5 is a thinking model, so a subagent turn may write up to 32,000 output tokens (was 8,192); with `dream.synthesize.mode agentic` and the default $5 cap, raise `dream.synthesize.budget_usd` or set `agent.max_output_tokens`. Contextual retrieval's page synopses keep claude-haiku-4-5, because that model decides whether existing embeddings can be reused. (#9609)
- `recall` with `query` and no fact selector ranks saved facts by relevance to the query and says `facts_order: relevance`, instead of returning the newest facts whatever was asked. A fact that contains every word of the query is always kept. The `recall_hint` notice is gone. (#10225)

### Fixed
- A fact saved without an event date (`gbrain remember` without `--valid-from`, `extract_facts` without a date, or a `## Facts` row with an empty date cell on a page that states no date) now stores the event date as unknown instead of the save time. Recall returns it with `valid_from: null` and keeps the save time in `created_at`. (#10288)
- An event-time window (`recall --since`, the recall tool's `since` and search's fact pool) only matches facts with a known event date. General and entity recall still return undated facts, ordered by save time. `recall --today` and `--since-last-run` still show undated facts saved in their window, locally and on a thin client; the recall tool's new optional `include_undated` parameter widens a `since` window the same way, and an older server ignores it with a warning. Trajectories and same-metric supersession treat an undated claim as dated at its save time. (#10288)
- Schema migration v339 lets `facts.valid_from` be empty. Nothing is rewritten on upgrade, so facts saved before it keep the save time they were stamped with. (#10288)
- Re-extracting a conversation page's facts (`extract-conversation-facts --force`, or a newer extractor) expires the previous facts instead of deleting them, so a claim the new pass did not reproduce stays in history. (#10443)
- `forget` on a read-only mirror with no canonical owner now says the source is a read-only mirror (`detail: read_only_mirror`) and names the two ways forward. Remove the claim upstream and run `gbrain sync --source <id>` (`gbrain sources refresh <id>` on a managed brain), or make the source writable and bind it. (#10067)

### Known limits
- A Rust-engine brain still stamps the save time on an undated fact until its store format can hold an empty event date.

Reported by @OpenMindUA (#9609), @arjmad (#10225), @onchito-walks (#10443), @Kkkkkuro (#10288) and @jr-oaks1 (#10067). #10297 by @Kkkkkuro was a first fix for #10288. #10229 by @codingfeng-fufu proposed refusing query-only recall; this ranks it instead.
