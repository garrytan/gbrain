**The skill resolver now finds skills by meaning in Claude Code and Codex when your brain has an embedding model, and sends each message to that embedding provider to do it.**

<!-- behavior-change: skill_resolver_vectors_gst3568 -->

### Added
- Skill vectors: `gbrain skills index build` stores one vector per skill made with the brain's own embedding model (Voyage, OpenAI or Google) beside the index, for Claude Code, Codex and harness-less catalogs in user scope. Each turn embeds the message and fuses the meaning ranking with the word ranking, so a request that shares no word with the skill it needs ("can we go live today?") still finds it. On the development half of a private routing benchmark, voyage-4 found the right skill for 310 of 590 requests against 283 with words alone, and gave 165 of 414 no-skill requests a block against 184.
- A per-model cosine floor decides when a meaning match is good enough and replaces `top_gate` as the no-skill gate for catalogs with vectors. A model with no measured floor gets no vectors.
- `gbrain skills resolve --json` and the hook lane log report whether a turn used vectors and, when it fell back to words, why (`vectors.fallback.code`); the build receipt reports `vectors`.

### Changed
- When the brain has an embedding model, each Claude Code and Codex message is sent to that provider to be embedded, and each build sends the skills' text once. Every failure (no key, timeout, provider error, a changed model) answers with the word matcher's exact output. The Claude Code hook waits at most 1.5 seconds and Codex 2 seconds, counting the embedding.
