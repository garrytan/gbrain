**With no model configured, gbrain now uses the newest Claude and GPT models, recall ranks saved facts by your query, and re-extracting a conversation keeps its old facts as history.**

<!-- behavior-change: tier_defaults_frontier_9609 -->
<!-- behavior-change: recall_query_ranks_facts_10225 -->
<!-- behavior-change: conversation_facts_expire_10443 -->
<!-- behavior-change: forget_read_only_mirror_10067 -->

### Changed
- The built-in model defaults name the newest model in each family: claude-haiku-5-5 for the utility tier and query expansion, claude-sonnet-5-5 for the reasoning and subagent tiers and the default chat model, and claude-opus-5-5 for the deep tier. The `opus`, `sonnet` and `haiku` aliases follow, and so do `book-mirror`, fact extraction, brainstorm and the synthesize verdict model. On an OpenAI-only brain the tiers come from the gpt-6 family (utility gpt-6-luna, the rest gpt-6.2-sol) when the account lists it. A model you set yourself is unchanged. Contextual retrieval's page synopses keep claude-haiku-4-5, because that model decides whether existing embeddings can be reused. (#9609)
- `recall` with `query` and no fact selector ranks saved facts by relevance to the query and says `facts_order: relevance`, instead of returning the newest facts whatever was asked. The `recall_hint` notice is gone. (#10225)

### Fixed
- Re-extracting a conversation page's facts (`extract-conversation-facts --force`, or a newer extractor) expires the previous facts instead of deleting them, so a claim the new pass did not reproduce stays in history. (#10443)
- `forget` on a read-only mirror with no canonical owner now says the source is a read-only mirror (`detail: read_only_mirror`) and names the two ways forward: remove the claim upstream and run `gbrain sources refresh <id>`, or make the source writable and bind it. (#10067)

Reported by @OpenMindUA (#9609), @arjmad (#10225), @onchito-walks (#10443) and @jr-oaks1 (#10067). #10229 by @codingfeng-fufu proposed refusing query-only recall; this ranks it instead.
