# Connect your agent to an existing hosted GBrain

Use this guide when your memory already lives on another machine. If you want to run GBrain inside your current agent instead, start with [Grok Bot](grok-bot.md), [Muse](muse.md), or the [coding-agent walkthrough](../tutorials/connect-coding-agent.md).

You do two things in different places: the brain owner grants access **on the host**, then you install a private handoff **inside the agent's environment**. Installing configuration on the host does not configure your laptop or Bot.

## One setup prompt

Paste this into the agent that should use the hosted brain:

```text
Connect this existing agent to my hosted GBrain. Follow:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/guides/hosted-harness-access.md
Keep my identity and unrelated configuration. Use memory-writer unless I explicitly
request another capability. Have the brain owner provision the private handoff on
the host; install it here. Keep secrets out of chat, command arguments, and Git.
Use the actual harness adapter, verify a unique memory round trip, and report
server checks separately from observed recall in a new harness conversation.
Do not claim that generated instructions or a job ID prove a working integration.
```

## 1. Grant access on the brain host

The owner needs a current GBrain runtime and an initialized brain. Stop older servers and workers while applying the grant migration; do not run mixed authorization implementations. Use your normal upgrade and maintenance procedure before restarting them. The HTTPS endpoint comes from your [server deployment](../mcp/DEPLOY.md).

For ordinary memory, choose `memory-writer`:

```bash
gbrain mcp grant agent-example --harness codex --profile memory-writer \
  --source default --url https://brain.example.com/mcp \
  --credentials-out /absolute/private/agent-example.json --json
```

Replace `codex` with the actual adapter identifier. For a running PGLite server, add `--admin-token-file /absolute/private/admin-token`; this uses the server's authenticated admin API and existing database connection. An ordinary OAuth token or the endpoint URL cannot provision access. Do not open the live PGLite database from a second process.

Use `--dry-run` first to inspect a proposed grant without creating a client. Default output is redacted. The credential handoff is written with private permissions before any optional client installation or verification. Transfer it through a private file channel, then retain only the copies you need. Uploading credentials or backups is never automatic.

| Profile | Access | Native MCP surface |
| --- | --- | --- |
| `memory-reader` | Read selected memory | Starter |
| `memory-writer` | Read and write selected memory | Starter |
| `coding-agent` | Isolated project writes and explicit project reads | Starter |
| `operator` | Read, write, and administration | Full |
| `delegating-agent` | Memory plus explicitly bound delegation | Starter |
| `full` | All eligible remote capabilities at grant time, including bound delegation | Full |

A **profile grants authority**. A **surface selects visible tools**. Full surface does not bypass a grant, and `admin` does not imply delegation. Thin CLI adapters use the full surface while retaining their source, operation, and write restrictions. Direct local CLI access is trusted access to the local computer; OAuth profiles do not confine a local shell.

New grants snapshot operation names and source access. A later server upgrade does not silently give a snapshot-bound client new operations. Explicitly regrant to include them. Archived sources are excluded. Legacy clients with a `NULL` operation snapshot retain their prior operation behavior.

Snapshot-bound clients write through approved MCP operations such as `remember`, `capture`, or `put_page`. They cannot use the legacy `POST /ingest` webhook, whose queued writes do not yet enforce operation snapshots. Existing webhook clients with a `NULL` snapshot keep their legacy behavior.

## 2. Install inside the intended harness

Install GBrain there if needed, using the documented GitHub/Bun distribution. Then:

```bash
gbrain connect https://brain.example.com/mcp --harness codex \
  --credentials-file /absolute/private/agent-example.json --install
```

For Grok Bot, Muse, or another supported thin CLI adapter, also supply `--root /absolute/verified/persistent-root`. Grok Bot's recommended root is `/workspace/gbrain`. Discover and verify Muse's durable location before choosing a root. Use the generated **absolute launcher** for every later GBrain call; it pins routing and isolates inherited configuration.

The installer preserves unrelated configuration and refuses an unowned or edited connection. Codex, Claude Code, and opencode receive private managed configuration. Generic adapters supply endpoint/authentication guidance; there is no universal configuration file. [Adapter reference](harness-adapters.md) lists supported mechanisms and reload steps.

