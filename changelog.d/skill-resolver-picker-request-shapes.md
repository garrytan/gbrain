**The skill resolver's model picker (opt-in) now works with Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and 5.2, and with GPT-6.1 Sol, GPT-6.2 Sol, GPT-6 Astra and GPT-6.2 Astra.**

### Fixed
- Picking with Claude Opus 5.5 or Fable 5.x no longer fails every call: these models can't turn thinking off, so the picker asks for adaptive thinking at low effort and leaves 1,024 output tokens so the thinking can't crowd out the answer. Sonnet 5.5 picks with thinking switched off the way it allows (`between_tools`). Haiku and older Claude models keep thinking off.
- Picking with GPT-6.1 Sol, GPT-6.2 Sol or a GPT-6.x Astra model no longer fails every call: these models refuse reasoning effort `none`, so the picker asks for `low`, with the same 1,024-token room. GPT-6 Luna and the other models that accept `none` keep it.
- `anthropic:claude-fable-5-2`, `openai:gpt-6.2-sol`, `openai:gpt-6-astra` and `openai:gpt-6.2-astra` have prices, so the picker's daily cap can meter them. The OpenAI ones stay out of automatic model discovery, which also stops reporting them as missing a price.
- A `compat:` model can name its cached-input price as a third value of `skills.resolver.router_usd_per_mtok`, so cached input no longer counts at the full input rate against the daily cap.
