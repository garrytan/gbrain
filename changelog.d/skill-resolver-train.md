**The skill resolver can ask a model which skill a message needs (opt-in, off by default), and long sessions keep getting skill suggestions.**

### Added
- `gbrain config set skills.resolver.router true` turns on the model picker: Claude Haiku 5.5 (or GPT-6 Luna, or Gemini 3.5 Flash-Lite, by which key you have) reads your skill list and picks the skills a message needs, or none, so a request phrased in the user's own words still finds the right skill. It runs only from `gbrain skills resolve` and the Claude Code and Codex hooks, waits at most 1.5 seconds in Claude Code (2 seconds elsewhere), and spends at most $0.50 a day by default (`skills.resolver.router_max_usd_per_day`). When it can't answer in time, has no key or hits the cap, the turn is the word matcher's, unchanged, and `router.fallback.code` says why.
- A model of your own (self-hosted or fine-tuned) plugs in as `router_model compat:<model id>` on any OpenAI-compatible endpoint, with `router_base_url`, the key's environment variable name in `router_api_key_env`, and its price in `router_usd_per_mtok` so the daily cap still holds.
- `gbrain doctor` shows the last 24 hours of picker turns, fallbacks by reason and today's spend, and warns when one reason dominates. `gbrain setup claude-code` and `codex` print the one line that turns it on when a model key is configured.
- The picker also works with larger models: Claude Opus 5.5 and Fable 5.1 and 5.2 pick with adaptive thinking at low effort, Sonnet 5.5 with thinking off the way it allows (`between_tools`), and GPT-6.1 Sol, GPT-6.2 Sol, GPT-6 Astra and GPT-6.2 Astra with reasoning effort `low` (they refuse `none`). Models that reason first get 1,024 output tokens so the answer has room after the thinking. `anthropic:claude-fable-5-2`, `openai:gpt-6.2-sol`, `openai:gpt-6-astra` and `openai:gpt-6.2-astra` have prices so the daily cap can meter them; the OpenAI ones stay out of automatic model discovery. Larger models pick better but slower: Opus took about 1.2 seconds at the median, Fable 5.2 about 3 seconds in one check.
- A `compat:` model can name its cached-input price as a third value of `router_usd_per_mtok`, so cached input doesn't count at the full input rate against the daily cap.
- Each `gbrain skills index build` writes `picker.json` (skill ids and descriptions) beside the index. Installs that leave the picker off behave exactly as before, and nothing leaves the machine.

### Changed
- `skills.resolver.session_token_budget` defaults to 8,000. At 2,000 a session's budget ran out around turn 20, and after that the right skill showed on 5 of 143 later turns in Claude Code (1 of 143 in Codex) in the skill bench's session replay; at 8,000 the budget lasted all 30 turns and the right skill showed on 41 and 26 of 143. Set it back with `gbrain config set skills.resolver.session_token_budget 2000`.

### Fixed
- In Claude Code the picker waits at most 2 seconds, even when `skills.resolver.router_timeout_ms` asks for more, so a turn never stalls past the hook's budget.
- A request the provider itself refuses (an HTTP 4xx from Anthropic, OpenAI or Google) doesn't count against the daily cap. Through a proxy (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GENERATIVE_AI_BASE_URL`) or a `compat:` endpoint it still counts, since that endpoint may bill it.
- When no skill shares a word with the message in a large catalog, the picker makes no call and the turn reports no fallback.
- `gbrain doctor` warns when the cap is below one call's largest cost (every call refused, nothing spent), forgets an old refusal or setup problem once `config.json` changes, proposes a cap raise of at most 100 USD, and its fixes say what to do instead of only pointing at `gbrain config get`.

<!-- behavior-change: skill_resolver_session_budget_8000_gst3459 -->
