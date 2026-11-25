**A request one model refuses is no longer sent to the next model in your chat fallback chain unless you turn that on.**

### Changed
- `chat_fallback_on_refusal` now defaults to false on every config plane (environment, `config.json`, brain database). With a `chat_fallback_chain` set, a refusal or content-filter stop, or a provider content block, comes back to the caller instead of going to another provider. Errors (rate and subscription limits, outages, timeouts, rejected keys) still fall back as before, and an explicit `true` anywhere is kept. `gbrain config set chat_fallback_on_refusal true` turns refusal fallback back on.
- `gbrain doctor --only chat_fallback_chain` says when refusal fallback is off by default and names the command that turns it on.

<!-- behavior-change: chat_fallback_refusal_default_off_gst3752 -->
