# Running gbrain on one Mac, with Azure for the models

## Why this plan exists

I want to run all of gbrain on a single M5 MacBook Pro (48GB RAM, 1TB disk).
The only things that should leave the machine are the model calls: chat and
embeddings, both hosted on Azure.

Short answer: this works. gbrain doesn't need any cloud service to run.

What I checked, and what I found:

- Storage is a local database. `src/core/engine-factory.ts` only knows two
  engines, `pglite` and `postgres`. Both run on your machine.
- The job queue is just tables in that same database
  (`src/core/minions/queue.ts`). No Redis, no external broker.
- Scheduled work uses launchd on macOS (`src/commands/autopilot.ts:1257`).
- The MCP server is local. `src/mcp/server.ts` is stdio, and
  `src/commands/serve-http.ts` binds to `127.0.0.1` unless you tell it not to.
- There is no telemetry, analytics, or error reporting anywhere in the
  dependency tree. Nothing reports back to anyone.
- Supabase is one option among several, not a requirement.
  `src/core/storage.ts:18` supports `'s3' | 'supabase' | 'local'`, and
  `src/core/connection-manager.ts:504` falls back to a plain single-pool mode
  when the database URL isn't a Supabase one.

The model layer is already set up for swapping providers. `src/core/ai/gateway.ts`
wraps the Vercel AI SDK and has four places where a provider can override
behaviour:

- `resolveNativeBaseUrl()` at `gateway.ts:444` — reads `ANTHROPIC_BASE_URL` /
  `OPENAI_BASE_URL`
- `applyOpenAICompatConfig()` at `gateway.ts:409` — per-provider base URL
- `Recipe.resolveAuth()` at `types.ts:326` — custom auth header
- `Recipe.resolveOpenAICompatConfig()` at `types.ts:367` — build the URL from
  env vars, plus a custom `fetch`

There's already an Azure OpenAI provider file:
`src/core/ai/recipes/azure-openai.ts` (180 lines, including keyless Entra login).

Two things are missing, and both are small:

1. That Azure file only handles embeddings (`azure-openai.ts:95-109`). It has no
   chat or expansion entry. It also puts one deployment name directly in the
   URL, so a single process can't use an embedding deployment and a chat
   deployment at the same time.
2. `src/core/transcription.ts:115-117` has `https://api.openai.com/v1` written
   directly in the code and skips the gateway entirely. This only matters if you
   ingest audio.

Decisions already made:

- Run GPT chat models on Azure too, not just embeddings.
- Use a local Postgres with pgvector in Docker, not PGLite. PGLite only allows
  one connection at a time (`src/core/pglite-lock.ts`), so you can't run
  `gbrain serve`, the jobs worker, and the CLI together.
- Use API keys for now. Entra/keyless login is a later job.

---

## The work

### Step 0 — Get the machine ready

`bun` isn't installed right now. `package.json:147` needs version 1.3.10 or
newer. Docker 27.4.0 and Node 24 are already here, and there's 235Gi free.

```bash
curl -fsSL https://bun.sh/install | bash    # or: brew install oven-sh/bun/bun
bun --version                                # needs to be >= 1.3.10
bun install
```

The background job runner starts a compiled binary, not TypeScript
(`src/core/minions/supervisor.ts:79`), so you also need:

```bash
bun run build          # bun build --compile --outfile bin/gbrain src/cli.ts
```

The build targets are `bun-darwin-arm64` and `bun-linux-x64`
(`package.json:34`), so an M5 Mac is covered.

### Step 1 — Local Postgres with pgvector

Write a new compose file for this. Don't reuse `docker-compose.test.yml` or
`docker-compose.ci.yml` — they use ports 5434 to 5437, and the test suite wipes
those databases with `TRUNCATE CASCADE`.

New file, `docker-compose.local.yml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: gbrain
      POSTGRES_PASSWORD: gbrain
      POSTGRES_DB: gbrain
    ports: ["5432:5432"]
    volumes: ["gbrain-local-pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gbrain -d gbrain"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  gbrain-local-pgdata:
```

Why pg17: `src/core/migrate.ts:446` refuses to run below Postgres 15, and PGLite
uses Postgres 17.5, so pg17 keeps the two engines writing the same SQL. That
matters for `test/e2e/engine-parity.test.ts`. The pg17 image also ships pgvector
0.8, which means the `halfvec` column type works
(`src/core/postgres-engine.ts:4377`, `src/core/migrate.ts:2324`) instead of
quietly dropping back to `vector`.

