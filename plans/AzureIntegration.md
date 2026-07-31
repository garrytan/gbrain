# Azure Integration Plan

**Status:** Draft for implementation
**Date:** 2026-07-31
**Target version:** gbrain 0.42.67.0
**Goal:** Run gbrain entirely inside Azure — including every model it calls — and connect it to Claude Code and GitHub Copilot CLI as a remote MCP server.

---

## 0. Locked decisions

These were decided before drafting and are not open for re-litigation inside the plan.

| Decision | Value | Consequence |
|---|---|---|
| Data boundary | **All Azure. No data to any third-party system.** | Forces Foundry Claude **v2 "Hosted on Azure"** only, forces Azure OpenAI embeddings, forbids direct `api.anthropic.com`. |
| Model fallback | **None. Fail fast.** | No fallback code, no degraded-mode routing. If Foundry is unavailable the touchpoint errors. |
| Clients in scope | **Claude Code** + **GitHub Copilot CLI** | Both are local surfaces. Cloud Copilot (coding agent, code review) is **out of scope** — that removes the long-lived static bearer work entirely. |
| Scale | Single user now | Team scale-out is Addendum A, not the main plan. |
| Azure subscription | Greenfield, **Pay-As-You-Go / MCA** | Marketplace purchase rights present → Foundry Claude is purchasable. Note the default quota problem in §5.3. |
| Brain data | **Greenfield** — nothing embedded yet | Embedding width is chosen at init. No migration, no re-embed bill. |
| Content ingestion | **API / MCP only.** No git-backed sources. | **No persistent file share needed.** This removes Azure Files Premium (~$20/mo) and all SMB-vs-git performance risk. |
| Budget posture | **Cheapest that works** | Burstable Postgres, scale-to-zero MCP app, `search.mode=conservative`, Haiku for cheap touchpoints. |
| Operating hours | **Scheduled: weekdays only, stopped nights + weekends** | ~$50/mo instead of ~$111. Postgres stopped and worker scaled to zero outside the window; morning warm-up preserves the dream cycle. See §10.3 and §15. |
| IaC | **Bicep + GitHub Actions (federated OIDC)** | Deployable files, no stored cloud credentials. |
| Models | **Foundry Claude (chat) + Azure OpenAI `text-embedding-3-small` (embeddings)** | Nothing else. No GPT chat, no Foundry open models. |
| Region | Cheapest that satisfies Claude availability → **East US 2** | See §5.1. East US 2 is the only region carrying both Claude hosting tiers at the lowest US price band. |

---

## 1. Executive summary

**gbrain needs almost no new code to run on Azure.** Two seams that already ship have exactly the shape Azure needs:

1. **Claude → Foundry.** `resolveNativeBaseUrl` (`src/core/ai/gateway.ts:444`) reads `ANTHROPIC_BASE_URL`, strips trailing slashes, and appends `/v1`. Both consumers — `instantiateExpansion` (`:2475`) and `instantiateChat` (`:3037`) — pass it straight into `createAnthropic({ apiKey, baseURL })`. `@ai-sdk/anthropic` sends the key as `x-api-key` and appends `/messages`. So:

   ```
   ANTHROPIC_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
   ```
   produces `POST https://<resource>.services.ai.azure.com/anthropic/v1/messages` with `x-api-key` — byte-for-byte Foundry's documented Claude contract. **Two environment variables, zero code.**

2. **Embeddings → Azure OpenAI.** `src/core/ai/recipes/azure-openai.ts` already exists and is registered (`src/core/ai/recipes/index.ts:51`). It declares **only** `touchpoints.embedding` — which is exactly what we want — and implements both extension points: `resolveAuth` returning the `api-key` header, and `resolveOpenAICompatConfig` templating `{ENDPOINT}/openai/deployments/{DEPLOYMENT}` with a fetch wrapper splicing `?api-version=`.

The total required code change is **six small edits**, none of which touch the provider registry, the `Implementation` union, the three factory switches, or the AI SDK dependency pins (§6).

**The deployment is a handful of Azure resources.** Container Apps environment, two container apps, one migration job, one Burstable Postgres, one Key Vault, one registry, one Foundry resource, one Log Analytics workspace. Roughly **$107–114/month** always-on, or **~$50/month** run on a weekday schedule with compute stopped nights and weekends — which is data-safe, because nothing here holds volatile state (§10.3, §15).

**Client integration is configuration, not code.** gbrain already ships a full OAuth 2.1 remote MCP server in `src/commands/serve-http.ts` on MCP SDK 1.29.0 — `mcpAuthRouter` for `/authorize` `/token` `/register` `/revoke`, RFC 9728 protected-resource metadata, and a stateless `StreamableHTTPServerTransport`. Claude Code and Copilot CLI both speak that contract today (§8).

---

## 2. What "everything in Azure" actually forces

This constraint is the single most shaping input. Three consequences that are easy to miss:

### 2.1 Claude must be the **v2 "Hosted on Azure"** deployment tier, not v1

Foundry offers Claude in two hosting versions:

- **Version 1 — "Hosted on Anthropic infrastructure."** Runs **outside Azure**, on Anthropic's own infrastructure, billed through Azure. Model list is wider (includes `claude-fable-5`, `claude-opus-4-7`, `claude-sonnet-4-6`).
- **Version 2 — "Hosted on Azure."** Runs on Azure infrastructure end-to-end. GA for `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`.

**Only v2 satisfies the constraint.** Choosing v1 would send prompts out of Azure while looking Azure-native on the invoice. This must be an explicit, documented deployment-time choice, and it narrows the usable model list to those four.

> Source: `https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models`

### 2.2 v2 rejects a feature set with `400 Bad Request` **by design**

Not supported on Hosted-on-Azure deployments: **structured outputs**, server-side tools (web search / web fetch / code execution / tool search), MCP connector, Agent Skills, programmatic tool calling, and the Files API. Globally unsupported on Foundry regardless of tier: Message Batches API, Models API, Admin API, server-side fallback.

**Impact on gbrain — one collision, and it is survivable.** `src/core/ai/gateway.ts:2566` calls `generateObject` on the native-provider branch for **query expansion**, with no per-call fallback (unlike the openai-compatible branch at `:2578`, which catches and falls back to `viaText()`).

Three facts make this a low-severity latent risk rather than a blocker:

1. The whole block is wrapped in a `try` whose `catch` at `:2603` fails open — `return [query]`. A 400 degrades expansion to "no expansion," it does not crash a search.
2. **`search.mode=conservative` disables expansion entirely** (`expansion: false` in the mode bundle). This deployment runs conservative, so the path is not exercised.
3. `@ai-sdk/anthropic` v3 may implement `generateObject` via **tool calling** rather than a `response_format` — and ordinary client-side tool calling *is* supported on v2. If so there is no collision at all.

**Action:** Phase 0 gate P0-4 tests this explicitly. Do not assume either outcome.

### 2.3 Regular tool calling still works, so the subagent lane is fine

"Programmatic tool calling" (the server-side tool-execution beta) is rejected; ordinary client-side tool definitions are not. gbrain's chat path passes tools through `toAISDKTools` (`gateway.ts:3237`) into a standard `tools:` parameter (`:3456`). That is normal Messages-API tool use and is supported.

---

## 3. Target architecture

```
                        ┌──────────────────────────────────────────┐
   Claude Code  ───────▶│  ca-gbrain-mcp   (external ingress, TLS) │
   Copilot CLI  ───────▶│  gbrain serve --http                     │
                        │  /mcp  /token  /authorize  /health       │
                        └───────────────┬──────────────────────────┘
                                        │ private endpoint
                        ┌───────────────▼──────────────────────────┐
                        │  pg-gbrain  (PostgreSQL Flexible Server) │
                        │  PG 17 + pgvector 0.8.2, port 5432       │
                        └───────────────▲──────────────────────────┘
                                        │
                        ┌───────────────┴──────────────────────────┐
                        │  ca-gbrain-worker (no ingress)           │
                        │  gbrain jobs supervisor                  │
                        └───────────────┬──────────────────────────┘
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              ▼                                                   ▼
   ┌──────────────────────┐                        ┌──────────────────────────┐
   │ aif-gbrain (Foundry) │                        │ oai-gbrain (Azure OpenAI)│
   │ claude-sonnet-5      │                        │ text-embedding-3-small   │
   │ claude-haiku-4-5     │  ← Hosted on Azure v2  │ 1536 dims                │
   └──────────────────────┘                        └──────────────────────────┘

   caj-gbrain-migrate (manual job)  ·  kv-gbrain  ·  acrgbrain  ·  id-gbrain (UAMI)
```

