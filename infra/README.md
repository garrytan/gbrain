# gbrain on Azure — infrastructure

Bicep templates for running gbrain entirely inside Azure, including the
models it calls. Implements Phase 2 of `plans/AzureIntegration.md`; read that
plan for the reasoning behind the choices summarized here.

## Layout

```
infra/
  main.bicep                    subscription-scope: resource group + module wiring
  main.parameters.json          non-secret defaults
  modules/
    network.bicep               VNet, /27 ACA subnet, delegated PG subnet, private DNS
    identity.bicep              the one user-assigned identity everything runs as
    postgres.bicep              Flexible Server B2s, VNet-injected, azure.extensions
    keyvault.bicep              vault + secrets + Key Vault Secrets User grant
    acr.bicep                   registry + AcrPull grant
    observability.bicep         Log Analytics (the durable audit sink)
    containerapps-env.bicep     workload-profile environment
    containerapp-mcp.bicep      public MCP app, scale-to-zero
    containerapp-worker.bicep   minion supervisor, no ingress
    job-migrate.bicep           manual-trigger migration job
    foundry.bicep               AI Foundry + Azure OpenAI + deployments
```

## Deploy order

The template will not deploy the container apps on the first run. That is
deliberate: a container app cannot be created without an image, the image
cannot be built until the registry exists, and the schema must be migrated
before a serving revision starts.

```bash
# 1. Foundation: network, database, vault, registry, model plane.
az deployment sub create \
  --name gbrain-bootstrap \
  --location eastus2 \
  --template-file infra/main.bicep \
  --parameters infra/main.parameters.json \
  --parameters dbAdminPassword="$PG_PASSWORD" \
               adminBootstrapToken="$ADMIN_TOKEN"

# 2. Build and push the image, then 3. migrate, then 4. deploy the apps.
#    .github/workflows/deploy.yml does all three.
```

Re-running step 1 with `deployApps=true image=<ref>` is idempotent.

## Parameters you must supply

| Parameter | Notes |
|---|---|
| `dbAdminPassword` | Never commit it. Pass at deploy time or from a pipeline secret. |
| `adminBootstrapToken` | Must match `^[A-Za-z0-9_-]{32,}$`. gbrain validates it BEFORE it consults `GBRAIN_DISABLE_ADMIN`, so it is required even though the admin plane is off. |

## Things that will bite you

**Claude is not fully declarative.** `deployClaude` defaults to `false`. The
Claude deployment requires an Azure Marketplace purchase and agreement
acceptance with no ARM representation, so attempting it inside the template
fails the whole deployment on a fresh subscription. Deploy Claude from the
portal or CLI first and confirm it works on your subscription before turning
the flag on.

**Claude has two hosting tiers and they look identical afterwards.** Version 1
is "hosted on Anthropic infrastructure" — it runs outside Azure and merely
bills through it. Only version 2, "Hosted on Azure", keeps prompts inside the
Azure boundary. Verify the tier in the portal after creating the deployment.

**Name the Haiku deployment with the date.** On Foundry the wire `model`
field carries the deployment name, and deployment names are immutable after
creation. gbrain's `anthropic` recipe resolves `claude-haiku-4-5` to
`claude-haiku-4-5-20251001`, and the resolved id is what goes on the wire. A
mismatch 404s at the first query with an opaque error.

**1536 dimensions, never 3072.** pgvector refuses hnsw/ivfflat above 2000
dims, and gbrain's `chunkEmbeddingIndexSql` silently emits a SQL comment
instead of an index above that width. A 3072-d brain stores fine and then
sequential-scans forever with no error at any layer. The parameter is
`@allowed([1536])` for that reason.

**Port 5432, not 6432.** Azure's PgBouncer is on 6432, but gbrain keys its
prepared-statement auto-disable on 6543 and gates its dual-pool machinery on
a Supabase-shaped URL. Behind a transaction-mode pooler, `executeRawDirect` —
which minion lock heartbeats and sync checkpoints depend on — silently
collapses onto the shared read pool. Burstable does not offer PgBouncer
anyway, so the cheap SKU and the correct configuration agree.

**RLS will be reported as failing, permanently.** gbrain enables row-level
security only when the role holds `BYPASSRLS` or is superuser, and Azure's
Postgres admin role is neither. `gbrain doctor`'s `rls` check will fail
forever on this deployment. That is acceptable here because the server has no
public network path and gbrain's RLS carries zero policies anywhere — it was
only ever an anon-key defense for the Supabase topology. Any OTHER doctor
failure is real.

**Migration v35's auto-RLS backfill aborts on the same role predicate.** This
is the most likely day-one blocker. Test it against a throwaway server before
committing to the topology (plan gate P0-2).

**The worker must never run more than one replica.** Two supervisors race on
the same job leases. The lock machinery survives it, but the result is
duplicated LLM spend on every cycle phase. The parameter is capped at 1.

**Nothing here holds volatile state.** The container filesystem is ephemeral
by design (no git-backed sources means nothing on disk must survive a
restart), which is what makes stopping compute overnight safe — and also why
Log Analytics is a required resource rather than an optional one: the audit
JSONL under `GBRAIN_AUDIT_DIR` is destroyed on every restart.
