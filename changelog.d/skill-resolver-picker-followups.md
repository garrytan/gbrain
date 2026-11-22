**The skill resolver's model picker (opt-in) waits less, charges failed calls more fairly, and doctor's warnings about it are more accurate.**

### Fixed
- In Claude Code the picker now waits at most 2 seconds, even when `skills.resolver.router_timeout_ms` asks for more, so a turn never stalls past the hook's budget.
- A request the provider itself refuses (an HTTP 4xx from Anthropic, OpenAI or Google) no longer counts against the daily cap. Through a proxy (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GENERATIVE_AI_BASE_URL`) or a `compat:` endpoint it still counts, since that endpoint may bill it.
- When no skill shares a word with the message in a large catalog, the picker makes no call and the turn reports no fallback.
- `gbrain doctor` warns when the cap is below one call's largest cost (every call refused, nothing spent), forgets an old refusal or setup problem once `config.json` changes, proposes a cap raise of at most 100 USD, and its fixes say what to do instead of only pointing at `gbrain config get`.