### 3.1 Resource table — cheapest-that-works SKUs

| Resource | Name | SKU / config | ~$/mo | Purpose |
|---|---|---|---|---|
| Container Apps Environment | `cae-gbrain` | Workload-profile type, Consumption profile, VNet-integrated, `/27` subnet delegated to `Microsoft.App/environments` | $0 | Runtime. Workload-profile type chosen so NAT Gateway / Premium ingress remain *possible* later; the Consumption profile inside bills identically to a consumption-only environment. |
| Container App | `ca-gbrain-mcp` | 0.5 vCPU / 1 GiB, **min=0** max=2, external ingress, managed cert | ~$8–15 | `gbrain serve --http`. Scale-to-zero. Cold start is acceptable (§3.3). |
| Container App | `ca-gbrain-worker` | 0.5 vCPU / 1 GiB, min=1, **ingress disabled** | ~$35 always-on / **~$13.50 scheduled** | `gbrain jobs supervisor`. Scaled to `min=0` outside operating hours (§15). |
| Container Apps Job | `caj-gbrain-migrate` | Manual trigger, 1 vCPU / 2 GiB | ~$0 | `gbrain apply-migrations --yes --non-interactive` |
| PostgreSQL Flexible Server | `pg-gbrain` | **B2s Burstable** (2 vCore / 4 GiB), PG 17, **32 GB** storage, **Private Link**, no HA | ~$53 always-on / **~$23 scheduled** | The brain. $49.64 compute + $3.68 storage. Provision 32 GB, not 64 — storage **only ever grows**, so start small and let autogrow handle it. |
| Key Vault | `kv-gbrain` | Standard | <$1 | Three secrets, versionless URIs. |
| User-assigned MI | `id-gbrain` | — | $0 | `AcrPull` + `Key Vault Secrets User`. |
| Container Registry | `acrgbrain` | Basic | ~$5 | The image. |
| AI Foundry | `aif-gbrain` | East US 2, **Hosted-on-Azure deployments only** | usage | Claude. |
| Azure OpenAI | `oai-gbrain` | East US 2, one embedding deployment | usage | Embeddings. |
| Log Analytics | `log-gbrain` | Pay-as-you-go, 30-day retention | ~$5 | Container logs. **Required** — the audit dir is ephemeral (§3.4). |

**Total infra ≈ $110–150/month.**

**Deliberately NOT used:**

- **Azure Files Premium** — not needed. No git-backed sources means nothing on disk must survive a restart. Saves ~$20/mo and removes the SMB/git performance risk entirely.
- **Azure Front Door** — does not support SSE, and costs $35/mo base for zero benefit here. Container Apps' own managed ingress provides TLS and a managed certificate.
- **API Management** — unjustifiable below roughly five users; its LLM policy suite was not verified in research.
- **Built-in PgBouncer** — see §3.2. It is also unavailable on Burstable, which is convenient rather than limiting.
- **Premium ingress** — see §3.3.
- **A separate admin Container App** — see §9.2. For single-user, the admin plane is disabled entirely and reached via `az containerapp exec`.

### 3.2 Connect direct to port 5432. Do not use PgBouncer.

This is not a preference. `isSupabasePoolerUrl` (`src/core/connection-manager.ts:108-120`) gates activation of gbrain's dual-pool machinery, and `src/core/db.ts:71` keys prepared-statement auto-disable on port **6543** — not Azure's **6432**. Behind Azure's transaction-mode pooler, `executeRawDirect` — the path that minion lock heartbeats (`src/core/minions/queue.ts:671`) and sync checkpoints depend on — silently collapses onto the shared read pool. That reintroduces the exact orphaned-lock / wedged-worker class the direct-pool code exists to prevent.

Direct 5432 also avoids the startup-parameter allowlist problem: gbrain sends `statement_timeout` and `idle_in_transaction_session_timeout` as **connection startup parameters** (`src/core/db.ts:238-254`), which a transaction-mode pooler must be explicitly configured to pass through.

Set `GBRAIN_POOL_SIZE=6`. B2s permits well above that.

**Convenient alignment:** PgBouncer is not offered on the Burstable tier at all, so the cheap SKU and the correct configuration agree.

### 3.3 No Premium ingress — the 4-minute idle timeout does not bite

Container Apps' default ingress idle timeout is 4 minutes, raisable to 30 only via Premium ingress on a dedicated D4–D32 workload profile. That would cost more than the rest of the deployment combined.

It is not needed, because gbrain's MCP surface has no long-lived server→client stream: `src/commands/serve-http.ts:2076` constructs `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as any })` — stateless — and `:1799-1802` deliberately returns 405 for `GET /mcp`. There is no SSE backchannel to time out. The 4 minutes is a **per-request** bound.

**The constraint this does impose:** any operation that could exceed 4 minutes must be a minion job, not a synchronous MCP tool call. That is already gbrain's design for bulk work (`submit_job` → worker), so no change is needed — but do not add a synchronous long-running op later without remembering this.

**Scale-to-zero is safe for the MCP app.** Claude Code applies a 60-second first-byte timer, and a Bun single-binary cold start plus a Postgres connect lands far inside that. Set per-server `"timeout": 120000` in the client config anyway (§8.1) for headroom.

### 3.4 Filesystem: ephemeral, with three environment variables pinned

With no git sources, nothing on disk must survive a restart. Use the container's own writable layer at `/data`.

gbrain resolves its home three different ways, and they disagree — this must be handled explicitly:

- `src/core/config.ts:1204` appends `.gbrain` to `GBRAIN_HOME`
- `src/core/brain-repo-durability.ts:96` does **not**
- `src/core/minions/supervisor.ts:132-145` ignores `GBRAIN_HOME` entirely and uses `$HOME/.gbrain/`

**Therefore set both `HOME=/data` and `GBRAIN_HOME=/data`, and pin the PID file and audit directory to absolute paths** rather than relying on inference (§7).

Because `/data` is ephemeral, the audit JSONL is lost on every restart. **Log Analytics is the durable audit sink** — this is why `log-gbrain` is a required resource, not an optional one.

---

## 4. Model plane

### 4.1 Routing table

| Touchpoint | gbrain model string | Code path | Azure surface | On failure |
|---|---|---|---|---|
| **chat** | `anthropic:claude-sonnet-5` | `native-anthropic` → `createAnthropic({apiKey, baseURL})` at `gateway.ts:3037` | Foundry v2 deployment `claude-sonnet-5` | **Fail fast.** No fallback. |
| **expansion** | `anthropic:claude-haiku-4-5` → resolves to `claude-haiku-4-5-20251001` | same seam, `gateway.ts:2475` | Foundry v2 deployment `claude-haiku-4-5-20251001` | Fails open to `[query]` at `gateway.ts:2603` (existing behavior). Not exercised under `conservative` mode. |
| **embedding** | `azure-openai:text-embedding-3-small` @ 1536d | `openai-compatible` → `resolveOpenAICompatConfig` | Azure OpenAI deployment `text-embedding-3-small` | **Fail fast.** |
| **reranker** | unset | — | — | — |
| everything else | not configured | — | — | — |

### 4.2 The deployment-name alias trap

`src/core/ai/recipes/anthropic.ts:48` declares `aliases: { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' }`. The **resolved** id is what lands in the wire `model` field. On Foundry, the `model` parameter carries the **deployment name**, and deployment names are **immutable after creation**.

**So: name the Foundry deployment `claude-haiku-4-5-20251001`** — the dated form — or name it undated and set `GBRAIN_EXPANSION_MODEL` to the dated id explicitly. Get this wrong and expansion 404s at first query with an opaque error.

### 4.3 Quota is the sharpest operational surprise

Default Claude quota on a **plain pay-as-you-go subscription** is **40 RPM / 40,000 uncached input TPM** for Opus/Sonnet-class, and 80 RPM / 80,000 ITPM for Haiku 4.5. (Enterprise/MCA-E gets 2,000 RPM / 2M ITPM. Free-trial subscriptions get zero.)

Forty requests per minute is fine for interactive querying and immediately throttling for any bulk enrichment or nightly cycle work. **Budget a quota-increase request as a Phase 1 prerequisite, not an afterthought.** Output tokens and cache reads do not count toward ITPM, which helps.

Separately: **Foundry strips Anthropic's `anthropic-ratelimit-*` response headers.** Any adaptive throttling that reads them sees nothing. Backpressure must come from 429-driven exponential backoff plus Azure Monitor metrics. gbrain's existing backoff (`src/core/backoff.ts`) is 429-driven, so this is survivable — but observability comes from Azure, not from headers.

### 4.4 Embeddings at 1536 dimensions. Never 3072.

