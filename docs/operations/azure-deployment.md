# Running gbrain on Azure

Operator guide for the all-Azure deployment: gbrain plus every model it calls,
connected to Claude Code and GitHub Copilot CLI as a remote MCP server.

- Infrastructure and deploy order → [`infra/README.md`](../../infra/README.md)
- Design reasoning and cost model → `plans/AzureIntegration.md`

This document covers what an operator does after the resources exist.

## What runs where

```
Claude Code ─┐
             ├──▶ ca-gbrain-mcp   (external ingress, TLS, scale-to-zero)
Copilot CLI ─┘         │
                       ▼
                  pg-gbrain  (PostgreSQL Flexible Server, VNet-injected)
                       ▲
                       │
             ca-gbrain-worker   (minion supervisor, no ingress)
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
  aif-gbrain (Foundry)          oai-gbrain (Azure OpenAI)
  Claude, hosted on Azure       text-embedding-3-small @ 1536d
```

The MCP app scales to zero and bills on request. The worker is exactly one
replica when running — two supervisors race on the same job leases and
duplicate LLM spend on every cycle phase.

## Configuration that is load-bearing

Set by the Bicep templates; listed here because changing one by hand has
non-obvious consequences.

| Variable | Why it matters |
|---|---|
| `GBRAIN_DATABASE_URL` | Port **5432**, not 6432. gbrain keys its prepared-statement auto-disable on port 6543 and gates its dual-pool machinery on a Supabase-shaped URL, so behind a transaction-mode pooler `executeRawDirect` — which minion lock heartbeats and sync checkpoints depend on — silently collapses onto the shared read pool. |
| `HOME` **and** `GBRAIN_HOME` | Both, to the same value. gbrain resolves its home three ways that disagree: `config.ts` appends `.gbrain` to `GBRAIN_HOME`, `brain-repo-durability.ts` does not, and the minion supervisor ignores `GBRAIN_HOME` entirely in favour of `$HOME/.gbrain`. |
| `GBRAIN_AUDIT_DIR` | Absolute, for the same reason. Note the path is ephemeral — Log Analytics is the durable audit sink. |
| `GBRAIN_HTTP_TRUST_PROXY=1` | Container Apps fronts every request with envoy. Without this, Express's default `loopback` trust collapses every rate-limit bucket onto the proxy's IP. Safe here only because envoy rewrites `X-Forwarded-For` rather than appending to a client-supplied one. |
| `GBRAIN_DISABLE_ADMIN=1` | `/admin` shares the app and port with `/mcp` and cannot be firewalled separately. On a network-exposed single-user deployment the admin plane earns nothing — administer over `az containerapp exec`. |
| `ANTHROPIC_BASE_URL` | Points the existing `anthropic` recipe at Foundry. Do not replace this with a new recipe id — see below. |
| `GBRAIN_EMBEDDING_DIMENSIONS=1536` | Never 3072. Above 2000 dims pgvector refuses to build an HNSW index and gbrain emits a SQL comment instead of one, so the brain sequential-scans forever with no error at any layer. |

### Never set these

| Variable / flag | Why |
|---|---|
| `AZURE_OPENAI_USE_ENTRA` | Implemented by shelling out to `az account get-access-token`, and there is no Azure CLI in the image. Managed identity for the model plane would be a rewrite to IMDS, not a config toggle. |
| `GBRAIN_ALLOW_SHELL_JOBS` | Re-enables the shell job lane on a network-exposed deployment. |
| `GBRAIN_ALLOW_PRIVATE_REMOTES` | SSRF surface. |
| `--enable-dcr` / `--enable-dcr-insecure` | Dynamic client registration open to the internet. Register clients by hand. |
| `--log-full-params` / `--print-admin-token` | Secret leakage into centralized logs. |

## Spend controls before the first query

```bash
az containerapp exec -g rg-gbrain -n ca-gbrain-mcp --command /bin/sh
# then, inside:
gbrain config set search.mode conservative
gbrain config set spend.posture gated
gbrain config set pace.mode gentle
gbrain config set embed.backfill_max_usd_per_source_24h 25
gbrain config set mcp.publish_skills true
```

`search.mode` is the highest-leverage cost lever in the whole deployment —
the spread between `conservative` with a cheap downstream model and `tokenmax`
with an expensive one is roughly 25x on downstream agent input cost, which
dwarfs every SKU choice in the infrastructure.

**Confirm `mcp_spend_log` exists after migration.** `getTodaySpendCents` fails
open to 0 when the table is missing, which silently deletes every cap.

## Client credentials

Use OAuth clients, not `gbrain auth create`. Legacy `access_tokens` rows are
grandfathered to `['read','write','admin']` with a synthetic one-year expiry;
OAuth clients carry real scopes, source scoping and per-client budgets, and are
individually revocable.

```bash
gbrain auth register-client claude-code \
  --grant-types client_credentials \
  --scopes "read write" \
  --source <source-id> \
  --token-endpoint-auth-method client_secret_post \
  --budget-usd-per-day 5

gbrain auth register-client copilot-cli \
  --grant-types client_credentials \
  --scopes read \
  --source <source-id> \
  --budget-usd-per-day 2
```