A configured server is only one step. Follow the adapter's reload instructions and enable the GBrain standing instruction through the harness's actual controls. Thin CLI installations write that instruction to `<ROOT>/GBRAIN-INSTRUCTIONS.md`. Grok Bot/Muse native skill activation remains a separate, visible step until observed in that harness. Generated files alone do not activate a skill.

## 3. Prove a memory round trip

Run the server verifier from the harness environment:

```bash
gbrain mcp verify --client CLIENT_ID --harness codex \
  --url https://brain.example.com/mcp \
  --credentials-file /absolute/private/agent-example.json --json
```

It checks transport, authentication, effective permissions, reading, a randomized write/readback, and cleanup separately. Memory profiles use `remember` and `recall`; isolated coding grants use pages inside their fence. The capabilities resource works even on the exact seven-tool surface.

`server_status: "passed"` proves those server checks. Overall `status: "partial"` and exit code **2** mean actual harness evidence is still missing; exit **1** means a failed stage. A fluent response or an SDK probe is not proof that your Bot loaded its standing instructions.

Now ask the actual agent to remember a unique harmless fact, with provenance, and note the observed GBrain call and returned ID. Start a new conversation and ask for it without repeating the fact. Observe `recall`. Correct it, read it back, then withdraw it and check active recall again. Keep the result in your private setup receipt. The harness must identify uncertainty if it cannot load the tool or retrieve the record.

`forget` withdraws a fact from active memory. History, source material, and backup copies may remain; it is not a promise of physical erasure. Verifier cleanup uses the same withdrawal semantics. Failed cleanup stays visible with the fixture identifier.

## Delegation is a separate capability

Only grant delegation when you want this client to start work on the brain host. Supply a nonempty set of tools from the running registry:

```bash
gbrain mcp grant research-example --harness grok-bot \
  --profile delegating-agent --source default \
  --bound-tools search,get_page --delegated-namespace job \
  --url https://brain.example.com/mcp \
  --credentials-out /absolute/private/research-example.json --json
```

**New delegation has unlimited spending and concurrency 1.** Unlimited means no client spending cap; provider charges still apply, and usage remains attributed to the client. To impose a finite cap, explicitly add `--budget-usd-per-day 5`. Existing finite caps are preserved during repair and profile changes unless explicitly changed. A cap of `0` prevents paid work. Finite clients refuse paid calls whose maximum cost or pricing is unknown; unresolved liability stays reserved across midnight and reservation expiry until reconciled.

The default job namespace isolates delegated writes per job. To use another allowed fence, supply `--delegated-slug-prefixes agents/research-example/`. Direct writes and delegated writes have separate fences. The delegated source must also belong to the parent's read grant, and bound tools must fit its operation snapshot. Local-only tools and cross-brain delegation are unsupported.

Delegation verification first checks configuration with a dry run. Add `--delegate` to `mcp verify` only when you want a real worker challenge that may incur API charges. A queued job ID does not pass: the verifier requires terminal completion with the randomized result. An unavailable worker or failed cancellation remains visibly incomplete.

Queued and running work stays restricted by both its submitted policy and the current grant. A changed source invalidates the original target; it does not move the job to another source. Revocation stops newly forbidden work at the next execution boundary and cannot undo an external operation already running.

## Repair permissions without replacing credentials

Inspect `whoami` or the authenticated `gbrain://capabilities` resource. It reports the effective profile, revision, scopes, source access, direct/delegated policies, spending mode, and repair reasons. Worker readiness is reported separately from grant validity.

Preview an explicit profile update:

```bash
gbrain mcp grant agent-example --client CLIENT_ID --if-version REVISION \
  --harness codex --profile memory-reader --source default \
  --url https://brain.example.com/mcp --dry-run --json
```

Review the before/after grant, then repeat without `--dry-run`. `--if-version` rejects a stale edit. The client ID and secret remain unchanged. When updating a client, omit `--profile` to preserve its profile, scopes, operation snapshot, and bindings while changing only the fields you supply. An explicit profile selection regrants its eligible operations. For advanced repairs, use `gbrain auth rescope-client CLIENT_ID --help`; omitted restrictions are retained.