`src/core/vector-index.ts:19` sets `PGVECTOR_HNSW_VECTOR_MAX_DIMS = 2000`, and `chunkEmbeddingIndexSql` **silently emits a SQL comment instead of an index** above that width. Azure Postgres independently refuses hnsw/ivfflat above 2000 dims.

So `text-embedding-3-large` at its native 3072 would store fine and then sequential-scan forever, **with no error at any layer**. Use `text-embedding-3-small` at 1536.

`src/core/ai/dims.ts:281-299` already carries the `text-embedding-3-*` openai-compat branch — documented in-file as the Azure path — with 1..1536 range validation. This works unmodified.

### 4.5 Why we do not build a `foundry-claude` recipe

Tempting, and wrong. Three mechanisms are keyed on the literal recipe id `anthropic`:

1. `cache_control` markers are applied in `chat()` **only** when `recipe.id === 'anthropic'` (`gateway.ts:3338-3415`). A new id silently forfeits prompt caching — a 5–10x cost inflation on subagent loops.
2. `test/ai/gateway-chat.test.ts:48-61` forbids any other recipe from claiming `supports_prompt_cache`.
3. `CANONICAL_PRICING` in `src/core/model-pricing.ts` is keyed `provider:model` and `canonicalLookup` does **not** fall back across provider prefixes. A `foundry-claude:claude-sonnet-5` key would not exist, so every `--max-cost` caller hard-fails with `BudgetExhausted(reason:'no_pricing')`.

Additionally, `test/ai/recipes-existing-regression.test.ts:186-195` asserts that `azure-openai` is the **only** openai-compatible recipe declaring `resolveAuth` — an IRON RULE test that a second Azure-family recipe would break.

**Reuse the `anthropic` recipe id and point its base URL at Foundry.** Add a comment at the config site so a future "cleanup" cannot quietly undo this.

### 4.6 Accepted limitation: all-Foundry or all-direct

There is one `anthropic` recipe id and one global `ANTHROPIC_BASE_URL`. There is no per-call escape. Under this plan that is the desired behavior — everything goes to Foundry — but it means a future "route Opus to Foundry, Haiku direct" split is not a config change.

---

## 5. Region and procurement

### 5.1 Region: East US 2

Claude deployment regions are narrow and asymmetric:

- **v1 (Anthropic-hosted):** `eastus2`, `swedencentral` only.
- **v2 (Hosted on Azure):** `centralus`, `eastus`, `eastus2`, `northcentralus`, `southcentralus`, `westcentralus`, `westus`, `westus3`, `swedencentral`.

East US 2 is in the lowest US price band, carries both tiers, and has full Azure OpenAI coverage. Co-locate everything there.

Note: you *can* deploy Claude in one region and call it from another — the restriction applies to the Foundry project, not the caller. Not needed here since everything is in East US 2.

**If an EU data-residency requirement ever appears:** Claude on Foundry cannot satisfy it today. Data Zone Standard is US-only, and Sweden Central Global Standard still processes globally. That would be a re-plan, not a config change.

### 5.2 Marketplace eligibility — confirmed available

Claude in Foundry requires an Azure Marketplace subscription plus pay-as-you-go billing, and needs `Microsoft.MarketplaceOrdering/*` and `Microsoft.SaaS/*` on the subscription. Unsupported: CSP subscriptions, Enterprise accounts in South Korea, credit-only / sponsored / student / free-trial subscriptions.

The target is **Pay-As-You-Go / MCA with Owner rights**, so this is satisfied. Phase 0 still verifies it with a real command before any other spend (P0-1).

### 5.3 Billing

Claude in Foundry bills in **Claude Consumption Units** at a fixed **$0.01/CCU**, rated from the standard per-model Claude API prices. It is **price-neutral versus the direct API** (the US Data Zone option carries a 1.1x multiplier; we are not using it).

Current list prices (input/output per MTok): Sonnet 5 `$2/$10` through 2026-08-31 then `$3/$15`; Haiku 4.5 `$1/$5`; Opus 5 `$5/$25`. Cache read is 0.1x base input; 5-minute cache write 1.25x.

---

## 6. Required code changes

Six edits. None touch the provider registry, the `Implementation` union, the three factory switches, or the AI SDK pins.

| # | File | Change | Severity |
|---|---|---|---|
| 1 | `src/core/embedding-pricing.ts` | Add `azure-openai:text-embedding-3-small` / `-3-large` / `-ada-002` rows. **Confirmed: the table has zero `azure-openai` keys today.** `BudgetTracker.lookupPricing` (`src/core/minions/budget-tracker.ts:177-221`) hard-throws `BudgetExhausted(reason:'no_pricing')` at `:297-300`, so Azure embeddings under any `--max-cost` caller fail today. **VERIFY the numbers** against `azure.microsoft.com/pricing/details/cognitive-services/openai-service/` — the Retail Prices API returns nothing for these meters. | **Required** |
| 2 | `src/core/minions/protected-names.ts` | Add `'import'` and `'sync'` to `PROTECTED_JOB_NAMES`. **P0 security.** `submit_job` is `scope:'admin'` with **no `localOnly`** (`src/core/operations.ts:3030`), and the import/sync handlers accept an arbitrary absolute `dir` / `repoPath`. The existing set correctly protects `shell`, `subagent`, `subagent_aggregator`, `synthesize`, `patterns`, `consolidate`, `contextual_reindex_per_chunk` — but not these two. Enforced twice independently (`operations.ts:3057`, `queue.ts:90`). | **P0** |
| 3 | `src/commands/serve-http.ts:2076` | Pass `enableDnsRebindingProtection: true` plus `allowedHosts` / `allowedOrigins` to `StreamableHTTPServerTransport`. SDK 1.29.0 ships the middleware (post-CVE-2025-66414); it is simply not passed. The MCP spec mandates `Origin` validation with 403. | **P0** |
| 4 | `src/commands/serve-http.ts:1804` | Add a rate limiter to `POST /mcp`, mirroring `ingestRateLimiter` at `:2113`. The buckets SECURITY.md documents live only in the superseded `src/mcp/http-transport.ts`. | **P0** |
| 5 | `src/commands/serve-http.ts` (admin router mount, `:1014` onward) | Add an env-gated `GBRAIN_DISABLE_ADMIN=1` that skips mounting the entire `/admin` tree. **There is no such flag today** — `/admin/login` (`:1078`), `/admin/api/issue-magic-link` (`:1148`) and `/admin/auth/:token` (`:1171`) mount unconditionally on the same Express app and the same public port as `/mcp`. `/admin/login` has **no rate limiter** (only `/admin/auth/:token` has `adminAuthRateLimiter`). ~5 lines. See §9.2. | **P0** |
| 6 | `src/commands/serve-http.ts:1017-1026` | Pass `resourceServerUrl: new URL('/mcp', issuerUrl)` to `mcpAuthRouter`, plus the first test for `/.well-known/oauth-protected-resource`. | Recommended |

**Plus, per repo convention:** update `docs/architecture/KEY_FILES.md` in place (current-state only, no `**vX.Y.Z:**` clauses — `scripts/check-key-files-current-state.sh` fails otherwise) and run `bun run build:llms` in the same commit.

---

## 7. Environment variables

Applied to **both** `ca-gbrain-mcp` and `ca-gbrain-worker` unless noted.

```bash
# --- database ---
GBRAIN_DATABASE_URL=<keyvault-secretref>        # ...:5432/gbrain?sslmode=require  (NOT 6432)
GBRAIN_POOL_SIZE=6

# --- HTTP surface (mcp app only) ---
GBRAIN_PUBLIC_URL=https://brain.example.com
GBRAIN_HTTP_TRUST_PROXY=1                       # default 'loopback' collapses every
                                                # rate-limit bucket onto the envoy IP
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=<keyvault-secretref>   # must match ^[A-Za-z0-9_-]{32,}$
                                                    # or the process refuses to start
GBRAIN_DISABLE_ADMIN=1                          # requires code change #5

# --- models: Claude via Foundry (Hosted-on-Azure v2) ---
ANTHROPIC_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
ANTHROPIC_API_KEY=<keyvault-secretref>          # the Foundry key, sent as x-api-key
GBRAIN_CHAT_MODEL=anthropic:claude-sonnet-5
GBRAIN_EXPANSION_MODEL=anthropic:claude-haiku-4-5

# --- models: embeddings via Azure OpenAI ---
GBRAIN_EMBEDDING_MODEL=azure-openai:text-embedding-3-small
GBRAIN_EMBEDDING_DIMENSIONS=1536
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=text-embedding-3-small
AZURE_OPENAI_API_KEY=<keyvault-secretref>

# --- filesystem (see §3.4 — all three are load-bearing) ---
HOME=/data
GBRAIN_HOME=/data
GBRAIN_AUDIT_DIR=/data/.gbrain/audit
GBRAIN_SUPERVISOR_PID_FILE=/data/.gbrain/supervisor.pid    # worker app only
```

