# OpenCode Server Provider

Use a persistent local OpenCode server as a GBrain chat and subagent provider.
OpenCode owns ChatGPT OAuth credentials and token refresh; GBrain never reads or
copies OpenCode's OAuth tokens.

## Architecture

```text
GBrain gateway/tool loop
  -> OpenCode local HTTP server
    -> OpenAI model through OpenCode's ChatGPT OAuth
      -> structured text or GBrain tool requests
        -> GBrain executes tools with its normal allow-lists and audit records
```

OpenCode tools are denied for every adapter-created session. OpenCode returns
structured tool requests, but GBrain remains the only process that executes
brain operations. This preserves Minion job receipts, idempotency, source
scoping, and crash replay.

Define a minimal primary agent in the server's `opencode.json`. Avoid using the
built-in `build` agent here: its coding instructions add substantial prompt
tokens that GBrain does not need.

```json
{
  "agent": {
    "gbrain": {
      "description": "Model transport for GBrain",
      "mode": "primary",
      "prompt": "Follow the caller's system and user instructions exactly.",
      "permission": { "*": "deny" }
    }
  }
}
```

## Authenticate OpenCode

```bash
opencode providers login --pure \
  --provider OpenAI \
  --method "ChatGPT Pro/Plus (browser)"
```

Verify that `OpenAI oauth` appears:

```bash
opencode providers list
```

## Start the server

Bind the service to loopback. For a single-user workstation, loopback-only mode
keeps the endpoint off the network. Set `OPENCODE_SERVER_PASSWORD` as well when
other local users or untrusted local processes are in scope.

```bash
opencode serve --pure --hostname 127.0.0.1 --port 4097
```

The default GBrain connection is `http://127.0.0.1:4097`. Optional settings:

| GBrain config.json field | Environment override | Default |
| --- | --- | --- |
| `opencode_server_url` | `GBRAIN_OPENCODE_SERVER_URL` | `http://127.0.0.1:4097` |
| `opencode_server_username` | `GBRAIN_OPENCODE_SERVER_USERNAME` | `opencode` |
| `opencode_server_password` | `GBRAIN_OPENCODE_SERVER_PASSWORD` | empty |
| `opencode_server_provider_id` | `GBRAIN_OPENCODE_PROVIDER_ID` | `openai` |
| `opencode_server_agent` | `GBRAIN_OPENCODE_AGENT` | `gbrain` |

## Configure GBrain

Keep inexpensive utility and verdict calls on their existing provider during
the initial rollout. Route one expensive task at a time:

```bash
gbrain config set agent.use_gateway_loop true
gbrain config set models.dream.synthesize opencode-server:gpt-5.5
```

After synthesis is proven on a bounded corpus:

```bash
gbrain config set models.dream.patterns opencode-server:gpt-5.5
gbrain config set models.think opencode-server:gpt-5.5
```

Do not use this provider for embeddings. It intentionally exposes only the
chat touchpoint.

## Operational notes

- A persistent server avoids starting and loading OpenCode for every call.
- Model input tokens are not eliminated. Each GBrain gateway turn still sends
  the relevant conversation and tool definitions; provider-side prefix caching
  may reduce repeated work but is not guaranteed by this adapter.
- Each adapter call creates a deny-all OpenCode session and deletes it after the
  response. GBrain owns multi-turn state and tool replay.
- HTTP 401/403/404 responses are configuration failures. Network, 429, and 5xx
  failures are retryable provider failures.
- Keep Anthropic configured as a fallback until live dream and pattern runs are
  green on representative data.
