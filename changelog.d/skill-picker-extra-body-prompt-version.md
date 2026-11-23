**Your own skill-picker model can get extra request fields, such as reasoning turned off, and a pinned prompt version, so the picker switches itself off when gbrain's picker prompt changes.**

### Added
- `skills.resolver.router_extra_body`: an optional JSON object of at most 4,096 bytes added to each request sent to a `compat:` picker model, for example `gbrain config set skills.resolver.router_extra_body '{"reasoning_effort": "none"}'`. It cannot set `model`, `messages`, `stream`, `n` or the token limits; set for a model that is not `compat:`, the picker stays off for the turn with `config_invalid`.
- `skills.resolver.router_prompt_version`: for a model trained on the picker's request, the prompt version it learned. Each catalog's `picker.json` now records the version gbrain sends as `prompt_version`, and when the two differ the picker makes no call and reports `config_invalid`, so the word matcher answers instead.