### 7.1 Never set these

| Variable / flag | Why |
|---|---|
| `GBRAIN_ALLOW_SHELL_JOBS` | Re-enables the shell job lane. |
| `GBRAIN_ALLOW_PRIVATE_REMOTES` | SSRF surface. |
| `GBRAIN_GIT_ALLOW_FILE_TRANSPORT` | Local-file git transport. |
| `GBRAIN_NO_SANITY` | Disables content sanity checks. |
| `GBRAIN_ALLOW_MASS_RECONCILE` | Mass link rewrite. |
| `AZURE_OPENAI_USE_ENTRA` | **Cannot work in a container.** `src/core/ai/recipes/azure-openai.ts:12-56` implements it via `execSync('az account get-access-token …')` — a synchronous shell-out on the request path, and there is no Azure CLI in the image. Managed identity for the model plane is a future rewrite to IMDS, not a config toggle. |
| `--enable-dcr` / `--enable-dcr-insecure` | Dynamic client registration open to the internet. Register clients manually. |
| `--log-full-params` / `--print-admin-token` | Secret leakage into logs. |

---

## 8. Client integration

### 8.0 Credentials — use OAuth clients, never `gbrain auth create`

Legacy `access_tokens` rows created by `gbrain auth create` are grandfathered to `['read','write','admin']` with a synthetic one-year expiry (`src/core/oauth-provider.ts:706-736`). Use OAuth `client_credentials` clients instead — they carry real scopes, source scoping, and per-client budgets:

```bash
gbrain auth register-client claude-code \
  --grant-types client_credentials \
  --scopes "read write" \
  --source <source-id> \
  --token-endpoint-auth-method client_secret_post

gbrain auth register-client copilot-cli \
  --grant-types client_credentials \
  --scopes read \
  --source <source-id>
```

All flags above are verified against `src/commands/auth.ts:384-448`.

Run these via `az containerapp exec` into the running MCP container (§9.2).

### 8.1 Claude Code

**Preferred — OAuth, no token in any file.** gbrain already serves RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource` and returns `WWW-Authenticate: Bearer resource_metadata="<URL>"` on 401 (`src/commands/serve-http.ts:990-1001`). Claude Code discovers it automatically:

```bash
claude mcp add --transport http gbrain https://brain.example.com/mcp --scope user
claude mcp login gbrain          # v2.1.186+;  add --no-browser for SSH/headless
```

**Alternative — dynamic headers, self-healing.** `headersHelper` runs a shell command (10s timeout) that prints a JSON object of headers. Claude Code re-runs it and retries once on 401/403, so expiry self-heals and no token lands in a config file:

```json
{
  "mcpServers": {
    "gbrain": {
      "type": "http",
      "url": "https://brain.example.com/mcp",
      "headersHelper": "/usr/local/bin/gbrain-token.sh",
      "timeout": 120000
    }
  }
}
```

**Static bearer fallback:**

```bash
claude mcp add -t http gbrain https://brain.example.com/mcp \
  -H "Authorization: Bearer <token>" --scope user
