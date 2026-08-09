# Hermes + GBrain memory provider

The [standalone GBrain provider](https://github.com/veltri-23/hermes-gbrain-memory)
gives Hermes semantic recall and durable conversation capture through GBrain's
MCP server. Tracking issue: [#3870](https://github.com/garrytan/gbrain/issues/3870).

## Prerequisites

- Hermes with standalone `kind: exclusive` memory-provider discovery.
- A working `gbrain` installation and initialized brain.
- For shared HTTP, a Postgres- or PGLite-backed brain and a reachable HTTP MCP
  server. `gbrain auth create` stores tokens in the selected brain database's
  `access_tokens` table.

## Install

Clone provider into Hermes' user-plugin directory.

POSIX shells:

```bash
git clone https://github.com/veltri-23/hermes-gbrain-memory "$HERMES_HOME/plugins/gbrain"
```

PowerShell:

```powershell
$pluginPath = Join-Path $env:HERMES_HOME 'plugins\gbrain'
git clone https://github.com/veltri-23/hermes-gbrain-memory $pluginPath
```

`kind: exclusive` providers use Hermes' memory-provider discovery, not the
general `hermes plugins enable` path. Run `hermes memory setup` below to select
this provider.

Keep one active `gbrain` provider installation. A bundled legacy copy can take
precedence over this user-plugin copy; check the resolved provider path before
enabling it.

Set provider selection, then use either setup command:

```yaml
memory:
  provider: gbrain
```

```bash
hermes memory setup
# or:
hermes gbrain setup
```

`hermes gbrain setup` writes non-secret settings to `config.yaml`, keeps the
token in `.env` under Hermes home by variable name, and verifies the MCP
`initialize` plus `tools/list` handshake before selecting shared HTTP.

## Transport

### Local stdio

Use stdio for one Hermes process. It starts `gbrain serve` itself; no listener
or token is needed:

```yaml
plugins:
  gbrain:
    base_url: ""
    command: gbrain
```

### Shared HTTP

Use one server for multiple Hermes profiles or agents. Create its bearer token
before starting GBrain, then start GBrain on the same port configured as
`base_url`:

POSIX shells:

```bash
gbrain auth create hermes
gbrain serve --http --port 7842
```

PowerShell:

```powershell
gbrain auth create hermes
gbrain serve --http --port 7842
```

Save printed token once, then put its value in `.env` under `$HERMES_HOME`
(POSIX) or `$env:HERMES_HOME` (PowerShell):

```dotenv
GBRAIN_TOKEN=replace-with-printed-token
```

Configure the server origin, not `/mcp`; provider posts MCP requests to
`<base_url>/mcp`:

```yaml
plugins:
  gbrain:
    base_url: http://127.0.0.1:7842
    token_env: GBRAIN_TOKEN
    command: gbrain
```

For a server on another host, make that origin reachable from Hermes and use
the deployment's public URL. Configure bind, TLS/tunnel, and bearer access on
the server; do not expose an unauthenticated MCP endpoint.

## Provider settings

```yaml
plugins:
  gbrain:
    base_url: http://127.0.0.1:7842 # blank forces stdio
    token_env: GBRAIN_TOKEN          # variable name, never token value
    command: gbrain
    tools: auto                      # core tools; all is opt-in
    scope: auto                      # auto | user | profile | shared
    namespace: hermes
    limit: 10
    max_pages: 8
    snippet_chars: 220
    char_budget: 2600
    capture: true
    timeout: 10.0
```

`scope: auto` uses platform user identity when available, then profile
identity. Without stable identity, capture is disabled. `scope: shared` is
explicit shared read-only operator memory. Captured pages stay under
`namespace/<scope>/`; writes stay in the caller's private scope. Pages outside
that namespace remain readable operator knowledge. Unknown legacy segments
inside the namespace stay quarantined and read-only.

## MCP contract

The standalone provider sends `initialize` with protocol version `2024-11-05`,
then requires a valid JSON-RPC result whose returned `protocolVersion` is a
string and a successful `tools/list`. Current GBrain HTTP source responds with
`2025-03-26`; provider does not require returned version equality. This records
the current source pairing, not a general compatibility guarantee for arbitrary
MCP servers.

Default `tools: auto` requests these server-defined schemas:

| Tool | Parameters used by provider | Scope |
| --- | --- | --- |
| `search` | `query` required; `limit` optional | read |
| `recall` | `entity`, `since`, `session_id`, `include_expired`, `supersessions`, `limit`, `grep`, `include_pending` optional | read |
| `get_page` | `slug` required; `fuzzy`, `include_deleted` optional | read |
| `put_page` | `slug`, `content` required; `allow_empty`, `source_kind`, `source_uri`, `ingested_via` optional | write |
| `traverse_graph` | `slug` required; `depth`, `link_type`, `direction` optional | read |
| `find_contradictions` | `slug`, `severity`, `limit` optional | read |

`tools: all` is opt-in. Provider treats unknown/non-read proxied tools as
writes and applies the same scope filtering. GBrain omits all `localOnly`
operations from HTTP `tools/list` and rejects direct HTTP calls. Current
`localOnly` operations are `purge_deleted_pages`, `sync_brain`, `file_list`,
`file_upload`, `file_url`, `get_recent_transcripts`,
`code_traversal_cache_clear`, `migrate_embeddings`, `chronicle_backfill`, and
`extraction_review`.

## Verify

```bash
hermes gbrain status
```

Status checks provider selection, plugin enablement, token or stdio binary,
provider availability, a live brain connection, and recall. An empty brain can
produce empty recall while the connection is healthy; import pages before
diagnosing that as transport failure.

For shared HTTP, also verify the endpoint with GBrain's own command:

POSIX shells:

```bash
gbrain auth test http://127.0.0.1:7842/mcp --token "$GBRAIN_TOKEN"
```

PowerShell:

```powershell
gbrain auth test http://127.0.0.1:7842/mcp --token $env:GBRAIN_TOKEN
```

The provider fails open: unavailable memory becomes empty recall and does not
fail an assistant turn. Capture remains asynchronous and bounded.
