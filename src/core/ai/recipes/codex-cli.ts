import type { Recipe } from '../types.ts';

/**
 * OpenAI models via the local `codex` CLI binary, using its own ChatGPT login
 * (Plus / Pro / Business / Enterprise seat). No OPENAI_API_KEY needed — the
 * CLI manages its auth state and the gateway dispatches via `codex exec`.
 *
 * The OpenAI counterpart of `claude-cli` (#334): subscribers who already pay
 * for Codex can point gbrain's chat / subagent / expansion tiers at their
 * seat instead of a metered API key. The recipe sits alongside `openai` so
 * users pick per call: `openai:gpt-5.6-luna` (API key, per-token) vs
 * `codex-cli:gpt-5.6-luna` (ChatGPT login, plan quota).
 *
 * Model ids are whatever the account's Codex model catalog lists; the list
 * below is informational (native tier: assertTouchpoint only checks that the
 * touchpoint exists) and ordered fast → deep so `providers explain` / init
 * auto-pick advertise the cheapest first. Reasoning effort rides on the id as
 * an optional `@<effort>` suffix — `codex-cli:gpt-5.6-luna@low` for the
 * utility tier, `codex-cli:gpt-6-astra@high` for deep work — so one recipe
 * serves both "fast stuff" and careful synthesis. Effort vocabulary is the
 * CLI's (`minimal|low|medium|high|xhigh`, plus model-dependent `max`/`ultra`)
 * and is validated by the CLI against the live catalog, not by this file.
 *
 * Chat + expansion; no embedding (Codex exposes no embedding endpoint). Pair
 * with openai/google/voyage/ollama for embeddings as the `anthropic` and
 * `claude-cli` recipes document.
 *
 * Auth: `auth_env.required: []` because the CLI handles auth itself. The
 * `codex` binary on PATH (or GBRAIN_CODEX_CLI_BIN) IS the auth surface.
 *
 * Quota semantics differ from an API key: a ChatGPT plan meters Codex in
 * rolling windows, and the CLI reports exhaustion as a `turn.failed` with a
 * "usage limit" message, which the adapter surfaces as apiErrorStatus 429 so
 * the gateway's existing rate-limit handling applies. Bulk backfills should
 * stay on a metered provider; nightly cycles and interactive `think` fit.
 */
export const codexCli: Recipe = {
  id: 'codex-cli',
  name: 'OpenAI (via Codex CLI)',
  tier: 'native',
  implementation: 'codex-cli',
  // The CLI owns auth; no env vars are required from the gateway side.
  auth_env: {
    required: [],
  },
  touchpoints: {
    // No embedding touchpoint — Codex exposes no embedding endpoint.
    expansion: {
      // Cheap/fast model first (same convention as the openai and claude-cli
      // recipes): this is what `providers explain` and init auto-pick advertise.
      models: [
        'gpt-5.6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.5',
        'gpt-6-astra',
      ],
      // Nominal — the subscription bears the actual bill (see chat below).
      cost_per_1m_tokens_usd: 1.0,
      price_last_verified: '2026-09-22',
      // Subprocess cold start (CLI boot + catalog fetch + login refresh) is
      // several seconds before the first token; a flat 5000ms probe would
      // false-fail like it did for claude-cli.
      default_timeout_ms: 45_000,
    },
    chat: {
      models: [
        'gpt-5.6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.5',
        'gpt-6-astra',
      ],
      supports_tools: true,
      // Tool use rides the shared <use_tools> text protocol
      // (providers/cli-tool-protocol.ts) with gbrain-minted ids, exactly as
      // claude-cli does; the loop never depends on model-authored ids.
      supports_subagent_loop: true,
      // Unmeasured, so fail closed. OpenAI applies server-side prefix caching
      // to the Responses API, but every `codex exec` here is a fresh
      // --ephemeral thread and whether the backend reuses a prefix across
      // those subprocesses has not been measured the way claude-cli's was
      // (test/ai/recipe-claude-cli-prompt-cache.test.ts). Declaring `false`
      // only costs the degraded:no_caching advisory on the subagent loop;
      // flip to `true` with a measurement, and add the id to ALWAYS_CACHES
      // in test/ai/gateway-chat.test.ts.
      supports_prompt_cache: false,
      // Catalog reports 272k for the current gpt-5.x/6 family.
      max_context_tokens: 272000,
      // Cost figures are nominal placeholders for the budget ledger; the
      // actual bill is the ChatGPT plan. Operators on a flat-rate seat can
      // treat them as accounting units, not dollars.
      cost_per_1m_input_usd: 1.0,
      cost_per_1m_output_usd: 4.0,
      price_last_verified: '2026-09-22',
      default_timeout_ms: 45_000,
    },
  },
  // Friendly aliases so tier configs read naturally. Reverse aliases rewrite
  // legacy ids back to canonical.
  aliases: {
    'luna': 'gpt-5.6-luna',
    'sol': 'gpt-5.6-sol',
    'terra': 'gpt-5.6-terra',
    'astra': 'gpt-6-astra',
  },
  setup_hint:
    'Install the Codex CLI (`npm i -g @openai/codex`) and run `codex login` once. ' +
    'Set GBRAIN_CODEX_CLI_BIN if the binary is not on PATH. Pin reasoning per model with ' +
    '`codex-cli:<model>@<effort>` (e.g. `codex-cli:gpt-5.6-luna@low`), or set ' +
    'GBRAIN_CODEX_CLI_REASONING_EFFORT for a default.',
};