```

**Two footguns:**

- In JSON config, `"type": "http"` is **required**. An entry with a `url` and no `type` is a configuration error and the server is **silently skipped** with `MCP server "<name>" has a "url" but no "type"`.
- Claude Code applies a **60-second first-byte timer**. Set `"timeout": 120000` per server for cold-start headroom.

Scopes resolve local > project > user, and the entire winning entry is used — fields are **not** merged across scopes.

### 8.2 GitHub Copilot CLI

Copilot CLI has its own MCP surface, distinct from VS Code's:

```bash
copilot mcp add
```

writes to `~/.copilot/mcp-config.json` (relocatable via `COPILOT_HOME`), top-level key **`mcpServers`**. Manage in interactive mode with `/mcp show|edit|delete|disable`.

**Config-key mismatch is a real cross-surface footgun:** Claude Code and Copilot CLI use `mcpServers`; VS Code Copilot Chat uses `servers`. Any snippet published for this deployment must be per-surface.

**Prerequisite:** every Copilot MCP surface is gated behind the org/enterprise policy **"MCP servers in Copilot"**, which was **disabled by default** at GA (2025-08-13). Research could not confirm whether that default has since flipped. **Verify with a GitHub org admin before assuming Copilot connects out of the box** (Phase 0 gate P0-6).

### 8.3 Bonus: Copilot CLI can also run its *own* model traffic inside Azure

This is worth calling out because it is the only client path that fully honors the no-third-party constraint end to end.

Copilot CLI supports **BYOK via environment variables only**:

```bash
COPILOT_PROVIDER_BASE_URL=<required>
COPILOT_PROVIDER_TYPE=openai          # default
COPILOT_PROVIDER_API_KEY=<key>
COPILOT_MODEL=<required>
```

Confirmed to support Azure OpenAI Service, Microsoft Foundry, and any OpenAI-Chat-Completions-compatible endpoint. Models must support tool calling and streaming; 128k context recommended.

**Asymmetry to be explicit about:** gbrain's *stored data* stays in Azure under this plan regardless of client. But the *client's own* prompt traffic is a separate boundary:

- **Copilot CLI + BYOK → Azure.** Fully inside the boundary. **Confirmed.**
- **Claude Code → Anthropic** by default. Whether Claude Code can be pointed at a Foundry Claude endpoint was **not verified** in research. It supports Bedrock and Vertex via environment flags; a Foundry equivalent is plausible but unconfirmed. **Treat as VERIFY-FIRST (P0-7)** — do not promise it.

If the constraint must hold for client traffic too, Copilot CLI with BYOK is currently the only proven path.

### 8.4 Enable skill publication

```bash
gbrain config set mcp.publish_skills true
```

It is default-off on upgraded brains, and every agent following gbrain's own `LEARN_INSTRUCTION` calls `list_skills` on turn one.

### 8.5 Tool-discoverability risk

Claude Code truncates MCP tool descriptions **and** server instructions at **2KB each** under tool search (on by default). gbrain exposes ~106 operations. Discoverability therefore depends on concise server `instructions` — this is a routing-quality risk, not cosmetics. It is the same two-layer-dispatch problem gbrain's own `functional-area-resolver` skill solves; consider applying that pattern to the MCP server instructions string.

---

## 9. Security

### 9.1 Hardening checklist, ordered by severity

1. **Code change #2** — `import` / `sync` into `PROTECTED_JOB_NAMES`. `submit_job` is `scope:'admin'` with no `localOnly`; the handlers take arbitrary absolute paths.
2. **Code change #5** — `GBRAIN_DISABLE_ADMIN=1`, then set it. See §9.2.
3. **Code change #3** — DNS-rebinding protection / `Origin` validation on the MCP transport.
4. **Code change #4** — rate limit `POST /mcp`.
5. **Postgres on Private Link only.** No public network access. The container apps reach it through the delegated subnet.
6. **Register OAuth clients with the narrowest scope that works** — `read` only for Copilot CLI, `read write` for Claude Code. Never `admin`.
7. **Exclude `sources_list` and `sources_status`** from any tool allowlist you publish to a client. Both are `scope:'read'` with no grant filtering (`src/core/operations.ts:4043`, `:4098`) and disclose every source's host `local_path` and `remote_url` — cross-source metadata disclosure that chains directly into the `submit_job` path closed by change #2.
8. **Never `--enable-dcr`.** Register clients by hand.
9. **Spend controls before the first query:** `spend.posture gated`, `search.mode conservative`, `embed.backfill_max_usd_per_source_24h 25`, `pace.mode gentle`, and per-client `--budget-usd-per-day`.
10. **Verify `mcp_spend_log` exists after migration.** `getTodaySpendCents` **fails open to 0** when the table is missing (`src/core/spend-log.ts:54-58`), silently deleting every cap.

### 9.2 The admin plane: disable it, don't hide it

`/admin` mounts unconditionally on the same Express app and the same public port as `/mcp`. There is **no flag to turn it off today** and Container Apps IP restrictions apply per-app, not per-path — so you cannot allowlist `/admin` without also allowlisting `/mcp`, which breaks a roaming laptop.

**For single-user, do not run an admin web plane at all.** Implement code change #5, set `GBRAIN_DISABLE_ADMIN=1`, and do administration through the CLI inside the container:

```bash
az containerapp exec -n ca-gbrain-mcp -g rg-gbrain --command /bin/sh
# then: gbrain auth register-client ... / gbrain config set ... / gbrain doctor
```

This is cheaper than a second container app **and** strictly safer — the admin login surface never exists on the internet. Addendum A reintroduces an internal-ingress admin app for team scale.

### 9.3 Accepted risk: RLS will be silently skipped

`src/schema.sql:1393-1442` enables RLS only when the role holds `BYPASSRLS` or superuser. **Azure's Postgres admin role is neither.** `gbrain doctor`'s `rls` check will fail permanently on this deployment.

This is acceptable here **only because**:
- Private Link means nothing but gbrain's own containers can open a session, and
- gbrain's RLS carries **zero policies anywhere** — it was only ever an anon-key / PostgREST defense for the Supabase topology.

**But migration v35's auto-RLS backfill (`src/core/migrate.ts:1741-1795`) hard-aborts on the same role predicate**, which would leave `config.version` stuck part-way. **This is the single most likely day-one blocker.** Phase 0 gate P0-2 tests it against a throwaway server before any real spend.

---

## 10. Cost model

### 10.1 Infrastructure — always-on baseline vs scheduled

**Recommended posture is the scheduled column.** Nothing in this deployment holds volatile state, so stopping compute overnight and at weekends is data-safe (§15).

| Line | Always-on $/mo | **Scheduled $/mo** |
|---|---|---|
| PostgreSQL B2s Burstable (2 vCore / 4 GiB) | 49.64 | **19.21** |
| Postgres storage, 32 GB @ $0.115/GB | 3.68 | 3.68 |
| Postgres backup | **0** | **0** |
| `ca-gbrain-worker` — 0.5 vCPU / 1 GiB | ~35 | **~13.50** |
| `ca-gbrain-mcp` — 0.5 vCPU / 1 GiB, min=0 | ~8–15 | ~5 |
| Container Registry Basic | 5 | 5 |
| Log Analytics | ~5 | ~3 |
| Key Vault Standard | <1 | <1 |
| **Total** | **~$107–114** | **~$50** |

**Backup is free.** Azure Database for PostgreSQL Flexible Server includes backup storage up to 100% of provisioned storage at no charge, and default retention is 7 days. At 32 GB provisioned this line is $0. *(An earlier draft of this plan carried ~$6/mo here. That was wrong.)*

Container Apps consumption list (East US): $0.000024/vCPU-second active, $0.000003/GiB-second active, $0.40 per 1M requests — roughly $62/vCPU/month and $7.90/GiB/month equivalent. Worker cost depends on how Container Apps classifies a DB-polling supervisor between active and idle rates; treat the ~$35 figure as an upper bound.

**If HNSW index builds stall on B2s**, step up to D2ds_v5 (2 vCore General Purpose, $0.178/hr ≈ $130/mo). Watch for it during the first bulk embed. This is the most likely SKU regret.

**Better than living on a bigger SKU:** Flexible Server compute scaling needs a restart but no data migration. **Scale up for the one-time bulk embed and index build, then scale straight back down.** You pay General Purpose rates for hours, not months.

### 10.3 The scheduled posture — how the ~$50 is reached

Operating window: **Mon–Fri 06:00–19:00** = 65 hours of 168 = a **38.7% duty cycle**. Compute lines scale by that factor; storage, registry and Key Vault do not.

Four changes from the always-on baseline:

1. **Stop Postgres outside the window.** `az postgres flexible-server stop` halts compute billing. Storage keeps billing; data is untouched. $49.64 → $19.21.
2. **Scale the worker to `min-replicas 0` outside the window.** The supervisor receives SIGTERM and stops gracefully (it waits up to 40s). ~$35 → ~$13.50.
3. **Provision 32 GB, not 64.** $7.36 → $3.68. One-way in the cheap direction — storage grows but never shrinks.
4. **Trim Log Analytics retention.** ~$5 → ~$3.

**The MCP app needs no explicit stop.** It already runs at `min=0` and bills only on request, so with no traffic outside the window it costs nothing. If you want a hard stop anyway, deactivate its revision (§15.4).

**The model plane costs nothing idle.** Foundry and Azure OpenAI are pure pay-per-token. There is nothing to schedule.

**Aggressive variant:** B1ms instead of B2s → $12.41 × 0.387 = **$4.80**, total ≈ **$36/mo**. Only 1 vCore / 2 GiB — expect visible HNSW query latency. Combine with the scale-up-for-index-build trick above rather than living on B1ms during a bulk embed.

#### What the schedule costs you: the dream cycle

This is the real tradeoff and it should be a conscious one. gbrain's nightly consolidation — `synthesize`, `patterns`, `consolidate`, `extract-takes` — is designed to run while you sleep. Shut everything down overnight and it never runs, which removes a meaningful part of what the brain is for.

**Mitigation: a morning warm-up window.** Start Postgres at 06:00, let the worker drain the cycle from 06:05, and bring the MCP app up at 07:00 for interactive use. That is the window already priced above — one extra hour of compute per day (~$1.50/mo) buys back the whole overnight-enrichment behavior, just time-shifted.

#### Cost gotchas

- **Do NOT move to a Dev/Test subscription for the discount.** Credit-based, sponsored and dev/test subscriptions are excluded from Azure Marketplace purchase, which would block Claude in Foundry entirely and kill the model plane (§5.2).
- **Reserved capacity and scheduled-stop are mutually exclusive.** A 1-year Postgres reservation bills whether the server runs or not (~40% off). Scheduled stop at a 38.7% duty cycle is ~61% off. Take the stop; do not buy both.
- **Azure force-starts a stopped Flexible Server after 7 days.** A long holiday will not keep it off — the stop must be re-issued. *Confirm the current limit against Azure docs before relying on it.*
- **PgBouncer remains unavailable on Burstable**, which is what §3.2 wants anyway. No conflict.

### 10.2 Model spend

At `search.mode=conservative` with Sonnet 5 for chat and Haiku 4.5 where cheap work suffices, gbrain's **own** LLM usage at single-user volume lands around **$15–60/month**. Foundry is price-neutral versus the direct API.

This excludes your Claude Code / Copilot subscription token spend, which is a separate bill.

**The highest-leverage cost lever is `search.mode`, not any SKU in this plan** — the corner-to-corner spread between `conservative`+Haiku and `tokenmax`+Opus is 25x on downstream agent input cost.

---

## 11. Phase 0 — verification gates

**Run all of these against throwaway resources before committing to any topology.** Each one can invalidate a phase.

| ID | Gate | How | If it fails |
|---|---|---|---|
| **P0-1** | Marketplace / Foundry Claude purchasable on this subscription | `az provider show -n Microsoft.MarketplaceOrdering`, `az provider show -n Microsoft.SaaS`; attempt a Foundry Claude deployment in East US 2 | The Azure-resident Claude requirement cannot be met. Stop and escalate — there is no fallback by decision. |
| **P0-2** | **Migration v35 RLS backfill completes on Azure Postgres** | Create a throwaway B1ms Flexible Server, run `gbrain apply-migrations --yes --non-interactive`, confirm `config.version` reaches head | Highest-probability day-one blocker (§9.3). Needs a code fix to the role predicate in `migrate.ts:1741-1795` before Phase 2. |
| **P0-3** | Foundry Claude round-trip through gbrain's existing seam | Set `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` locally, run a `gbrain think` / chat op against a `claude-sonnet-5` v2 deployment | The two-env-var thesis is wrong and the plan needs a transport change. Re-scope before any Azure build-out. |
| **P0-4** | `generateObject` behavior on Hosted-on-Azure | Force `search.mode=tokenmax` locally against the Foundry endpoint and run a query that triggers expansion; watch for a 400 | Confirms whether §2.2 is a real collision. If it 400s: leave `conservative` mode (expansion off) and file a follow-up to give the native branch the same `catch → viaText()` fallback the openai-compatible branch already has. |
| **P0-5** | HNSW build completes on B2s at target corpus size | Bulk-embed a representative sample, `CREATE INDEX` on `content_chunks`, time it | Step up to D2ds_v5 and re-cost. |
| **P0-6** | GitHub org policy "MCP servers in Copilot" is enabled | Ask a GitHub org admin | Copilot CLI integration is blocked until an admin enables it. Claude Code path is unaffected. |
| **P0-7** | Can Claude Code itself be pointed at Foundry Claude? | Check current Claude Code docs for a Foundry/Azure provider flag alongside Bedrock/Vertex | If no: Claude Code's own traffic leaves Azure. Decide whether that is acceptable, or standardize on Copilot CLI + BYOK (§8.3). |
| **P0-8** | Azure OpenAI embedding prices for change #1 | Read `azure.microsoft.com/pricing/details/cognitive-services/openai-service/` directly — the Retail Prices API returns nothing for these meters | Budget caps cannot be trusted until the table is right. |

---

## 12. Phased implementation

### Phase 0 — Verify (no production spend)
**Goal:** prove every load-bearing assumption before building.
- Run all eight gates in §11.
- Throwaway resource group, deleted at the end.

**Exit:** P0-1, P0-2, P0-3 all pass. P0-4 through P0-8 answered and recorded.

---

### Phase 1 — Code changes
**Goal:** land the six edits on a branch, merged before any Azure resource is created.

**Work items:**
- `src/core/embedding-pricing.ts` — Azure OpenAI embedding rows (verified numbers from P0-8).
- `src/core/minions/protected-names.ts` — add `import`, `sync`.
- `src/commands/serve-http.ts:2076` — DNS-rebinding protection.
- `src/commands/serve-http.ts:1804` — `POST /mcp` rate limiter.
- `src/commands/serve-http.ts` admin mount — `GBRAIN_DISABLE_ADMIN` gate.
- `src/commands/serve-http.ts:1017-1026` — `resourceServerUrl` on `mcpAuthRouter` + PRM test.
- Comment at the `ANTHROPIC_BASE_URL` config site explaining §4.5.
- Tests for each; update `docs/architecture/KEY_FILES.md` in place; `bun run build:llms` in the same commit.
- Ship via `/ship` — do not hand-roll the release.

**Exit:** `bun run ci:local` green. New tests cover each change. Version trio (VERSION / package.json / CHANGELOG) agrees.

---

### Phase 2 — Azure foundation (Bicep)
**Goal:** every resource except the model plane, deployed from code.

**Work items:**
- `infra/main.bicep` + `infra/modules/{network,postgres,keyvault,acr,containerapps,observability}.bicep`
- Resource group `rg-gbrain` in `eastus2`
- VNet with a `/27` subnet delegated to `Microsoft.App/environments`; a second subnet for the Postgres private endpoint
- `pg-gbrain` — B2s Burstable, PG 17, **32 GB storage with autogrow on**, Private Link, public access disabled; `azure.extensions` including `vector`
- `kv-gbrain` + three secrets; `id-gbrain` UAMI with `Key Vault Secrets User` + `AcrPull`
- `acrgbrain` Basic; `log-gbrain` Log Analytics
- `cae-gbrain` Container Apps environment, workload-profile type, VNet-integrated

**Exit:** `az deployment group create` succeeds from a clean subscription. Postgres reachable only from the delegated subnet.

---

### Phase 3 — Image and migration
**Goal:** gbrain running against Azure Postgres with a head-of-line schema.

**Work items:**
- `Dockerfile` — build the binary with `bun build --compile --outfile bin/gbrain src/cli.ts`; runtime stage needs no Bun. Confirm no native deps require a heavier base.
- `.github/workflows/deploy.yml` — federated OIDC login, build, push to ACR, `az containerapp update`
- `caj-gbrain-migrate` Container Apps Job → `gbrain apply-migrations --yes --non-interactive`, with `GBRAIN_STATEMENT_TIMEOUT` raised
- Run the job to completion **before** promoting any serving revision

**Exit:** `config.version` at head. `mcp_spend_log` exists (§9.1 item 10). RLS check documented as expected-fail.

> **Why a separate job:** `initSchema` holds `pg_advisory_lock(42)` for the whole replay (`src/core/postgres-engine.ts:430`), and `CREATE INDEX CONCURRENTLY` runs under the standard 5-minute `statement_timeout` on Azure — the 30-minute DDL pool only activates for Supabase-shaped URLs (`src/core/connection-manager.ts:108-120`).

---

### Phase 4 — Model plane
**Goal:** Claude and embeddings both answering, both inside Azure.

**Work items:**
- `aif-gbrain` Foundry resource in `eastus2`
- Deploy `claude-sonnet-5` — **Hosted-on-Azure (v2) only**, verified in the portal, not v1
- Deploy `claude-haiku-4-5-20251001` — **the dated deployment name** (§4.2)
- `oai-gbrain` Azure OpenAI resource + `text-embedding-3-small` deployment
- Keys into Key Vault; environment variables per §7
- **File the Claude quota-increase request** (§4.3) — default 40 RPM will throttle bulk work
- `gbrain config set search.mode conservative`; `spend.posture gated`; `pace.mode gentle`

**Exit:** a `gbrain query` returns a synthesized answer with citations. Embeddings written at 1536d. An HNSW index exists on `content_chunks` (not a SQL comment — verify with `\d+`).

---

### Phase 5 — Serve and connect
**Goal:** Claude Code and Copilot CLI both talking to the brain.

**Work items:**
- `ca-gbrain-mcp` (min=0, max=2, external ingress, managed cert, custom domain)
- `ca-gbrain-worker` (min=max=1, no ingress)
- `GBRAIN_DISABLE_ADMIN=1`; `GBRAIN_HTTP_TRUST_PROXY=1`
- Register OAuth clients via `az containerapp exec` (§8.0)
- `gbrain config set mcp.publish_skills true`
- Client config per §8.1 / §8.2
- Live-verify the three items research could not confirm from source alone: the exact `/.well-known/oauth-protected-resource` JSON, that the 401 `WWW-Authenticate` carries `resource_metadata` **and** a `scope` parameter, and that `claude mcp add --transport http` + `claude mcp login` round-trips

**Exit:** `claude mcp list` shows gbrain connected. A tool call from Claude Code returns brain data. Copilot CLI ditto (subject to P0-6). Cold start from scale-zero completes inside Claude Code's 60s first-byte timer.

---

### Phase 6 — Operational hardening
**Goal:** safe to leave running.

**Work items:**
- Azure Monitor alerts: Postgres CPU/storage, container restarts, Foundry 429 rate (the only backpressure signal — headers are stripped, §4.3)
- Log Analytics queries for the audit trail (durable sink; `/data` is ephemeral)
- Postgres backup retention + a restore drill
- Per-client `--budget-usd-per-day`
- Document the `az containerapp exec` admin runbook
- Confirm `gbrain doctor` output, with the RLS failure explicitly annotated as expected (§9.3)
- **Scheduled operation (§15):** write `scripts/azure/{start,stop,verify}.sh`, add `.github/workflows/schedule.yml`, and run one full stop→start→verify cycle by hand via `workflow_dispatch` before trusting the cron
- **Failure notification on the schedule workflow** — a silently failed 06:00 start is otherwise discovered at 09:00 by a broken Claude Code connection
- Re-check the first month's Azure invoice against the §10.1 scheduled column; a drift means the duty cycle is not what the cron claims

**Exit:** alerts firing correctly in a test. A restore drill completed. Runbook written.

---

## 13. Bicep + GitHub Actions layout

```
infra/
  main.bicep                    # subscription-scope: RG + module wiring
  main.parameters.json
  modules/
    network.bicep               # VNet, /27 ACA subnet, PE subnet, private DNS zone
    postgres.bicep              # Flexible Server B2s, private endpoint, azure.extensions
    keyvault.bicep              # KV + UAMI role assignments
    acr.bicep
    observability.bicep         # Log Analytics
    containerapps-env.bicep     # workload-profile environment
    containerapp-mcp.bicep      # external ingress, min=0
    containerapp-worker.bicep   # no ingress, min=1
    job-migrate.bicep           # manual-trigger job
    foundry.bicep               # AI Foundry + Azure OpenAI + deployments
