**A capped embedding run can no longer spend past its cap, and an embedding job you approved with `--max-usd` now stops at that amount.**

### Fixed
- `gbrain jobs submit embed|embed-backfill|embed-catch-up --max-usd <usd>` asked for your approval and then dropped it: the queued job ran under only the backfill's own $10 default, or with no cap at all under `spend.posture=tokenmax` or `embed.backfill_max_usd off`. The approval is now stored on the job and the worker enforces it, the same way `jobs submit enrich` already worked.
- Under a dollar cap (`--max-usd`, `embed.backfill_max_usd`, the maintenance daily cap), each embedding request was let through on a character-count estimate of its tokens. Dense text such as Chinese bills several times more tokens than that, so one request could carry the run past its cap. Each provider request is now admitted on its own at the most input it can bill (one token per UTF-8 byte, capped per input by the model's input limit) and settled to the tokens the provider reports. When the provider reports nothing, or a request failed in a way that may still have billed, the full hold stays charged instead of the smaller estimate.
- Under a cap, a request the AI SDK would split into several (more inputs than the provider takes per call) is sent as separate requests, each admitted on its own, and the SDK's hidden retries are off, since each would be another billable attempt against one hold. gbrain's own rate-limit retries already admit every attempt again.
- Voyage and Perplexity responses whose usage omits `total_tokens` were rewritten to report zero tokens, so a queued job's spend meter settled those requests at $0. They now count as unknown usage and keep their reserved cost.

Reported and first fixed by @jack60612. Supersedes #10581.

<!-- behavior-change: embedding_job_approval_and_request_holds -->
