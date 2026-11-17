**The query facts block now shows a later retraction right after the fact it calls off.**

<!-- behavior-change: facts_block_retractions_gbra574 -->

### Added
- When the facts block shows a fact about a person or company, a later fact about the same entity that retracts it or calls it off ("retracted", "scratch that", "I was wrong", "cancelled", "called off", "fell through", "never happened", "just a rumour" and similar) follows it, with its own date header, inside the block's usual share of the token budget and row count. The later fact pairs only when it is dated after the fact, its cue is not negated ("not cancelled", "wasn't called off" and "isn't a rumour" never pair), and it carries the same slot (dimension and value) or, leaving out the entity's name and the cue words, every word it has is in the fact or it shares at least two words with it. It is read under the caller's read policy, so a retraction a remote caller or another member cannot read never appears, and a forgotten or withdrawn fact never appears. No model call; a question with no such later fact gets exactly the block it got before.