.github/workflows/
  deploy.yml                    # OIDC login → build → ACR push → containerapp update
  infra.yml                     # what-if on PR, deploy on merge
```

**Federated OIDC** — no stored cloud credentials:

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: azure/login@v2
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

Pin action SHAs per the repo's existing convention (see `docs/RELEASING.md`).

**Model deployments in Bicep:** Foundry/Azure OpenAI model deployments are expressible as `Microsoft.CognitiveServices/accounts/deployments`, but the **Marketplace purchase step for Claude may require a portal or CLI action outside the ARM template**. Treat Phase 4 as partially manual until proven otherwise — do not block the deployment pipeline on fully declarative Claude provisioning.

---

## 14. Accepted risks

| Risk | Detail | Mitigation |
|---|---|---|
| **Migration v35 RLS abort** | `migrate.ts:1741-1795` hard-aborts when the role lacks `BYPASSRLS`. Azure's admin role does. | Phase 0 gate P0-2. Most likely blocker. |
| **`gbrain doctor` RLS check fails forever** | Same root cause. Zero policies exist, so no real exposure behind Private Link. | Documented as expected-fail in the runbook. |
| **40 RPM Foundry quota** | Pay-as-you-go default. Throttles bulk work immediately. | Quota-increase request in Phase 4. |
| **No `anthropic-ratelimit-*` headers** | Foundry strips them. Adaptive throttling sees nothing. | 429-driven backoff (already how `src/core/backoff.ts` works) + Azure Monitor. |
| **No fallback, by decision** | Foundry outage → chat and embedding touchpoints fail. | Explicit user decision. Alert on Foundry 5xx. |
| **Single MCP replica ceiling** | Admin sessions, magic-link nonces and every `express-rate-limit` bucket are in-process Maps (`serve-http.ts:696-710`, `:1130-1143`, `:777`). | Fine to ~20 users. Beyond that needs an external session store gbrain has no seam for. See Addendum A. |
| **Ephemeral `/data`** | Audit JSONL lost on restart. | Log Analytics is the durable sink. |
| **Scheduled operation drops the overnight cycle** | Shutting down nights and weekends means `synthesize` / `patterns` / `consolidate` never run while you sleep — a real loss of what the brain is for. | Morning warm-up window: Postgres up at 06:00, worker drains the cycle from 06:05, MCP up at 07:00 (§10.3). Costs ~$1.50/mo. |
| **Silent scheduler failure** | A failed 06:00 start surfaces at 09:00 as a broken Claude Code connection, not as an alert. | Failure notification on the schedule workflow (§15.5). |
| **Postgres force-starts after 7 days** | Azure will not leave a Flexible Server stopped indefinitely. A long holiday re-incurs compute. | Re-issue the stop. Confirm the current limit against Azure docs. |
| **AI SDK one major behind** | gbrain pins `ai ^6.0.168`; current is 7.0.44 (providers at v4). | **Do not upgrade as part of this work.** The plan deliberately avoids `@ai-sdk/azure` precisely so no v6→v7 migration of 4,110 lines of `gateway.ts` is dragged in. |
| **MCP spec 2026-07-28** | Current revision is a stateless rewrite: no `initialize` handshake, no `Mcp-Session-Id`, no GET SSE, mandatory `server/discover`. Anthropic support "rolling out soon." | gbrain is accidentally well-positioned — already session-less, already 405s `GET /mcp`. Do not chase it until Phase 5 captures what Claude Code actually negotiates. |
| **`azure-openai` recipe hardcodes its price** | `cost_per_1m_tokens_usd: 0.13` inline rather than deriving from `embedding-pricing.ts` — the cross-table drift anti-pattern CLAUDE.md's canonical-pricing invariant exists to prevent, unguarded for embeddings. | Fix alongside code change #1; add a drift-guard assertion. |

---

## 15. Runbook — shutdown, startup, verify

All commands assume:

```bash
export RG=rg-gbrain
export PG=pg-gbrain
export MCP=ca-gbrain-mcp
export WORKER=ca-gbrain-worker
export BRAIN_URL=https://brain.example.com
```

### 15.1 Shutdown — order matters

**Stop the worker first, the database last.** Stopping Postgres while the worker is mid-write leaves jobs to fail and retry on the next start rather than checkpointing cleanly. The lease machinery recovers either way, but a clean stop avoids a burst of retries every morning.

```bash
# 1 — worker: scale to zero. The supervisor gets SIGTERM and waits up to 40s
#     for the child worker to finish its current job before exiting.
az containerapp update -g "$RG" -n "$WORKER" --min-replicas 0