You don't need `GBRAIN_DIRECT_DATABASE_URL`. That's only used for Supabase
connection poolers.

One side benefit: with a real Postgres, the end-to-end tests that only run when
`DATABASE_URL` is set will actually run. Those are the only tests that catch the
JSONB double-encoding bug described in CLAUDE.md — PGLite can't reproduce it.

### Step 2 — Claude through Microsoft Foundry (no code changes)

Foundry serves the normal Anthropic Messages API at
`https://{resource}.services.ai.azure.com/anthropic/v1/messages`, and it accepts
either an `api-key` or an `x-api-key` header. The AI SDK's
`createAnthropic({ apiKey })` sends `x-api-key`, so this just works:

```bash
export ANTHROPIC_BASE_URL="https://<resource>.services.ai.azure.com/anthropic"
export ANTHROPIC_API_KEY="<foundry project key>"
```

`resolveNativeBaseUrl('anthropic', cfg)` at `gateway.ts:444-453` adds the missing
`/v1` and passes the URL to both places that build an Anthropic client:
`gateway.ts:2475` (expansion) and `gateway.ts:3037` (chat). Because this stays on
the normal Anthropic code path, prompt caching still works
(`gateway.ts:3002` checks `supports_prompt_cache`).

Your Azure deployment name becomes the model name. `claude-sonnet-5`,
`claude-opus-5` and `claude-haiku-4-5` are Foundry's defaults and are already
listed in `src/core/ai/recipes/anthropic.ts:25-38`. If you name a deployment
something else, `gateway.ts:497-511` picks up any model name found in your config
and registers it, so it still works.

**Pick the "Hosted on Anthropic" version of the model, not "Hosted on Azure."**
Both are billed through Azure. The Azure-hosted one returns `400 Bad Request` for
structured outputs, server-side tools, the MCP connector, Agent Skills, and the
Files API. gbrain's `expand()` uses `generateObject`, which on Anthropic turns
into ordinary tool calls rather than the structured-outputs feature — so it will
probably work either way. It's in the checks below, but picking
"Hosted on Anthropic" avoids the question.

One older piece of code builds an Anthropic client directly:
`src/core/minions/handlers/subagent.ts:193`. The Anthropic SDK reads
`ANTHROPIC_BASE_URL` from the environment on its own, so it will follow along,
but it's cleaner to switch it to the gateway:

```bash
gbrain config set agent.use_gateway_loop true    # see subagent.ts:203-212
```

### Step 3 — New provider file for Azure OpenAI chat and embeddings

Leave `azure-openai.ts` alone — it has its own tests, its own docs row, and
people may be using it. Add a second file next to it that uses Azure's
OpenAI-compatible `/openai/v1/` route. On that route the deployment name goes in
the request body as `model` instead of in the URL, which removes the
one-deployment-per-process problem and lets one file cover embeddings, chat and
expansion.

New file: `src/core/ai/recipes/azure-openai-v1.ts`

Copy the structure of the existing Azure file — same interface, same two
override hooks, same error type:

```ts
export const azureOpenAIV1: Recipe = {
  id: 'azure-openai-v1',
  name: 'Azure OpenAI (v1 route)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  auth_env: {
    required: ['AZURE_OPENAI_ENDPOINT'],
    optional: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_USE_ENTRA', 'AZURE_OPENAI_API_VERSION'],
    setup_url: 'https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle',
  },
  touchpoints: {
    embedding: { models: ['text-embedding-3-large', 'text-embedding-3-small'],
                 default_dims: 3072, dims_options: [256, 512, 768, 1024, 1536, 3072],
                 max_batch_tokens: 8192, /* … */ },
    expansion: { models: [/* your gpt deployments */] },
    chat:      { models: [/* … */], supports_tools: true,
                 supports_subagent_loop: true, supports_prompt_cache: false, /* … */ },
  },
  resolveAuth(env) { /* { headerName: 'api-key', token } — copy azure-openai.ts:110-123 */ },
  resolveOpenAICompatConfig(env) {
    // baseURL = `${endpoint}/openai/v1`; the SDK adds /chat/completions and /embeddings.
    // Only add ?api-version= when AZURE_OPENAI_API_VERSION is set — the v1 route
    // doesn't need it. Copy the fetch wrapper from azure-openai.ts:147-175.
  },
};
```

Then register it in `src/core/ai/recipes/index.ts` as a normal top-level import
plus an entry in the `ALL` array. That file avoids dynamic imports on purpose so
`bun --compile` can bundle it.

Things that already exist and should not be rewritten:

