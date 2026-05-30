# OpenAI Codex — ChatGPT-plan OAuth provider

[OpenAI Codex](https://developers.openai.com/codex) lets a ChatGPT
subscription (Plus / Pro / Team / Enterprise) drive chat-tier model calls
through the same OAuth credential the Codex CLI uses — **no `OPENAI_API_KEY`
required**. GBrain ships this as the `openai-codex` provider: a
*native* recipe whose tokens live in the OS keychain, whose model list is
discovered dynamically, and whose gateway calls run through a dedicated
adapter rather than the static API-key `openai` path.

This is deliberately separate from the API-key `openai` recipe. The two never
share credentials or routing:

| | `openai` (API key) | `openai-codex` (OAuth) |
|---|---|---|
| Credential | `OPENAI_API_KEY` env | Browser OAuth → keychain |
| Billing | Per-token API spend | Your ChatGPT subscription |
| Models | Static recipe list | Discovered at login/refresh |
| Gateway path | openai-compatible | native `openAICodexChat` adapter |

`openai-codex` covers the **chat** and **expansion** touchpoints (including
`think`, `dream`, and the subagent loop). It does **not** provide embeddings —
keep Voyage / OpenAI / ZeroEntropy on the embedding touchpoint.

## Setup

The provider authenticates exactly like the Codex CLI: a browser OAuth flow
with a PKCE (`S256`) challenge and a **loopback-only** callback on
`localhost:1455`. No keys to copy, no secrets to paste.

1. Log in (opens your browser):
   ```bash
   gbrain providers login openai-codex
   ```
   The callback is bound to `127.0.0.1` / `localhost` only; any non-loopback
   redirect is rejected. On success the token is written to your OS keychain
   (macOS: `security` item `knowledgebase-openai-codex`).

2. Populate the dynamic model cache:
   ```bash
   gbrain providers refresh openai-codex
   ```
   This fetches the account's available models and filters to those
   `supported_in_api`. The cache is stored under `GBRAIN_HOME` with `0600`
   permissions and carries **no credential material**.

3. Verify readiness:
   ```bash
   gbrain providers list
   ```
   The `openai-codex` row should read `✓ oauth ready`.

### Credential storage

- **macOS:** OS keychain via `security` (`add/find/delete-generic-password`),
  service `knowledgebase-openai-codex`. Calls use argument arrays, never a
  shell string.
- **Fallback (no keychain):** a `0600` JSON file written atomically (temp +
  rename) under `GBRAIN_HOME`. The store refuses loose permissions, symlinks,
  and any path outside `GBRAIN_HOME`. Token-like substrings are redacted from
  all diagnostics and logs.

## Pointing touchpoints at Codex

Model selection is a live config switch (unlike `embedding_model`, which is
schema-bound). Set the chat/expansion model to an `openai-codex:<model>` id —
use a model name from `gbrain providers refresh openai-codex` output
(e.g. `gpt-5.5`).

### File plane — `~/.gbrain/config.json`

```json
{
  "chat_model": "openai-codex:gpt-5.5",
  "expansion_model": "openai-codex:gpt-5.5"
}
```

Or via CLI:

```bash
gbrain config set chat_model openai-codex:gpt-5.5
gbrain config set expansion_model openai-codex:gpt-5.5
```

### Tiered / subagent touchpoints

`think`, `dream`, and the default resolution read the tier keys; subagents read
`models.subagent`. To run subagents on Codex you must also enable the gateway
loop (the legacy Anthropic-direct path refuses non-Anthropic models):

```bash
gbrain config set models.default openai-codex:gpt-5.5
knowledgebase config set models.subagent openai-codex:gpt-5.5
gbrain config set agent.use_gateway_loop true
```

### Env plane (CI / Docker)

```bash
export GBRAIN_CHAT_MODEL=openai-codex:gpt-5.5
export GBRAIN_EXPANSION_MODEL=openai-codex:gpt-5.5
```

### Verify the live path

```bash
gbrain providers test --touchpoint chat --model openai-codex:gpt-5.5
```

Expected: a `pong`-class response with a clean stop reason and normalized token
usage. Embeddings are unaffected — keep your existing embedding provider.

## Capabilities

| Capability | Value | Notes |
|---|---|---|
| `supports_tools` | `true` | Tool/function calling via Responses API |
| `supports_subagent_loop` | `true` | Multi-turn tool loop (requires `agent.use_gateway_loop`) |
| `supports_prompt_cache` | `false` | No prompt caching — long loops cost scales linearly |
| `max_context_tokens` | `128000` | |

> **Cost note.** Because Codex has no prompt caching, the subagent loop runs
> hot — cost scales with conversation length. For long autonomous loops an
> Anthropic model (`anthropic:claude-sonnet-4-6`) is cheaper; `gbrain
> doctor` surfaces this as a `subagent_capability` advisory when
> `models.default` is `openai-codex:*`.

## brain_get_pageiness states

`gbrain providers list` (and the readiness probe) report one of:

| Status | Meaning | Fix |
|---|---|---|
| `ready` | Token + fresh model cache present | — |
| `not_logged_in` | No token / unreadable store | `knowledgebase providers login openai-codex` |
| `needs_refresh` | Token expired or near expiry | `gbrain providers refresh openai-codex` |
| `token_present` | Token OK, model cache **stale** (>24h) | `gbrain providers refresh openai-codex` |
| `cache_missing` | Token OK, no cache / no API-supported models | `gbrain providers refresh openai-codex` |

The model cache has a 24h TTL; a 5-minute skew triggers proactive token
refresh.

## Multi-turn & tool-calling notes

The native adapter maps GBrain's message blocks onto the OpenAI
Responses API:

- Assistant history turns are sent as `output_text` (they represent prior
  model output); user/system turns use `input_text`. Sending `input_text` for
  an assistant turn is rejected by the Responses API — this is handled
  automatically.
- Tool calls round-trip as `function_call` / `function_call_output` items;
  `arguments` is always a JSON string. Malformed tool-call JSON is caught and
  passed through raw rather than crashing the loop.
- Streamed function calls arrive as an `output_item.added` (empty) + `done`
  (complete) pair sharing a `call_id`; the stream parser de-duplicates so the
  loop sees exactly one invocation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `list` shows `token_present`, not `ready` | Model cache stale (>24h TTL) | `gbrain providers refresh openai-codex` |
| Login browser window never opens | Headless host / no `open`/`xdg-open` | Run login on a machine with a browser; the callback is loopback-only |
| `needs_refresh` immediately after login | Clock skew or short-lived token | `gbrain providers refresh openai-codex` |
| Subagent job won't run on Codex | `agent.use_gateway_loop` not set | `gbrain config set agent.use_gateway_loop true` |
| Subagent burns turns / wrong tool names | Tool-discipline drift | Provide explicit `allowed_tools`; the gateway loop adds tool-discipline steering |
| `providers refresh` says "not logged in" | Token missing/expired | `gbrain providers login openai-codex` |

## Security posture

- Loopback-only OAuth callback with PKCE `S256`; callback state is verified.
- Tokens stored in OS keychain (preferred) or a `0600`, symlink-refusing,
  `GBRAIN_HOME`-confined file.
- All keychain calls use `execFile`-style argument arrays — no shell string
  interpolation.
- Every diagnostic path redacts `access_token` / `refresh_token` / `id_token`
  / `sk-…` / JWT-shaped substrings.
- Provider login/refresh is a **trusted local CLI** action; it is not exposed
  over the MCP/HTTP surface.