# 2 — confirm the worker replica is actually gone before touching the database
until [ -z "$(az containerapp replica list -g "$RG" -n "$WORKER" --query '[].name' -o tsv)" ]; do
  echo "waiting for worker replicas to drain..."; sleep 10
done

# 3 — database last
az postgres flexible-server stop -g "$RG" -n "$PG"
```

The MCP app needs no explicit stop — it sits at `min=0` and bills only on request (§10.3). See §15.4 for a hard stop.

### 15.2 Startup — order matters

**Database first, and wait for it to report `Ready`.** Postgres start takes roughly 2–5 minutes. If the containers come up against a database that is not yet accepting connections, `/health` fails its readiness probe and Container Apps will not route traffic.

```bash
# 1 — database
az postgres flexible-server start -g "$RG" -n "$PG"

# 2 — block until it is genuinely ready (not merely "Starting")
until [ "$(az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv)" = "Ready" ]; do
  echo "waiting for postgres..."; sleep 15
done

# 3 — worker back to one replica; the dream cycle drains from here
az containerapp update -g "$RG" -n "$WORKER" --min-replicas 1

# 4 — warm the MCP app so the first Claude Code call is not a cold start
curl -fsS "$BRAIN_URL/health" >/dev/null && echo "mcp warm"
```

### 15.3 Verify

Run top to bottom. Each check is independent, so a failure tells you which layer is wrong.

```bash
# --- Azure layer ---
az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv        # expect: Ready
az containerapp replica list -g "$RG" -n "$WORKER" -o table                     # expect: 1 running replica
az containerapp show -g "$RG" -n "$MCP" --query properties.runningStatus -o tsv # expect: Running

# --- HTTP layer ---
curl -fsS "$BRAIN_URL/health"                                                   # expect: 200

# unauthenticated MCP must be refused, and the refusal must carry discovery metadata
curl -si -X POST "$BRAIN_URL/mcp" | head -1                                     # expect: HTTP/... 401
curl -si -X POST "$BRAIN_URL/mcp" | grep -i www-authenticate                    # expect: resource_metadata="..."
curl -fsS "$BRAIN_URL/.well-known/oauth-protected-resource" | jq .              # expect: valid PRM JSON

# --- gbrain layer ---
az containerapp exec -g "$RG" -n "$MCP"    --command "gbrain doctor --json"
az containerapp exec -g "$RG" -n "$WORKER" --command "gbrain jobs supervisor status --json"
az containerapp exec -g "$RG" -n "$MCP"    --command "gbrain jobs stats"
az containerapp exec -g "$RG" -n "$MCP"    --command "gbrain stats"

# --- model plane (proves both providers answer, end to end) ---
az containerapp exec -g "$RG" -n "$MCP" --command "gbrain query 'smoke test' --limit 1"

# --- client layer ---
claude mcp list                                                                 # expect: gbrain ✓ connected
```

**Reading the output:**

| Check | Healthy | If it fails |
|---|---|---|
| `flexible-server show --query state` | `Ready` | Still `Starting` — wait. `Stopped` — the start never ran. |
| `jobs supervisor status --json` | exits **0** | exits **1** = supervisor not running. Check the worker replica count and its logs. |
| `gbrain doctor` | all green **except `rls`** | The `rls` failure is **expected and permanent** on Azure (§9.3). Any *other* failure is real. |
| `curl /mcp` unauthenticated | **401** with `WWW-Authenticate` | 200 means auth is not enforced — stop and investigate. 502/504 means the app cannot reach Postgres. |
| `gbrain query` | returns results | 401/403 from the model plane = bad Foundry key or wrong Entra scope. 404 = deployment-name mismatch, almost always the Haiku alias trap (§4.2). |

**Note on `gbrain doctor`:** annotate the expected `rls` failure in your own runbook notes so a future you does not chase it. It is a consequence of Azure's admin role lacking `BYPASSRLS`, and there are zero RLS policies in the schema to enforce anyway.

### 15.4 Hard stop (optional)

If you want the MCP app fully off rather than merely idle at `min=0`:

```bash
# find the active revision, then deactivate it
REV=$(az containerapp revision list -g "$RG" -n "$MCP" --query "[?properties.active].name | [0]" -o tsv)
az containerapp revision deactivate -g "$RG" -n "$MCP" --revision "$REV"

# to bring it back
az containerapp revision activate -g "$RG" -n "$MCP" --revision "$REV"
```

Only worth doing if you see unexplained MCP charges. At `min=0` with no traffic the app should already cost nothing.

### 15.5 The scheduler — GitHub Actions, no new Azure resource

You already have federated OIDC wired for `deploy.yml`. Reuse it. This costs nothing and adds no Azure service to operate.

`.github/workflows/schedule.yml`:

```yaml
name: gbrain schedule

on:
  schedule:
    - cron: '0 5 * * 1-5'    # 05:00 UTC weekdays — start
    - cron: '0 18 * * 1-5'   # 18:00 UTC weekdays — stop
  workflow_dispatch:
    inputs:
      action:
        description: start | stop | verify
        required: true
        type: choice
        options: [start, stop, verify]

permissions:
  id-token: write
  contents: read

env:
  RG: rg-gbrain
  PG: pg-gbrain
  MCP: ca-gbrain-mcp
  WORKER: ca-gbrain-worker
  BRAIN_URL: https://brain.example.com

