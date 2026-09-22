# nous — the `nous` recipe (Nous Research Portal inference API)

This page documents the `nous` recipe as it ships. The implementation lives at
`src/core/ai/recipes/nous.ts`; the `nous_api_key` config slot is wired through
`src/core/config.ts`, `src/core/ai/provider-env.ts`, `src/commands/config.ts`
and `src/core/config-db-merge.ts` like every other provider key.

The [Nous Research Portal](https://portal.nousresearch.com) is the inference
API behind Hermes Agent's `nous` provider and the Nous subscription. It is an
OpenAI-compatible gateway at `https://inference-api.nousresearch.com/v1` that
fronts ~400 models from OpenAI, Anthropic, Google, Z.ai, DeepSeek, Qwen,
Mistral, xAI and Voyage under vendor-prefixed ids — the same id namespace and
`/models` catalog shape as OpenRouter — with the Portal's own per-model
pricing. If you already pay for Hermes, this recipe lets gbrain's chat,
subagent, expansion and embedding tiers bill the same subscription.

## Setup

1. Create an **inference API key** in the Portal dashboard
   ([API Docs](https://portal.nousresearch.com/api-docs)); keys look like
   `sk-nous-…`.

2. Give it to gbrain. Prefer the config slot so daemon, launchd and MCP
   processes that do not inherit your shell env receive it too:

   ```bash
   gbrain config set nous_api_key sk-nous-...
   # or, shell-only:
   export NOUS_API_KEY=sk-nous-...
   ```

3. Point tiers at Portal models:

   ```bash
   gbrain config set models.tier.utility   nous:z-ai/glm-5.3-flash
   gbrain config set models.tier.reasoning nous:openai/gpt-5.6-terra
   gbrain config set models.tier.subagent  nous:z-ai/glm-5.3-flash
   gbrain config set embedding_model       nous:openai/text-embedding-3-small
   ```

   Any id the Portal routes works — the recipe's lists are curated entry
   points (verified against the live catalog on 2026-09-22), not an
   allowlist. Aliases: `nous:glm-flash`, `nous:glm`, `nous:luna`,
   `nous:terra`, `nous:astra`, `nous:haiku`, `nous:sonnet`, `nous:opus`.

4. Optional: `provider_base_urls.nous` overrides the inference URL — for
   example to point at Hermes Agent's local **subscription proxy**
   (`hermes-agent` docs → *subscription-proxy*), which attaches and refreshes
   your Portal OAuth credential so no static key is needed. The proxy ignores
   the bearer gbrain sends, so any placeholder `NOUS_API_KEY` satisfies the
   recipe's `auth_env.required`.

## What the recipe declares

| Touchpoint | Declared | Notes |
| --- | --- | --- |
| `chat` | yes | `supports_tools`, `supports_subagent_loop: true` — every chat model in the catalog advertises `tools`, and Hermes Agent drives its tool loop through this endpoint in production |
| `expansion` | yes | same routed endpoint; cheap ids first (`z-ai/glm-5.3-flash`, `openai/gpt-5.6-luna`, …) |
| `embedding` | yes | `openai/text-embedding-3-small` 1536, `-3-large` 3072, `voyageai/voyage-4` / `-4-large` 1024; unlisted ids resolve to 0 dims and require an explicit `embedding_dimensions` (fail closed, #4114) |
| `reranker` | no | |

Family-scoped predicates, keyed on the id prefix exactly as the `openrouter`
recipe does:

- **`thinking_by_default`** — `deepseek/*` and `z-ai/glm-4.5+` / `glm-5.x`
  reason by default and bill reasoning as output tokens. Declaring it gives
  `think` and the subagent loop their thinking output headroom (16K / 32K)
  instead of the 4K non-thinking cap (#4172, #4727).
- **`supports_prompt_cache`** — `openai/*` per the openai recipe's generation
  table, `deepseek/*` always. `anthropic/*` is declared **false** here:
  Anthropic caching needs the explicit `cache_control` block that the
  openrouter compat shim rewrites in, and this recipe does not ship that shim.
- **DeepSeek `reasoning_content` promotion** — the same fail-open compat fetch
  the `deepseek` and `openrouter` recipes use, so a pure-reasoning DeepSeek
  turn does not read as an empty answer. Inert for other families.

Prices in the recipe are the `z-ai/glm-5.3-flash` Portal rates on the
verification date ($0.09 / $0.28 per 1M) for the budget ledger's per-call
estimate; override per model with `pricing.overrides` if you run something
else as the default.

## Constraints

- **Static key only.** The Portal's OAuth device flow (what the Hermes CLI
  uses) is not implemented — gbrain recipes hold static credentials. Use a
  Portal inference key, or Hermes's subscription proxy (above) for the OAuth
  path.
- **Tier limits are shared.** A Portal tier's RPM/TPM limits apply across
  everything that uses the subscription — Hermes included. A bulk backfill
  (a cold-corpus dream drain, thousands of atom extractions) on the same sub
  that runs your agent will starve one of them; stage it or use a metered
  provider for the drain.
- **No attribution headers, no per-request routing hints.** Unlike
  OpenRouter there is nothing to send; the Portal picks the upstream.
- **Catalog drift.** The curated lists are a snapshot. `curl
  https://inference-api.nousresearch.com/v1/models` is public and returns the
  current allowlist with pricing.

## Troubleshooting

- **`Unauthorized` (401)** — the key is wrong or revoked. The Portal answers
  `402 Payment Required` to a request with no bearer at all, so 401 means a
  bearer was sent and rejected: check `gbrain config show` (redacted) or the
  `NOUS_API_KEY` the process actually sees.
- **`402 Payment Required`** — no key reached the request. On a launchd /
  MCP process this is the config-plane gap: set `nous_api_key` in
  config.json rather than relying on your shell's `export`.
- **Rate-limit errors during a dream cycle** — the tier limit is shared with
  Hermes; see Constraints.
- **`embedding_dimensions` required** — the embedding id is not in the
  recipe's `model_dims` table. Look its width up in the vendor's docs and set
  `gbrain config set embedding_dimensions <N>`.
