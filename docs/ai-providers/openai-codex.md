# OpenAI Codex — ChatGPT plan GPT-5.5

`openai-codex:gpt-5.5` routes GBrain chat through the ChatGPT/Codex plan
Responses backend instead of the public OpenAI API-key path. It is intentionally
registered as a separate provider from `openai:gpt-5.5` because the auth,
transport, billing, and capability envelope are different.

## Scope

Supported in this first slice:

- Text-generation chat only.
- Forced streaming Responses calls (`stream: true`, `store: false`).
- Plan-billed operator surfaces: public OpenAI API spend is `$0`, but ChatGPT /
  Codex plan quotas and rate limits still apply.
- Offline readiness verification and optional local live smoke.

Not supported yet:

- Embeddings, reranking, query expansion, or structured-output extraction.
- Tool calls, tool-result history, minion/subagent loops, or prompt-cache claims.
- Managed GBrain OAuth/token brokering. Current auth is a read-only local Codex /
  Hermes auth seam plus explicit `OPENAI_CODEX_ACCESS_TOKEN` fallback for tests
  and developer smoke runs.

If a workflow needs tools or minions, keep using a tool-capable provider. The
capability gate classifies `openai-codex:gpt-5.5` as unusable for subagent loops
until a future cycle adds real tool semantics.

## Auth

The provider does **not** use `OPENAI_API_KEY`.

Readiness comes from Codex-plan auth only:

1. Local Codex/Hermes auth state, read synchronously and read-only.
2. `OPENAI_CODEX_ACCESS_TOKEN` for tests/dev smoke paths.

Failures are reported with redacted status strings. Tokens, account IDs, public
OpenAI keys, and bearer headers should never appear in provider output, readiness
JSON, or thrown errors.

## Configure safely

Do **not** flip `models.default` globally unless you deliberately want every
ordinary reasoning route to try Codex text chat and you understand the missing
embedding/tool/subagent surface.

Safer rollout options:

```bash
# Chat-only gateway rollout
gbrain config set chat_model openai-codex:gpt-5.5

# One-off chat provider smoke without changing config
gbrain providers test --touchpoint chat --model openai-codex:gpt-5.5
```

For extraction/takes/minion workflows, verify the command explicitly accepts a
model override and does not require tools, structured output, embeddings, or
subagent loops before pointing it at Codex. The resolver will gate Codex out of
`tier.subagent`, but scoped config is still clearer and less surprising than a
global default flip.

## Verify offline readiness

The mandatory readiness gate is deterministic and does not read private auth
files or call the network:

```bash
gbrain providers verify --model openai-codex:gpt-5.5 --offline
# or via package script
bun run verify:openai-codex
```

The offline gate checks:

- recipe/model identity and allow-listing
- auth redaction with fixture credentials
- forced streaming request shape and non-public Codex Responses route separation
- text-only / no-tools / no-subagent capability guard
- no `OPENAI_API_KEY` fallback
- plan-billed metadata without public API pricing

Expected success ends with:

```text
Result: READY (offline invariants passed).
```

## Optional live smoke

Live smoke is opt-in so CI and unattended checks never depend on private Codex
credentials:

```bash
GBRAIN_OPENAI_CODEX_LIVE=1 \
  gbrain providers verify --model openai-codex:gpt-5.5 --live
```

Live mode first runs the offline gate, then calls the chat provider through
`providers test`. If `GBRAIN_OPENAI_CODEX_LIVE` is unset, live mode exits before
any network/auth probe.

## Billing and quota posture

Provider/budget surfaces label Codex as `plan-billed`:

- Public OpenAI API spend: `$0` for this provider path.
- Public `OPENAI_API_KEY`: ignored.
- ChatGPT/Codex plan quota and rate limits: still apply.
- No per-token public API price is attached to the Codex recipe.

This avoids the bad middle ground where the provider looks like ordinary metered
OpenAI API usage or like unlimited free compute. It is neither.

## Troubleshooting

- `Codex auth unavailable` — local Codex/Hermes auth was not found and
  `OPENAI_CODEX_ACCESS_TOKEN` is unset. Sign in to the Codex CLI / Hermes Codex
  transport, or pass an explicit token for a dev smoke.
- `Live Codex verify is disabled` — set `GBRAIN_OPENAI_CODEX_LIVE=1` before
  running `--live`. Use `--offline` for CI and normal release gates.
- Tool/minion route falls back to another model — expected. Codex is text-only
  in this release.
- `OPENAI_API_KEY` is set but Codex is not ready — expected. Public OpenAI keys
  are ignored for `openai-codex` by design.