- `applyResolveAuth` (`gateway.ts:343-397`) already sends a custom header through
  `headers` instead of the SDK's `apiKey` field, so you don't end up with two
  auth headers.
- `applyOpenAICompatConfig` (`gateway.ts:409-425`) already prefers
  `resolveOpenAICompatConfig` over the plain base-URL map.
- `src/core/ai/dims.ts:280-299` already handles `text-embedding-3*` on the
  OpenAI-compatible adapter. It matches on the model name, so name your Azure
  deployments after the model IDs (which is Azure's default anyway).
- The three places that build an OpenAI-compatible client (`gateway.ts:1534`,
  `:2488`, `:3050`) are already identical. **`gateway.ts` does not need to
  change.**

Config already carries the Azure settings: `azure_openai_endpoint`,
`azure_openai_deployment` and `azure_openai_use_entra` at
`src/core/config.ts:69-71`, passed into the gateway at
`src/core/ai/build-gateway-config.ts:51-53`. Add `azure_openai_api_version` there
only if you want to set it outside the environment.

**One existing test has to change.**
`test/ai/recipes-existing-regression.test.ts:191` says:

```ts
expect(overrides.map(r => r.id).sort()).toEqual(['azure-openai']);
```

That's a deliberate speed bump: it fails whenever a new provider overrides
`resolveAuth`, so someone has to look at it. Change it to
`['azure-openai', 'azure-openai-v1']` and add a line to the comment saying the
new file uses the same `api-key` header approach.

Also add `test/ai/recipe-azure-openai-v1.test.ts`, copying
`test/ai/recipe-azure-openai.test.ts`. Cover: the URL it builds, that it sends
`api-key` and not `Authorization`, that api-version is added only when set, and
that all three touchpoints get the same auth.

### Step 4 — Put it together

```bash
export DATABASE_URL="postgresql://gbrain:gbrain@localhost:5432/gbrain"
export AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com"
export AZURE_OPENAI_API_KEY="<key>"
export ANTHROPIC_BASE_URL="https://<resource>.services.ai.azure.com/anthropic"
export ANTHROPIC_API_KEY="<foundry key>"
export GBRAIN_SELF_UPGRADE_MODE=off     # stops the GitHub version check, self-upgrade.ts:477

gbrain init --url "$DATABASE_URL" \
  --embedding-model azure-openai-v1:text-embedding-3-large \
  --embedding-dimensions 3072

gbrain config set models.default anthropic:claude-sonnet-5
gbrain config set models.tier.subagent anthropic:claude-haiku-4-5
gbrain config set agent.use_gateway_loop true
gbrain config set storage.backend local     # src/core/storage.ts:45
```

Two defaults will call non-Azure services if you leave them alone:

- `src/core/ai/defaults.ts:20` sets the default embedding model to
  `zeroentropyai:zembed-1` at 1280 dimensions, which needs
  `ZEROENTROPY_API_KEY`. The `--embedding-model` flag above replaces it.
- The default reranker (`gateway.ts:118-124`, `zeroentropyai:zerank-2`) is off
  unless you turn it on. Leave it off, or run the local `llama-server-reranker`.

Separately, `src/cli.ts:148-210` runs `maybeEmitUpdateMarker()` on every command,
which can start a background `gbrain check-update` that fetches from
`raw.githubusercontent.com`. `GBRAIN_SELF_UPGRADE_MODE=off` turns it off.
`GBRAIN_SKIP_STARTUP_HOOKS=1` is a heavier-handed option. Both fail quietly when
offline.

### What this plan doesn't fix

`src/core/transcription.ts:115-127` has `https://api.openai.com/v1` hard-coded,
calls `fetch` directly, and ignores any base-URL setting. If you want audio
ingestion, that file needs the same base-URL hook the gateway already has.
Otherwise it never runs. I'm flagging it rather than fixing it, since audio isn't
part of what you asked for.

---

## Files to change

| File | What happens |
|---|---|
| `src/core/ai/recipes/azure-openai-v1.ts` | new file — the provider |
| `src/core/ai/recipes/index.ts` | import it, add it to `ALL` |
| `test/ai/recipe-azure-openai-v1.test.ts` | new file — copy of `recipe-azure-openai.test.ts` |
| `test/ai/recipes-existing-regression.test.ts:191` | add the new id to the allowed list |
| `docker-compose.local.yml` | new file — Postgres on port 5432 |
| `docs/integrations/embedding-providers.md` | add a table row (`:31`) and a setup section (`:118`) |
| `docs/architecture/KEY_FILES.md` | update the `src/core/ai/recipes/` entry. Describe how it works now — don't add `**vX.Y.Z:**` history lines, `scripts/check-key-files-current-state.sh` rejects them |
| `src/core/config.ts` | optional — add `azure_openai_api_version` if you want it in config |

Not changing: `src/core/ai/gateway.ts` (everything needed is already there),
`src/core/ai/recipes/azure-openai.ts` (leave it working), `CLAUDE.md`.
If CLAUDE.md does end up being edited, run `bun run build:llms` in the same
commit or `test/build-llms.test.ts` will fail.

---

## How to check it works

Run these in order. Write output to a file first, then read the file — don't pipe
into `tail`, because then `$?` is tail's exit code and you lose the failures.
This is a rule in CLAUDE.md.

**1. Types and unit tests**

```bash
bun run typecheck        > /tmp/tc.txt 2>&1;   echo "EXIT=$?"; tail -30 /tmp/tc.txt
bun test test/ai/        > /tmp/ai.txt 2>&1;   echo "EXIT=$?"; tail -30 /tmp/ai.txt
bun run verify           > /tmp/ver.txt 2>&1;  echo "EXIT=$?"; tail -40 /tmp/ver.txt
```

`verify` runs the provider contract tests and `check:gateway-routed`
(`scripts/check-gateway-routed-no-direct-anthropic.sh`), which is what catches a
new direct-SDK call slipping in.

**2. Check the providers are wired before touching the database**

```bash
gbrain providers list        # azure-openai-v1 should show as ready
```

**3. Start the database and set up the brain**

```bash
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml exec postgres pg_isready -U gbrain
gbrain init --url "$DATABASE_URL" --embedding-model azure-openai-v1:text-embedding-3-large --embedding-dimensions 3072
gbrain doctor
```

`doctor` checks the database, the embedding dimensions
(`src/core/embedding-dim-check.ts`) and the gateway config.

**4. Test each Azure connection separately**

Do these one at a time. If you only run a search and it fails, you won't know
which provider broke.

```bash
# embeddings -> Azure OpenAI
gbrain import <a few .md files>
gbrain embed --stale
gbrain query "something in those files"

# chat and expansion -> Claude on Foundry
gbrain think "summarize what you know"
```

Watch out for a quiet fallback here. `src/core/search/hybrid.ts:1419-1422`
catches embedding errors and carries on with keyword search only. That's
intentional, but it means a broken embedding setup looks like a working search
with worse results. If the results look keyword-shaped, check `gbrain search
stats` and the embedding column rather than assuming it's fine.

**5. The two Azure things I'm not certain about**

- Does `generateObject` work against your Foundry deployment? Set `search.mode`
  to `tokenmax` so the LLM query-expansion step runs, then run a query. A
  `400 Bad Request` means you deployed the "Hosted on Azure" version — redeploy
  as "Hosted on Anthropic".
- Does the v1 route want an `api-version`? If the first embedding call returns
  404 or 400, set `AZURE_OPENAI_API_VERSION=preview` and try again. The fetch
  wrapper adds it to the URL.

**6. Run three processes at once**

This is the whole reason for choosing Postgres over PGLite.

```bash
bun run build
gbrain serve &                 # MCP server
gbrain jobs work &             # background jobs, needs bin/gbrain
gbrain query "..."             # third process — should not block or corrupt anything
```

**7. Full end-to-end suite**

```bash
bun run test:e2e  > /tmp/e2e.txt 2>&1;  echo "EXIT=$?"; grep -E '(fail\)|✗|error:)' /tmp/e2e.txt | head -30
```

The test suite uses its own database on port 5434 (`docker-compose.test.yml`),
separate from your real brain on 5432, so your data is safe from its
`TRUNCATE CASCADE`.

---

## Left for later

- **Entra / keyless login for Claude.** It already works for Azure OpenAI
  embeddings (`azure-openai.ts:15-40`, `AZURE_OPENAI_USE_ENTRA=1`). It doesn't
  work for Anthropic, because `gateway.ts:2475` and `:3037` only pass
  `{ apiKey, baseURL }` — there's no way to add headers or a custom `fetch`, so
  Foundry's `Authorization: Bearer <token>` can't get through. Fixing it means
  extending the two override hooks to the native providers (`types.ts` plus
  those two call sites).
- A base-URL setting for `src/core/transcription.ts`.
- `openai` in `package.json` is unused — nothing in `src/` or `test/` imports it.
  It can be removed.