jobs:
  schedule:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Resolve action
        id: act
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "action=${{ inputs.action }}" >> "$GITHUB_OUTPUT"
          elif [ "${{ github.event.schedule }}" = "0 5 * * 1-5" ]; then
            echo "action=start" >> "$GITHUB_OUTPUT"
          else
            echo "action=stop" >> "$GITHUB_OUTPUT"
          fi

      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Start
        if: steps.act.outputs.action == 'start'
        run: bash scripts/azure/start.sh

      - name: Stop
        if: steps.act.outputs.action == 'stop'
        run: bash scripts/azure/stop.sh

      - name: Verify
        if: always() && steps.act.outputs.action != 'stop'
        run: bash scripts/azure/verify.sh
```

Put the three command blocks from §15.1–15.3 into `scripts/azure/{start,stop,verify}.sh` so the same scripts run by hand and on the schedule. Pin action SHAs per the repo's existing convention (`docs/RELEASING.md`).

**Scheduler caveats:**

- **GitHub cron is UTC and best-effort.** It can drift 5–15 minutes or more under platform load. Schedule the start earlier than you actually need the brain.
- **DST shifts your local window by an hour** twice a year, because the cron is fixed in UTC. Either accept the drift or keep two cron pairs and swap them at the transitions.
- **The stop job must be idempotent.** If a start was skipped or a stop already ran, the scripts should exit 0 rather than fail the workflow — otherwise you get alert noise from a no-op.
- **A failed start is silent unless you look.** Add a notification step on failure, or you will discover it when Claude Code cannot connect at 09:00.

---

## Addendum A — Scaling to a small team (2–20 users)

What changes from the single-user plan. Nothing here is required on day one, and none of it is a rewrite.

### A.1 Resource changes

| Change | From | To | Why |
|---|---|---|---|
| Postgres | B2s Burstable, no HA | **D2ds_v5 General Purpose**, zone-redundant HA optional | Burstable credits exhaust under concurrent HNSW queries. ~$130/mo compute. |
| `ca-gbrain-mcp` | 0.5 vCPU / 1 GiB, min=0 max=2 | 1 vCPU / 2 GiB, **min=1** max=3 | Scale-to-zero cold starts become visible with several users. **Max 3 is a hard ceiling** — see A.3. |
| `ca-gbrain-worker` | 0.5 / 1 | 2 vCPU / 4 GiB | Cycle phases and enrichment scale with corpus and user count. |
| **New:** `ca-gbrain-admin` | — | 0.5 / 1, **internal ingress only**, `GBRAIN_DISABLE_ADMIN` unset | Restores the admin web plane, reachable only via VPN/Bastion. Public app keeps admin disabled. |
| Log Analytics | 30-day | 90-day | Audit retention for multiple actors. |

**Team infra ≈ $400–500/mo.** Model spend will dominate at roughly 3:1.

### A.2 Identity and source scoping

This is the real work, and gbrain already has the seam.

- Register **one OAuth client per person**, each with `--source` / `--federated-read` set to that person's allowed slice and its own `--budget-usd-per-day`. Individually revocable.
- `ctx.auth.allowedSources` is the enforcement point — every read-side op routes through `sourceScopeOpts(ctx)`. Precedence is federated array > scalar > nothing. **Never hand-roll source filtering**; a missed thread is a cross-source leak.
- Keep `sources_list` / `sources_status` out of every published tool allowlist (§9.1 item 7) — they are `scope:'read'` with no grant filtering and disclose every source's paths.
- If Entra ID SSO is wanted rather than per-person client credentials, that is **new work** — map Entra groups to source scopes. gbrain has no built-in Entra integration.

### A.3 The 20-user ceiling is structural, not a config knob

`ca-gbrain-mcp` cannot scale past a small replica count because admin sessions, magic-link nonces, and **every `express-rate-limit` bucket** are in-process `Map`s (`src/commands/serve-http.ts:696-710`, `:1130-1143`, `:777`). Multiple replicas mean per-replica rate limits and session affinity problems.

Passing roughly 20 concurrent users requires an external session/rate-limit store that **gbrain has no seam for today**. If the growth curve points past 20, budget that work deliberately rather than discovering it under load.

### A.4 Foundry quota becomes the binding constraint

40 RPM across 20 users is roughly 2 requests per user per minute. **Request the quota increase before onboarding the second user**, not after. Enterprise/MCA-E enrollment gets 2,000 RPM / 2M ITPM.

### A.5 Cost governance

Set `search.mode` per the team's tolerance — it is a 25x lever. `conservative` at 20 users is roughly the model spend of `tokenmax` at one user. Per-client `--budget-usd-per-day` plus `spend.posture gated` should be in place before the second person connects, and `mcp_spend_log` must be confirmed to exist (it fails open to zero when missing).

---

## Appendix — Key source references

| Claim | Location |
|---|---|
| `ANTHROPIC_BASE_URL` normalization | `src/core/ai/gateway.ts:444-453` |
| baseURL threaded into `createAnthropic` | `src/core/ai/gateway.ts:2475` (expansion), `:3037` (chat) |
| `generateObject` on native branch, no per-call fallback | `src/core/ai/gateway.ts:2563-2572` |
| Expansion fails open to `[query]` | `src/core/ai/gateway.ts:2603-2610` |
| `cache_control` keyed on `recipe.id === 'anthropic'` | `src/core/ai/gateway.ts:3338-3415` |
| Azure OpenAI recipe (embedding-only touchpoint) | `src/core/ai/recipes/azure-openai.ts:77`, `:95-109` |
| Entra path shells out to `az` | `src/core/ai/recipes/azure-openai.ts:12-56` |
| Recipe registry | `src/core/ai/recipes/index.ts:33-60` |
| `Implementation` union (closed, 5 members) | `src/core/ai/types.ts:21-26` |
| `resolveOpenAICompatConfig` takes no `modelId` | `src/core/ai/types.ts:367-370` |
| Haiku alias → dated id | `src/core/ai/recipes/anthropic.ts:48` |
| `submit_job` — `scope:'admin'`, no `localOnly` | `src/core/operations.ts:3030-3057` |
| Protected job names | `src/core/minions/protected-names.ts` |
| MCP transport construction | `src/commands/serve-http.ts:2076` |
| `GET /mcp` returns 405 | `src/commands/serve-http.ts:1799-1802` |
| Admin routes mounted unconditionally | `src/commands/serve-http.ts:1014-1078` |
| `/health` readiness | `src/commands/serve-http.ts:281-315` |
| In-process session / rate-limit Maps | `src/commands/serve-http.ts:696-710`, `:777`, `:1130-1143` |
| Supabase-pooler gate on dual pools | `src/core/connection-manager.ts:108-120` |
| Prepared-statement disable keyed on port 6543 | `src/core/db.ts:71` |
| Startup parameters | `src/core/db.ts:238-254` |
| HNSW dim cap (silent no-index above 2000) | `src/core/vector-index.ts:19` |
| `text-embedding-3-*` openai-compat branch | `src/core/ai/dims.ts:281-299` |
| Budget hard-fail on missing pricing | `src/core/minions/budget-tracker.ts:177-221`, `:297-300` |
| Spend log fails open to 0 | `src/core/spend-log.ts:54-58` |
| RLS gated on `BYPASSRLS` | `src/schema.sql:1393-1442` |
| Migration v35 RLS backfill abort | `src/core/migrate.ts:1741-1795` |
| `initSchema` advisory lock | `src/core/postgres-engine.ts:430` |
| Auth client registration flags | `src/commands/auth.ts:384-448` |
| Legacy tokens grandfathered to admin | `src/core/oauth-provider.ts:706-736` |
| `GBRAIN_HOME` three-way inconsistency | `src/core/config.ts:1204`, `src/core/brain-repo-durability.ts:96`, `src/core/minions/supervisor.ts:132-145` |

**External:**
- Claude in Foundry — `https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models`
- Foundry Claude API shape — `https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude`
- Anthropic on Foundry — `https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry`
- Claude pricing / CCU — `https://platform.claude.com/docs/en/about-claude/pricing`
- Claude Code MCP — `https://code.claude.com/docs/en/mcp`
- Claude Code managed MCP — `https://code.claude.com/docs/en/managed-mcp`
- Copilot CLI MCP — `https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers`
- Copilot CLI BYOK — `https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models`
- MCP spec — `https://modelcontextprotocol.io/specification/versioning`
- Azure prices verified via the Retail Prices API on 2026-07-31 (Container Apps, PostgreSQL, Key Vault, Front Door). **Azure OpenAI / GPT-5.x per-token prices were NOT verifiable from an authoritative source** — see P0-8.
