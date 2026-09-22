# codex-cli — the `codex-cli` recipe (routes chat/toolLoop through the local `codex` CLI)

This page documents the `codex-cli` recipe as it ships. The implementation
lives at `src/core/ai/recipes/codex-cli.ts` and
`src/core/ai/providers/codex-cli-language-model.ts`; the in-band tool protocol
it shares with `claude-cli` is `src/core/ai/providers/cli-tool-protocol.ts`.

`codex-cli` routes `gateway.chat()` and `gateway.toolLoop()` through the
locally installed [Codex CLI](https://developers.openai.com/codex) in
non-interactive `codex exec` mode, using the CLI's own **ChatGPT login**
(Plus / Pro / Business / Enterprise seat). No `OPENAI_API_KEY` is involved.
It is the OpenAI counterpart of [`claude-cli`](claude-cli.md): same shape,
same reasons to want it.

`codex-cli:gpt-5.6-luna` resolves to `CodexCliLanguageModel` (subprocess,
`doGenerate` only, no streaming). The recipe declares `chat` and `expansion`
touchpoints — no embedding, Codex exposes no embedding endpoint — so a brain
whose utility or reasoning tier points at `codex-cli:` keeps query expansion
and pairs with `openai` / `google` / `voyage` / `ollama` for embeddings.

## Setup

1. Install the Codex CLI and log in once:

   ```bash
   npm i -g @openai/codex
   codex login          # opens the ChatGPT sign-in; `codex login status` to check
   ```

2. Point a model tier (or any per-call model string) at `codex-cli:`:

   ```bash
   gbrain config set models.tier.utility   codex-cli:gpt-5.6-luna@low
   gbrain config set models.tier.reasoning codex-cli:gpt-5.6-terra
   gbrain config set models.tier.deep      codex-cli:gpt-6-astra@high
   gbrain config set models.tier.subagent  codex-cli:gpt-5.6-luna
   ```

   Any model id the account's Codex catalog lists works — the recipe's list
   (`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-6-astra`)
   is informational and ordered fast → deep. Short aliases: `codex-cli:luna`,
   `codex-cli:sol`, `codex-cli:terra`, `codex-cli:astra`.

3. Optional environment:

   - `GBRAIN_CODEX_CLI_BIN` — path to the `codex` binary when it is not on
     PATH (trusted exec-target variable; see `src/core/env-trust.ts`).
   - `GBRAIN_CODEX_CLI_REASONING_EFFORT` — default reasoning effort for model
     ids that carry no `@effort` suffix.

## Reasoning effort: `@<effort>` on the model id

The point of a subscription lane is that "fast stuff" and careful work cost
the same, so the recipe lets each tier choose how hard the model thinks
without a second provider:

| Model string | Effect |
| --- | --- |
| `codex-cli:gpt-5.6-luna` | CLI/catalog default effort for that model |
| `codex-cli:gpt-5.6-luna@low` | `-c model_reasoning_effort="low"` |
| `codex-cli:gpt-6-astra@xhigh` | `-c model_reasoning_effort="xhigh"` |

The effort vocabulary is the CLI's: `minimal | low | medium | high | xhigh`,
plus `max` / `ultra` on models whose catalog entry lists them. The suffix is
passed through verbatim and validated by the CLI against the live catalog —
a hard-coded allowlist here would reject levels a newer model legitimately
supports. `parseCodexModelId` splits on the LAST `@`; a leading or trailing
`@` is not treated as a suffix.

## What actually happens on a call

1. `renderPrompt` flattens the ai-sdk message array: system messages become
   one system text, prior tool calls/results replay as `[tool_use …]` /
   `[tool_result …]` placeholders. When tools are registered,
   `buildToolUseInstructions` appends the `<use_tools>[{name,input}]
   </use_tools>` protocol block.
2. The adapter spawns `codex exec` with the prompt on **stdin** (`-`), so
   long system prompts never hit argv limits or appear in `ps`. Codex has no
   separate system-prompt channel in exec mode; the system text leads the
   stdin prompt inside a `<system>…</system>` fence.
3. Isolation flags make the subprocess behave like a raw model, not a coding
   agent on your machine:

   | Flag | Why |
   | --- | --- |
   | `--ephemeral` | no session rollout under `$CODEX_HOME/sessions`, so transcript discovery never re-ingests gbrain's own calls (the #4472 class `claude-cli` needed a scratch-dir fingerprint for) |
   | `--ignore-user-config` | no `config.toml`: no MCP servers (gbrain's own MCP would recurse into the brain), hooks, plugins, project trust |
   | `--ignore-rules` | no execpolicy rules |
   | `--skip-git-repo-check` + `-C <empty tmpdir>` | no `AGENTS.md` discovery |
   | `--sandbox read-only` | floor, even if a tool slipped through |
   | `--disable shell_tool / multi_agent / apps / browser_use / computer_use / plugins / memories` | every built-in tool surface off |
   | `-c web_search="disabled"`, `-c tools.view_image=false` | remaining tools off |
   | `-c skills.max_context_tokens=1` | the skills catalog under `$CODEX_HOME/skills` loads regardless of config; the minimum budget drops every description from the prompt (see the notice below) |
   | `-c hide_agent_reasoning=true`, `-c model_reasoning_summary="none"` | small JSONL; reasoning is dropped on replay anyway |
   | `-c preferred_auth_method="chatgpt"` | subscription auth even if an API key were reachable |

4. Env scrub: `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `CODEX_API_KEY` are
   removed from the child's environment. Subscription-only is the recipe's
   contract — an API key in gbrain's env (the setup this recipe replaces)
   must never silently flip billing to per-token usage or re-route the
   endpoint.
5. Output: `--json` JSONL on stdout plus `--output-last-message <file>`.
   The file is the primary text source (exact bytes, no event reassembly);
   the events supply usage (`turn.completed`) and failures (`turn.failed`,
   `error`). The `<use_tools>` block, if any, is parsed back into ai-sdk
   `tool-call` parts with gbrain-minted ids (`toolu_codex_cli_<uuidv7>`) —
   never model-authored (#4155).

### The skills-budget notice is not a failure

With the skills budget pinned to its minimum the CLI emits an
`item.completed` event whose `item.type` is `"error"` reading *"Exceeded
skills context budget. All skill descriptions were removed …"*. The turn
still completes normally. The adapter treats that one notice (matched by
`isSkillsBudgetNotice`) as informational and records it in
`CodexExecResult.notices`; any other `error` item fails the call.

## Constraints

- **Plan quota, not a budget.** A ChatGPT plan meters Codex in rolling
  windows. Exhaustion arrives as `turn.failed` with a "usage limit" message;
  the adapter surfaces it as `CodexCliProcessError` with `apiErrorStatus:
  429`, so `normalizeAIError` and the subagent handler apply their existing
  rate-limit handling. A logged-out CLI maps to `401`. Bulk backfills (a
  cold-corpus dream drain, thousands of atom extractions) belong on a
  metered provider; nightly cycles, pattern discovery and interactive `think`
  fit a subscription lane well.
- **No structured output.** Like `claude-cli`, the transport cannot carry a
  JSON schema; `gateway.expand()` routes `codex-cli` through the schemaless
  `viaText` path (`parseLlmJson` strips fences).
- **No streaming**, no multimodal via subprocess (file parts render as
  `[file <type>]` stubs).
- **Terms.** `codex exec` under a ChatGPT login is a supported Codex CLI
  mode; driving it as a background model for gbrain sits in the same
  posture as `claude-cli` does for Claude Code. It is the seat's quota you
  spend. Nothing here extracts or reuses OAuth tokens outside the CLI.
- **Output budget.** The `litellm:`/`openai-compatible` thinking-headroom
  heuristics do not apply; `agent.max_output_tokens` governs subagent turns
  as for every other provider.

## Doctor probe timeout: per-recipe, 45s for codex-cli

`gbrain models doctor`'s chat probe honours the recipe's
`default_timeout_ms`. A `codex exec` cold start (CLI boot, catalog fetch,
login refresh) routinely takes several seconds before the first token; the
flat 5000ms default false-failed `claude-cli` for the same reason, so this
recipe declares 45s on both touchpoints.

## Troubleshooting

- **`codex-cli spawn failed: … ENOENT`** — the binary is not on PATH for the
  process that ran gbrain (launchd, cron, MCP servers have a narrower PATH
  than your shell). Set `GBRAIN_CODEX_CLI_BIN=/absolute/path/to/codex`.
- **`apiErrorStatus: 401` / "Not logged in"** — run `codex login` as the same
  OS user that runs gbrain; the CLI stores its session under `$CODEX_HOME`
  (default `~/.codex`), which must be readable by that process.
- **`apiErrorStatus: 429` / "usage limit"** — the plan window is exhausted;
  the message names the reset time. Point the tier at a metered provider
  until then, or wait.
- **`model not available` (error item)** — the id is not in this account's
  catalog. `codex` (interactive) → `/model` lists what the seat can use.
- **Tool calls never happen** — check the model actually saw the protocol:
  the stdin prompt must contain `## Tool Use Protocol`; the stub tests in
  `test/codex-cli-recipe.test.ts` show the expected shape.
