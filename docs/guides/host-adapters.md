# Host Adapters

GBrain has two integration layers:

1. **Core GBrain**: CLI, database, indexing, MCP tools, skills, Minion jobs,
   provider gateway, and schemas.
2. **Host adapters**: optional packages that translate a host runtime's native
   plugin/tool/route contract into GBrain operations.

Keep those layers separate. The root `openclaw.plugin.json` remains the bundle
plugin for skills plus MCP. A host adapter should live as its own package or
documented host-side module so GBrain stays usable from OpenClaw, Codex, Claude
Code, Hermes, MCP clients, and standalone CLI installs.

```mermaid
flowchart LR
  Human["Human / agent asks a question"]
  Host["Host runtime\nOpenClaw, Codex, Claude Code, Hermes"]
  Adapter["Host adapter\nnative tools + routes"]
  Core["GBrain core\nCLI, engine, MCP, schemas"]
  Brain["Brain database\npages, chunks, raw_data"]
  Provider["Optional provider call\nembedding, extraction, enrichment"]

  Human --> Host
  Host --> Adapter
  Adapter --> Core
  Core --> Brain
  Adapter --> Provider
  Provider --> Adapter
```

The adapter is intentionally the only box that knows host-specific runtime
details. GBrain core remains a portable brain engine.

## When To Use Each Layer

Use the root bundle plugin when the host can consume skills and an MCP server:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "./bin/gbrain",
      "args": ["serve"]
    }
  }
}
```

Use a host adapter when the host has native tool or HTTP route contracts that
need runtime-specific wiring. Examples:

- OpenClaw native tools and plugin HTTP routes
- Codex host actions that call GBrain through a local gateway
- Claude Code shell/MCP install helpers
- Hermes runtime modules that need GBrain search or ingestion

## Adapter Responsibilities

A host adapter may:

- expose status/search/query tools through the host's native tool API;
- call the local `gbrain` CLI or import GBrain modules directly;
- expose bounded extraction or enrichment routes backed by the host runtime;
- map host-managed credentials into GBrain's provider-auth resolver;
- provide host-specific install and health-check commands.

A host adapter must not:

- move host-specific assumptions into GBrain core;
- print raw API keys, OAuth tokens, refresh tokens, or profile files;
- accept arbitrary shell command strings from model/tool input;
- bypass GBrain's local-vs-remote protections for destructive operations;
- claim binary media understanding unless the backing host runtime actually
  supports that request path end to end.

## Recommended Package Shape

```text
plugins/<host>-gbrain/
├── README.md
├── package.json
├── <host>.plugin.json
└── index.js
```

Use the host's package naming convention. For example, an OpenClaw adapter can
ship as `plugins/openclaw-gbrain/` while the root bundle plugin remains
`openclaw.plugin.json`.

The adapter README should include:

- install command;
- enable/restart command, if the host requires one;
- config schema;
- smoke test;
- supported tools and routes;
- credential source behavior;
- timeout and rate-limit defaults.

## Tool Contract

Host adapters should start with the smallest useful tool surface:

| Tool | Purpose | Side effects |
| --- | --- | --- |
| `gbrain_status` | Report doctor/provider/source health | None |
| `gbrain_search` | Return ranked search results | None |
| `gbrain_query` | Return synthesized answer with citations | None |

Tool inputs should be structured JSON. Do not pass raw command-line strings
through to a shell. If an adapter shells out to `gbrain`, it should build the
argument list internally from validated input fields.

## Extraction Route Contract

Hosts that can run bounded model completions may expose an extraction route:

```text
POST /plugins/gbrain/extract
```

Request:

```json
{
  "protocolVersion": "gbrain.media-extraction.v1",
  "kind": "text",
  "source": {
    "name": "photo-001.jpg",
    "mimeType": "image/jpeg"
  },
  "content": {
    "text": "OCR, transcript, alt text, or other text-backed media evidence",
    "base64": null
  },
  "timeoutMs": 120000
}
```

Response:

```json
{
  "ok": true,
  "protocolVersion": "gbrain.media-extraction.v1",
  "extraction": {
    "schema": "gbrain.media-extraction.v1",
    "items": []
  }
}
```

Controlled error:

```json
{
  "ok": false,
  "protocolVersion": "gbrain.media-extraction.v1",
  "error": {
    "code": "extraction_busy",
    "message": "GBrain extraction is busy. Retry shortly."
  }
}
```

Minimum route requirements:

- validate request shape before invoking a model or CLI;
- clamp request body size;
- clamp timeout;
- return controlled errors, not raw stack traces;
- avoid logging request bodies that may contain private content;
- avoid logging tokens or provider credentials;
- serialize output as `gbrain.media-extraction.v1` so the host can pass it to
  the normalized media-evidence import path when that feature is available.

Text-backed media extraction is the safe MVP. Image/video binary understanding
should be explicit host capability, not assumed by this contract.

## Auth Boundary

GBrain core owns provider calls and provider readiness. The host owns its
runtime auth state, including any OAuth session or local profile that proves the
user is already signed in.

Adapters should pass credential source metadata into GBrain or into their own
route handlers, not token contents through tool payloads. A host-side adapter
config can look like this:

```json
{
  "credentialSource": {
    "provider": "openai",
    "source": "openclaw-codex",
    "profile": "openclaw-codex"
  }
}
```

If a GBrain build includes a core provider-auth resolver, the adapter may map
that host config into the resolver's supported config shape. If a host must read
a local auth profile itself, the path should be explicit and the adapter should
report only source class, profile name, and readiness. It should not echo secret
values in tools, route responses, or logs.

Why the OAuth/profile boundary matters for humans: users should be able to use
the model access they already authenticated inside their agent host without
pasting another model API key into every extension. The adapter boundary gives
that convenience without making GBrain core depend on a single host.

## Rate Limits And Timeouts

Adapters should default to conservative extraction limits:

- one active extraction at a time;
- bounded queue size;
- bounded queue wait;
- hard per-request timeout;
- optional minimum delay between extraction starts.

Those defaults protect local desktop/runtime hosts from a batch import turning
into many simultaneous model turns.

## OpenClaw Example

An OpenClaw adapter can expose:

- `gbrain_status`
- `gbrain_search`
- `gbrain_query`
- `/plugins/gbrain/extract`

Its extraction route can call OpenClaw's bounded model completion/runtime helper
and return normalized `gbrain.media-extraction.v1` JSON. OpenClaw/Codex OAuth
remains an OpenClaw runtime responsibility; GBrain receives either normalized
extraction output or an explicit provider-auth source configuration.

This keeps the adapter useful to OpenClaw users without making OpenClaw a hard
dependency for GBrain's CLI, MCP server, skills, or other host integrations.
