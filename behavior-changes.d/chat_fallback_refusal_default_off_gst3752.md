---
kind: default
---
chat_fallback_on_refusal now defaults to false. If you set a chat_fallback_chain, a request that one model refused on safety grounds (a refusal or content-filter stop, or a provider content block such as a content-policy 400) now comes back to the caller as that refusal instead of being sent to the next model in the chain. Errors still fall back exactly as before: rate and subscription limits, outages, timeouts and rejected keys move to the next model. An explicit true is kept wherever it is set (GBRAIN_CHAT_FALLBACK_ON_REFUSAL, config.json or the brain database). To send refused requests to the next model again, run gbrain config set chat_fallback_on_refusal true. A brain with no chat_fallback_chain is not affected.
