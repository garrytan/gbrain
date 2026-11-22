**The skill resolver's model picker (opt-in) now works with Claude Opus, Sonnet and Fable 5.x and with GPT-6.x Sol and Astra.**

### Fixed
- Picking with Claude Opus, Sonnet or Fable 5.x no longer fails every call: these models can't turn thinking off, so the picker asks for adaptive thinking at low effort. Haiku and older Claude models keep thinking off.
- Picking with GPT-6.1 or 6.2 Sol, or a GPT-6.x Astra model, no longer fails every call: these models refuse reasoning effort `none`, so the picker asks for `low`. GPT-6 Luna and the other models that accept `none` keep it.
- `openai:gpt-6.2-sol` has a price, so the picker's daily cap can meter it.
- A `compat:` model can name its cached-input price as a third value of `skills.resolver.router_usd_per_mtok`, so cached input no longer counts at the full input rate against the daily cap.
