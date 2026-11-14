# Model Routing Convention

Two distinct concerns share this name. Read both — they apply at different
moments.

## 1. gbrain's internal tier system (v0.31.12+)

This is how gbrain itself picks which Claude/OpenAI/Google model runs each
internal task (chat, expansion, synthesis, classification, etc.).

Four tiers:

| Tier | Purpose | Default | Examples |
|---|---|---|---|
| `utility` | fast classification, expansion, verdict, dedup | `claude-haiku-4-5-20251001` | query expansion, facts contradiction classifier, dream triage judge (prefers `models.dream.triage`) |
| `reasoning` | default chat, synthesis, generation | `claude-sonnet-4-6` | gateway chat, dream synthesize, patterns, facts extraction |
| `deep` | slow, expensive reasoning | `claude-opus-4-7` | `gbrain think`, auto-think, cross-modal eval slot B |
| `subagent` | multi-turn tool loop (capability-gated) | `claude-sonnet-4-6` | `gbrain agent run` |

The Default column shows the Anthropic defaults — used when
`ANTHROPIC_API_KEY` is present (Anthropic wins when both keys exist) and kept
as the keyless floor. **Tier defaults are key-aware (v0.46.21+):** when
`OPENAI_API_KEY` is the only chat key, every tier resolves to OpenAI instead —
the newest usable models discovered from your own account (`GET /v1/models`,
priced-only, 24h cache at `<configDir>/model-cache.json`,
`GBRAIN_MODEL_DISCOVERY=off` kill switch), with the openai recipe's ranked
chat list as the offline floor. OpenAI defaults are never pinned to a model
id that can go stale.

Override priority (highest first):

1. CLI flag (`--model opus`)
2. Per-task config (`gbrain config set models.dream.synthesize opus`)
3. Deprecated per-task config (stderr-warns once, then honored)
4. **Tier override** (`gbrain config set models.tier.reasoning opus`) —
   tier-specific beats the generic default (#3873)
5. **Global default** (`gbrain config set models.default opus`) — single hammer
6. Env var (`GBRAIN_MODEL=opus`)
7. Key-aware tier default (the table above; provider chosen by which keys exist)
8. Hardcoded caller fallback

One exception: the dream triage judge pre-reads `models.dream.triage` first —
when that key is set, it wins over this entire chain (`gbrain models` reports
it as the effective route).

File-plane pins are a separate seam: the gateway's boot/reconnect fallback
(and the capability report) resolve the effective chat model as `GBRAIN_MODEL`
env > servable `chat_model` pin in `~/.gbrain/config.json` (honored only while
its provider's key is present; an unservable pin warns once and falls through)
> key-aware tier default. `gbrain init` no longer persists auto-detected chat
pins (v0.46.21+) — only a pin you set yourself survives reconnect.

Power-user recipes:

```bash
# Use opus for everything
gbrain config set models.default opus

# Use opus only for reasoning + deep, keep haiku for utility
gbrain config set models.tier.reasoning opus
gbrain config set models.tier.deep opus

# Custom alias, then use it everywhere
gbrain config set models.aliases.frontier anthropic:claude-opus-4-7
gbrain config set models.default frontier
```

Visibility:

```bash
gbrain models                    # print current routing table
gbrain models doctor             # 1-token probe to each configured model
```

**Subagent tier is isolated because the tool loop has real capability
requirements.** Since v0.38 the loop is provider-agnostic and gated by
capability, not provider: a model without tool calling (or an unrecognized
provider) is refused and falls back to `TIER_DEFAULTS.subagent` with a warn; a
tool-capable provider without prompt caching (e.g. OpenAI) runs the loop hot
with a once-per-model cost warn. Setting `models.default = openai:gpt-5.5` no
longer silently breaks the loop — it runs, at higher per-turn cost. Three
enforcement layers: submit-time guard in `MinionQueue.add`,
`enforceSubagentCapable` in `resolveModel`, doctor `subagent_capability`
check.

When adding a new LLM call, route through `resolveModel()` with a tier —
never hardcode a model string. The v0.31.6 chat default
(`claude-sonnet-4-6-20250929`) was a phantom ID that 404'd the Anthropic
API and made `extractFactsFromTurn` silently return `[]`. The tier system
+ doctor probe is the structural fix for that bug class.

### A model gbrain has no price for

Under default settings an unpriced model (a newly released one, a proxy
route) warns and runs. Under a cost cap the user set, the run stops with
`no_pricing`, because the cap cannot be enforced without a price. The refusal
names the model, provider and kind and the exact registration command. Then:

1. Look up the provider's current price for that model, for example by
   searching the web for its pricing page. A chat model needs USD per 1M input
   tokens and USD per 1M output tokens; an embedding or reranker model needs
   USD per 1M tokens.
2. With a shell on the brain host, run the command the refusal names, such as
   `gbrain pricing set <model> --input <usd> --output <usd> --source <url>`
   (or `--rate <usd>`), then retry. Over MCP you cannot register prices: give
   the command and the price you found to the brain's operator.

Do not register $0 to get past the refusal unless the route really is free:
it makes every call to that model count as free against every cap.

## 2. Subagent spawn routing

When the user-facing agent (Claude in the main session) chooses which model
to spawn a sub-agent on, this table applies. It's about WHERE to send the
work, not what gbrain calls internally.

| Task | Model | Why |
|------|-------|-----|
| Main session / complex instructions | Opus (default) | Best overall quality |
| Signal detection / entity extraction | Sonnet | Fast, cheap, fires every message |
| Research / synthesis | DeepSeek or Qwen | 25-40x cheaper for large context |
| Fast lightweight sub-agents | Groq | 500 tok/s, good for simple tasks |
| Judge tests / quality grading | Haiku | Cheap, good enough for pass/fail |

### Refusal routing

When a model refuses a request:
1. Re-spawn on a different model (don't announce the switch)
2. Fallback chain: primary → DeepSeek → Qwen → Groq
3. Never show the refusal to the user
4. If all models refuse, escalate to the user

### Spawn rules

- 3+ items to process → spawn a sub-agent
- >2 tool calls that don't need real-time judgment → spawn
- Main thread must stay responsive to the user
- Signal detection always spawns (parallel, don't block)
