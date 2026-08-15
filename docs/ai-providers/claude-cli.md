# claude-cli — the `claude-cli` recipe (routes chat/toolLoop through the local `claude` CLI)

This page documents the `claude-cli` recipe as it already ships (added in
v0.42.66.0, PR #3310 — see `CHANGELOG.md`) — it is not proposing new
behavior. The implementation lives at `src/core/ai/recipes/claude-cli.ts`
and `src/core/ai/providers/claude-cli-language-model.ts`; neither
`README.md` nor `docs/` mentioned this recipe before this page, so the only
description of how it behaves lived in those source comments.

`claude-cli` routes `gateway.chat()` and `gateway.toolLoop()` through the
`claude` CLI binary as a subprocess (`claude --print ...`) instead of through
the Anthropic SDK. It sits alongside the existing `anthropic` recipe as a
second `Recipe` entry with the same touchpoint shape; which one a given
model string resolves to is a per-call choice: `anthropic:claude-sonnet-5`
resolves to the `native-anthropic` implementation (SDK + `ANTHROPIC_API_KEY`),
`claude-cli:claude-sonnet-5` resolves to `ClaudeCliLanguageModel` (subprocess,
CLI-managed auth).

**Chat-only — no embedding.** `gateway.embed()` throws immediately for
`claude-cli` models (`claude-cli has no embedding model. Use openai or google
for embeddings.`). Claude has no first-party embedding model regardless of
transport; pair this recipe with `openai`, `google`, or `voyage` for
embeddings the same way the `anthropic` recipe's docs already recommend.

## Setup

1. Install Claude Code (the `claude` CLI) and run `claude` once to log in.
   If the binary is not on `PATH`, point the gateway at it explicitly:

   ```bash
   export GBRAIN_CLAUDE_CLI_BIN=/path/to/claude
   ```

2. Point a model tier (or any per-call model string) at `claude-cli:`:

   ```bash
   gbrain config set models.tier.subagent claude-cli:claude-sonnet-5
   ```

   Any of the models the recipe declares work the same way:
   `claude-cli:claude-opus-5`, `claude-cli:claude-haiku-4-5-20251001`, etc.
   Short aliases (`claude-cli:sonnet`, `claude-cli:haiku`, `claude-cli:opus`)
   resolve the same way the `anthropic` recipe's aliases do.

The recipe declares `auth_env: { required: [] }`, and neither the recipe
nor the adapter code reads or passes any API-key-shaped config value to the
subprocess — whatever the `claude` binary does for its own auth (see below)
is between it and its own login state, not something gbrain's config layer
participates in. There is also no `provider_base_urls` entry for this
recipe — it has no base URL, only a subprocess binary path
(`GBRAIN_CLAUDE_CLI_BIN`).

## What actually happens on a call

Each `doGenerate` call spawns `claude --print --output-format json --model
<id> --disable-slash-commands --tools '' --strict-mcp-config` as a
subprocess, with `cwd` set to a per-process directory under the OS tmpdir
(`join(tmpdir(), 'gbrain-claude-cli-cwd-' + process.pid)`, created via
`mkdirSync(..., { recursive: true })` if missing — code doesn't otherwise
touch or inspect its contents), and pipes the rendered prompt to it on
stdin:

- `--tools ''` disables every built-in tool (Bash/Read/WebSearch/…) — the
  subprocess must behave like a raw LLM, not a full agent.
- `--strict-mcp-config` skips loading the user's MCP servers. Without it,
  every call would boot the user's configured MCP servers — including
  gbrain's own MCP, which would recurse and contend for the PGLite
  single-writer lock.
- The subprocess env is a copy of gbrain's own process env with exactly
  three keys deleted before spawn: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`. Everything else in gbrain's environment is inherited
  as-is. The recipe's source comment states the intent (stop an
  `ANTHROPIC_API_KEY` present in gbrain's own env from being picked up by the
  subprocess), scoped to those three variables specifically — the doc does
  not claim this rules out every other way `claude` could end up billing
  through a non-subscription path (e.g. other env-based auth switches the CLI
  itself may support); that is between the installed `claude` binary and its
  own configuration, not something this recipe's code inspects.
- Beyond that env-scrub, auth resolution is entirely up to the installed
  `claude` binary — the recipe does not manage or forward credentials
  itself. Whatever `claude` is already logged in / authenticated with on
  this machine is what it authenticates with here too (see the `claude` CLI's
  own docs for how it stores and resolves that).

`--bare` (which would skip loading the user-level `~/.claude/CLAUDE.md`
entirely) is not among the flags passed, because it also forces
`ANTHROPIC_API_KEY` auth (per the recipe's source comment). One effect of
not passing it: the user-level `~/.claude/CLAUDE.md` still loads and gets
cached tokens on every call.

The adapter does not use `claude`'s own agentic tool-calling — it injects a
fenced instruction block into the system prompt teaching the model a
`<use_tools>[{id,name,input}, ...]</use_tools>` JSON emission format
(`buildToolUseInstructions`), then parses that block back out of the plain
text response into ai-sdk tool-call parts (`extractToolCalls`). This
protocol-over-text approach is what lets `supports_subagent_loop: true`
work through the `--print`, no-built-in-tools subprocess shape described
above.

## Constraints

| Area | Behavior |
|---|---|
| Embedding | Not supported — `gateway.embed()` throws for `claude-cli` models. Pair with another provider for embeddings. |
| Streaming | Not implemented. `doStream()` throws. `gateway.toolLoop()` (the main caller) is non-streaming already, so this is not a practical limitation for subagent dispatch, but any caller that expects a streaming chat surface cannot use `claude-cli`. |
| Tool use | JSON emission via a system-prompt-injected protocol, not the CLI's native tool-call mechanism. Parallel tool calls in one turn round-trip correctly. |
| Multimodal | Not supported over the subprocess path. File/image message parts are rendered as a `[file <mediaType>]` text stub, not sent as actual content. |
| Prompt caching | The recipe declares `supports_prompt_cache: false`. The CLI manages its own caching internally but does not expose it through gbrain's `cache_control` control plane, so from the gateway's point of view this model does not support prompt caching. |
| Usage / token counts | Reported `usage.input_tokens` / `usage.output_tokens` are read straight from the CLI's `--output-format json` envelope (`result.usage?.input_tokens` / `output_tokens`); gbrain does not independently count tokens for this path. |
| Cost figures | The recipe declares `cost_per_1m_input_usd: 3.0` / `cost_per_1m_output_usd: 15.0` — the same Sonnet-class figures the `anthropic` recipe declares (`price_last_verified: 2026-06-17`) — purely so gbrain's budget ledger has a number to attribute per call. Neither the recipe nor the adapter code checks what you're actually billed; treat these as the ledger's nominal per-call number, not a verified charge. |
| User-level CLAUDE.md | `~/.claude/CLAUDE.md` still loads on every call (see above) — only the working directory changes (see "What actually happens on a call" for exactly what that directory is and isn't). |

## Known doctor caveat: cold-start subprocess vs the fixed 5s probe timeout

`gbrain models doctor`'s chat reachability probe (`probeModel` in
`src/commands/models.ts`) wraps every chat call in a fixed 5-second
`AbortController` timeout, independent of any per-recipe timeout the recipe
itself declares (`claude-cli` does not declare a `default_timeout_ms`).
Spawning the `claude` binary and letting it start up is generally fast, but
is not instantaneous — a slow first invocation (cold process cache, slow
disk, contended machine) can outrun that 5-second window.

When that happens, the probe's `AbortController` fires, the subprocess is
killed (`child.kill('SIGTERM')`), and the adapter's abort handler rejects
with a fixed message (`claude-cli adapter aborted`). `classifyError` in
`src/commands/models.ts` only maps a message to `status: network` if it
matches `/timeout|network|econn|fetch failed|enotfound/`; `claude-cli
adapter aborted` matches none of those, so it falls through to
`status: unknown` — the classifier's catch-all — instead of `status:
network`, which is what a plain slow/unreachable HTTP provider would map
to on the same probe timeout. So a `status: unknown` result on a
`claude-cli:` model is not necessarily a broken configuration on its own;
a cold subprocess start outrunning the fixed 5s window is one thing that
can produce it (the same class of first-call cold-start the embedding
reachability probe's own code comment already calls out for local
embedders), and re-running the probe is a reasonable first thing to try.
`status: unknown` on its own doesn't distinguish that from any other
unclassified failure, so if a re-run keeps producing it, treat it as an
unclassified error worth investigating rather than assuming cold-start.

## Troubleshooting

| Symptom | Where it comes from | Try |
|---|---|---|
| `claude-cli spawn failed: ...` / stdin write failure | `spawn()`'s `error` event or a failed `stdin.write` — commonly means the `claude` binary was not found on `PATH` | Install Claude Code, or set `GBRAIN_CLAUDE_CLI_BIN` to the binary's path |
| `claude-cli exited <code>: ...` | Non-zero exit from the `claude` subprocess itself; the message is whatever the CLI wrote to stderr/stdout | Run `claude` interactively with the same model to see the underlying CLI error directly (e.g. not logged in, model unavailable) |
| `claude-cli output not JSON: ...` | `JSON.parse(stdout)` threw (stdout wasn't valid JSON at all) | Confirm the installed `claude` CLI version still supports `--print --output-format json`; this adapter's JSON handling was verified against CLI 2.1.145 |
| `claude-cli JSON event array had no "result" event` | stdout parsed as a JSON array (the `"verbose": true` event-stream shape in `~/.claude/settings.json`) but none of the events had `type: "result"` | Check `~/.claude/settings.json` for `"verbose": true`; the adapter tolerates the array shape but still needs a `result` event in it |
| `gbrain models doctor` reports `chat` as `status: unknown` for a `claude-cli:` model | See "Known doctor caveat" above — `classifyError` falls through to `unknown` for the adapter's abort message | Re-run the probe; if it persists, treat it as an unclassified failure and investigate directly (e.g. run the same model via `gbrain models doctor --json` or call `claude` by hand) |
| A call bills through the Anthropic API instead of the local session | The adapter deletes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` from the subprocess env — this covers gbrain's own env leaking into the call. It does not inspect any other auth/billing switch the installed `claude` CLI itself may support | If billing looks wrong, check the `claude` CLI's own auth/billing configuration on this machine, not just gbrain's env |