Scope removals affect existing tokens immediately. Added scopes need a newly issued access token; refresh cannot expand its original scope grant. Source, operation, fence, binding, and surface changes apply on the next authenticated request. Repairing bindings benefits an existing token that already carries `agent`. TTL changes apply only to newly issued tokens. New renewable connections use one-hour access tokens; static-token adapters use 30 days. Check the receipt for the selected expiry.

## Recover an interrupted handoff

The host retains a private delivery journal before committing a new client. If the response or destination write is lost, recover the original handoff without duplicating the client:

```bash
gbrain mcp grant agent-example --client CLIENT_ID --resume --harness codex \
  --url https://brain.example.com/mcp \
  --credentials-out /absolute/private/recovered-agent.json --json
```

Add `--admin-token-file` when recovering through the running server. Resume changes no permissions and rotates no secret. If the client ID was lost, repeating the original creation reports the existing ID instead of creating a duplicate.

In the admin dashboard, use **Recover credentials** for an existing OAuth client. New confidential clients registered there use the same private host journal. If registration loses its response, the form looks up the existing client before offering recovery. Download the recovered handoff and set its permissions to `0600` on the target computer. Recovery refuses a revoked client or a journal whose secret has since been rotated.

An expired or lost **access token** can be reissued using the existing client secret. A lost **client secret**, when neither the handoff nor host delivery journal remains, requires explicit secret rotation. These are distinct operations; revoking a client is another separate operation. Protect or remove the host's `.gbrain/credential-deliveries` files deliberately after secure delivery; they contain credentials and are excluded from default backups.

## Maintenance, removal, and troubleshooting

Keep the host runtime and schema current together. Keep native instructions enabled for each harness, check token expiry for static adapters, and periodically repeat a harmless memory round trip. The host's normal maintenance schedule serves its connected clients; installing a remote connection does not silently create another server or paid routine.

For a hosted thin CLI connection, a removed runtime is repaired by reinstalling
GBrain in the harness, then repeating `gbrain connect ... --install` with the
existing private handoff, endpoint, harness identifier, and root. The installer
updates its owned launcher while preserving the host's memory and client
identity. This connection has no local database backup or `bin/gbrain-setup`
helper; complete backups belong on the brain host. If the handoff was lost,
recover it through the host's delivery procedure first.

Before this security migration, stop old servers and workers and take a protected backup. Start only runtimes that enforce the migrated grants. If rollout fails, disable the affected entry points and restore a compatible runtime while preserving memory and the tightened grants; do not run an older authorization implementation against the migrated database. Local installations can be released independently of hosted delegation.

Remove a managed native configuration with the same private handoff and `gbrain connect ... --remove`. Disable saved skills/routines through the harness controls. Revoke the client on the host when its authority should end. Removing configuration alone does not revoke access or delete memory.

| Symptom | Next action |
| --- | --- |
| PGLite is busy | Use authenticated host administration or wait for the current owner to close. Never remove a live lock. |
| Configuration conflict | Select a fresh connection name/root or inspect the changed entry; do not overwrite unrelated settings. |
| `grant_conflict` | Fetch the new revision and preview again. |
| Delegation missing | Inspect repair reasons and explicitly bind supported tools, an active source, path policy, and positive concurrency. |
| Read works, writes fail | Check issued/current scopes, operation snapshot, source grant, and direct fence. Full surface alone adds no authority. |
| Work queues but never finishes | Check the host worker and terminal job status; queue admission is not worker verification. |
| Finite cap blocks a call | Inspect unresolved reservations and provider pricing/bounds; do not treat unknown usage as zero. |
| Server checks pass, new conversation fails | Verify native instruction activation, reload, absolute launcher, and observed GBrain calls inside that harness. |

## Evidence and release gates

As of **2026-09-09**, repository tests exercise private configuration writers, credential recovery, grant enforcement, owner consent, and server probes. Exact tests and observed results belong in the change's validation record. **Actual Grok Bot/Muse sessions have not been verified by these tests.** Native Grok Bot OAuth additionally requires confidential-client PKCE/resource checks, authenticated owner approval, and a successful real connector test. Muse personal-agent native MCP configuration remains unverified and is not an advertised installation path.

[Validation evidence and actual-harness acceptance](harness-validation.md).