Grant the narrowest scope that works. Never `admin`.

**Keep `sources_list` and `sources_status` out of any tool allowlist you
publish to a client.** Both are `scope:'read'` with no grant filtering and
disclose every source's `local_path` and `remote_url`.

## Connecting clients

### Claude Code

```bash
claude mcp add --transport http gbrain https://<your-host>/mcp --scope user
claude mcp login gbrain          # add --no-browser for SSH/headless
```

Discovery works because the server returns
`WWW-Authenticate: Bearer resource_metadata="…"` on 401, pointing at
`/.well-known/oauth-protected-resource/mcp`.

Two footguns in hand-written JSON config:

- `"type": "http"` is **required**. An entry with a `url` and no `type` is
  silently skipped.
- Claude Code applies a 60-second first-byte timer. Set `"timeout": 120000`
  per server for scale-from-zero headroom.

Config scopes resolve local > project > user, and the winning entry is used
whole — fields are not merged across scopes.

### GitHub Copilot CLI

```bash
copilot mcp add
```

Writes `~/.copilot/mcp-config.json` under the top-level key `mcpServers`.

**Cross-surface footgun:** Claude Code and Copilot CLI use `mcpServers`;
VS Code Copilot Chat uses `servers`. Publish per-surface snippets.

**Prerequisite:** every Copilot MCP surface is gated behind the org/enterprise
policy "MCP servers in Copilot", which was disabled by default at GA. Check
with an org admin before assuming it connects.

### Where each client's own traffic goes

gbrain's stored data stays in Azure regardless of client. The client's own
prompt traffic is a separate boundary:

- **Copilot CLI + BYOK → Azure.** Fully inside the boundary, via
  `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_TYPE` /
  `COPILOT_PROVIDER_API_KEY` / `COPILOT_MODEL`.
- **Claude Code → Anthropic** by default. Whether it can be pointed at a
  Foundry Claude endpoint is unconfirmed; it supports Bedrock and Vertex via
  environment flags, and a Foundry equivalent is plausible but should be
  verified rather than assumed.

## Daily operation

```bash
bash scripts/azure/start.sh    # database first, waits for Ready, then worker
bash scripts/azure/stop.sh     # worker first, drains, then database
bash scripts/azure/verify.sh   # every layer, independently
```

`.github/workflows/schedule.yml` runs the same scripts on weekday cron. Run one
full stop → start → verify cycle by hand via `workflow_dispatch` before trusting
the schedule.

The schedule's real cost is the overnight cycle: `synthesize`, `patterns`,
`consolidate` and `extract-takes` are designed to run while you sleep. The
morning warm-up window is the mitigation — compute comes up before anyone is
querying, so the cycle still drains, just time-shifted.

## Expected failures

**`gbrain doctor`'s `rls` check fails permanently.** gbrain enables row-level
security only when the role holds `BYPASSRLS` or is superuser, and Azure's
Postgres admin role is neither. This is acceptable here because the server has
no public network path and gbrain's RLS carries zero policies anywhere — it was
only ever an anon-key defense for the Supabase topology. **Any other doctor
failure is real.**

**Foundry strips Anthropic's `anthropic-ratelimit-*` response headers**, so
adaptive throttling that reads them sees nothing. Backpressure comes from
429-driven backoff plus Azure Monitor, not from headers.

**Default Claude quota on a pay-as-you-go subscription is low** — enough for
interactive querying, immediately throttling for bulk enrichment or a nightly
cycle. File a quota increase before the first bulk run, not after.

## Things that look like cleanups and are not

**Do not create a `foundry-claude` recipe.** Three mechanisms key on the
literal recipe id `anthropic`: `cache_control` markers are applied in `chat()`
only for that id (a new id silently forfeits prompt caching, a 5–10x cost
increase on subagent loops), a test forbids any other recipe from claiming
`supports_prompt_cache`, and `CANONICAL_PRICING` lookup does not fall back
across provider prefixes, so every `--max-cost` caller would hard-fail with
`no_pricing`. Point the existing recipe's base URL at Foundry instead.

The accepted consequence: there is one `anthropic` recipe id and one global
`ANTHROPIC_BASE_URL`, so routing is all-Foundry or all-direct. Splitting
traffic per model would be new work, not a config change.

**Name the Haiku deployment with its date.** On Foundry the wire `model` field
carries the deployment name, deployment names are immutable, and gbrain's alias
table resolves `claude-haiku-4-5` to `claude-haiku-4-5-20251001` before the
request goes out. A mismatch 404s at the first query with an opaque error.

**Do not move to a Dev/Test subscription for the discount.** Credit-based,
sponsored and dev/test subscriptions are excluded from Azure Marketplace
purchase, which blocks Claude in Foundry entirely and kills the model plane.

**Do not buy a Postgres reservation while running on a schedule.** A
reservation bills whether the server runs or not. At a weekday-only duty cycle
the scheduled stop already saves more, and the two do not stack.
