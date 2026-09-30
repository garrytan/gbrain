# Connect your agent to an existing hosted GBrain

Use this guide when your memory already lives on another machine. If you want to run GBrain inside your current agent instead, start with [Grok Bot](grok-bot.md), [Muse](muse.md), or the [coding-agent walkthrough](../tutorials/connect-coding-agent.md).

The brain owner grants access on the running server; the connecting harness
configures access in its own environment. Installing configuration on the host
does not configure your laptop or Bot. First select the connection method:

| Intended connection | Follow |
| --- | --- |
| Harness has native OAuth/PKCE settings | [Native OAuth path](#native-oauth-path) below |
| Managed bearer configuration or a thin CLI adapter | The [machine handoff path](#1-grant-access-on-the-brain-host) below |
| Open the dashboard, inspect clients, change permissions, or end access | [MCP administration](../mcp/ADMIN.md) |

An endpoint URL, ordinary OAuth token, client secret, or MCP `admin` scope does
not grant owner administration. The owner uses a separately protected bootstrap
credential. Local stdio connections do not create an HTTP admin panel.

## One setup prompt

Paste this into the agent that should use the hosted brain:

```text
Connect this existing agent to my hosted GBrain. Follow:
https://raw.githubusercontent.com/garrytan/gbrain/master/docs/guides/hosted-harness-access.md
Keep my identity and unrelated configuration. Use memory-writer unless I explicitly
request another capability. Select this harness's native OAuth/PKCE flow when
available; otherwise have the owner provision a private machine handoff and
install it here. Keep secrets out of chat, command arguments, and Git.
Use the actual harness adapter, verify a unique memory round trip, and report
server checks separately from observed recall in a new harness conversation.
Explain that a new machine grant through mcp grant follows the brain's published
skills by default; offer --skills memory-only. Preserve existing grants and publication opt-outs. Shared
skills do not authorize scripts, additional tools, spending, or automatic capture.
Do not claim that generated instructions or a job ID prove a working integration.
```

## Native OAuth path

1. Obtain the intended harness's actual redirect URI and supported client
   authentication method from its settings/current guide. Public PKCE uses
   `none` and has no client secret; confidential PKCE uses its documented
   `client_secret_post` or `client_secret_basic` method.
2. The owner follows [native registration](../mcp/ADMIN.md#native-oauth-with-pkce)
   with `gbrain mcp admin register NAME --redirect-uri URI`. Select the desired
   source and permissions explicitly; the native CLI default is read access.
   This creates authorization-code/refresh registration, not a machine token.
3. The owner runs `gbrain mcp admin setup CLIENT_ID --harness ID --flow
   authorization-code` against that server. It returns live endpoint,
   registration, and setup instructions. Confidential delivery additionally
   requires `--credentials-out PRIVATE_FILE`. An `OAuthClientSetup` export is
   not the machine handoff accepted by `gbrain connect --credentials-file`.
4. Enter the setup fields in the actual harness and start its OAuth connection.
   The native harness generates and retains the PKCE verifier. When the browser
   asks for owner approval, the authorized administrator issues a login link
   with `--oauth-request REQUEST_ID` from that browser URL. The owner can use
   the link in a fresh browser and return to the same consent request.
5. Approve the displayed client, callback, scopes, and source access. Verify an
   authenticated call inside the actual harness, then perform the harmless
   cross-conversation memory check described below. Registration and downloaded
   instructions alone do not verify a native connection.

If consent expires or the server restarts, start the connection again in the
native harness. Enabling DCR is an owner choice, not a required repair: manual
registration works with DCR disabled when the client supports entered client
metadata. DCR never bypasses owner approval.

The remaining numbered steps describe **machine handoffs**. Do not install one
as a substitute when the native client requires OAuth/PKCE.

## 1. Grant access on the brain host

The owner needs a current GBrain runtime and an initialized brain. Stop older servers and workers while applying the grant migration; do not run mixed authorization implementations. Use your normal upgrade and maintenance procedure before restarting them.

**Get the HTTPS endpoint.** Use the configured endpoint if the brain is already served over HTTPS; do not republish it. When the brain runs on the owner's own computer and needs publishing, `gbrain mcp expose` publishes `gbrain serve --http` on the owner's Tailscale tailnet with HTTPS, keeps it running as a user service, and writes the admin bootstrap token to `~/.gbrain/serve/admin-token`. Tailnet-only reach (the default) serves the owner's own devices; agents that run in a vendor's cloud — Grok Bot, Muse, ChatGPT, Claude.ai, Perplexity — need `gbrain mcp expose --funnel`. The printed MCP URL looks like `https://your-machine.your-tailnet.ts.net/mcp`. Steps, flags and troubleshooting: [Use your brain from anywhere over MCP](remote-mcp.md). Other HTTPS fronts (ngrok, a cloud host) come from your [server deployment](../mcp/DEPLOY.md); substitute the intended server's configured URL in every example below.

**Say to your agent:** *"use my brain over mcp"* — *"connect grok bot to my brain"* — the `remote-mcp` skill publishes, then grants.

For ordinary memory, choose `memory-writer`:

```bash
gbrain mcp grant agent-example --harness codex --profile memory-writer \
  --source default --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /absolute/private/agent-example.json --json
```

Replace `codex` with the actual adapter identifier. The protected owner file
provisions through the running server's authenticated admin API and existing
database connection. `~/.gbrain/serve/admin-token` is the file `gbrain mcp
expose` maintains; for another deployment, use the private file holding that
server's configured owner credential. Without the flag,
`GBRAIN_ADMIN_BOOTSTRAP_TOKEN` supplies the credential. An ordinary OAuth token
or the endpoint URL cannot provision access. A local maintenance CLI can omit
both owner credential mechanisms only when it can safely open the intended
brain. Do not open the live PGLite database from a second process.

Use `--dry-run` first to inspect a proposed grant without creating a client. Default output is redacted. The credential handoff is written with private permissions before any optional client installation or verification. Transfer it through a private file channel, then retain only the copies you need. Uploading credentials or backups is never automatic.

New grants default to **`--skills follow`** within their approved read sources.
Use **`--skills memory-only`** to opt out of enrollment; catalog reads can still
be available. Following adds the explicit `skills_member_self` scope and
catalog/membership operations, not `skill_editor` or `skill_publisher` authority.
Fresh owned-root setup approves a limited prose-only follow policy for the
packaged memory skills when publication is enabled. Existing brains still need
owner approval of their source's follow/disclosure policy; migration and grant
creation do not expand existing publication consent. Give each independent harness,
including the parent, its own principal and private handoff. Shared credentials
are one principal. See [shared brain skills](shared-brain-skills.md).

| Profile | Access | Native MCP surface |
| --- | --- | --- |
| `memory-reader` | Read selected memory | Starter |
| `memory-writer` | Read and write selected memory | Starter |
| `coding-agent` | Isolated project writes and explicit project reads | Starter |
| `operator` | Read, write, and eligible brain administration operations | Full |
| `delegating-agent` | Memory plus explicitly bound delegation | Starter |
| `full` | All eligible remote capabilities at grant time, including bound delegation | Full |

A **profile grants authority**. A **surface selects visible tools**. Full surface does not bypass a grant, and `admin` does not imply delegation, the named shared-skill scopes, or owner dashboard/client-management authority. Starter includes authorized skill discovery and membership; the exact seven-tool `verbs` surface is memory-only. Thin CLI adapters use the full surface while retaining their source, operation, and write restrictions. Direct local CLI access is trusted access to the local computer; OAuth profiles do not confine a local shell.

New grants snapshot operation names and source access. A later server upgrade does not silently give a snapshot-bound client new operations. Explicitly regrant to include them. Archived sources are excluded. Legacy clients with a `NULL` operation snapshot retain their prior operation behavior.

Snapshot-bound clients write through approved MCP operations such as `remember`, `capture`, or `put_page`. They cannot use the legacy `POST /ingest` webhook, whose queued writes do not yet enforce operation snapshots. Existing webhook clients with a `NULL` snapshot keep their legacy behavior.

## 2. Install inside the intended harness

Install GBrain there if needed, using the documented GitHub/Bun distribution. Then:

```bash
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness codex \
  --credentials-file /absolute/private/agent-example.json --install
```

For Grok Bot, Muse, or another supported thin CLI adapter, also supply `--root /absolute/verified/persistent-root`. Grok Bot's recommended root is `/workspace/gbrain`. Discover and verify Muse's durable location before choosing a root. Use the generated **absolute launcher** for every later GBrain call; it pins routing and isolates inherited configuration.

The installer preserves unrelated configuration and refuses an unowned or edited connection. Codex, Claude Code, and opencode receive private managed configuration. Generic adapters supply endpoint/authentication guidance; there is no universal configuration file. [Adapter reference](harness-adapters.md) lists supported mechanisms and reload steps.

A configured server is only one step. Follow the adapter's reload instructions and enable the GBrain standing instruction through the harness's actual controls. Thin CLI installations write that instruction to `<ROOT>/GBRAIN-INSTRUCTIONS.md`. Grok Bot/Muse native skill activation remains a separate, visible step until observed in that harness. Generated files alone do not activate a skill.

With an approved follow handoff, managed Claude Code, Codex, and opencode
connections also install an owned, namespaced shared-brain router. Successful
installation reports `restart_required` and `native: unverified`, not universal
activation. Manual clients remain pending native registration. Read the
`shared_skills` result and its `next_action`; a policy, grant, server-version,
or ownership conflict can leave memory working while skill enrollment is pending.
The router's freshness instruction is advisory, not a vendor-enforced hook.

Inspect this connection's local skill receipt without credentials or a live
host using `gbrain connect --harness codex --status --json`. Supply the actual
adapter, connection `--name`, and the recorded `--root` for thin CLI adapters.
It reports desired/installed/acknowledged views and pending cleanup, but keeps
`current_authority: unprobed` and `native_use: unverified`; reconnect and test
the native session separately.

## 3. Prove a memory round trip

Save durable facts and preferences, not local harness/configuration state. A
remote `put_page` does not extract graph edges inline: stdio has best-effort
startup/idle sweeps, but HTTP needs explicit host maintenance or authorized
`add_link` calls. Configured providers can receive text, and Markdown export is
not a full database backup. See [memory boundaries](memory-boundaries.md).

Run the server verifier from the harness environment:

```bash
gbrain mcp verify --client CLIENT_ID --harness codex \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-file /absolute/private/agent-example.json --json
```

It checks transport, authentication, effective permissions, reading, a randomized write/readback, and cleanup separately. Memory profiles use `remember` and `recall`; isolated coding grants use pages inside their fence. The capabilities resource works even on the exact seven-tool surface.

`server_status: "passed"` proves those server checks. Overall `status: "partial"` and exit code **2** mean actual harness evidence is still missing; exit **1** means a failed stage. A fluent response or an SDK probe is not proof that your Bot loaded its standing instructions.

Now ask the actual agent to remember a unique harmless fact, with provenance, and note the observed GBrain call and returned ID. Start a new conversation and ask for it without repeating the fact. Observe `recall`. Correct it, read it back, then withdraw it and check active recall again. Keep the result in your private setup receipt. The harness must identify uncertainty if it cannot load the tool or retrieve the record.

For native OAuth, make these calls through the harness's authenticated MCP
connection; the private-handoff verifier above is for machine credentials.
Inspect the advertised tool schemas before proposing arguments. Remote `recall`
and `forget` operate on facts marked `visibility: "world"`, still restricted by
the client's source grant. Use that explicit visibility only for the nonsensitive
synthetic test fact and keep its returned ID for cleanup. A private test fact
cannot be recalled or withdrawn through these remote operations. Never change
real private facts' visibility to make verification pass. With read-only access,
verify an authenticated capabilities/read call without adding write authority.

`forget` withdraws a fact from active memory. History, source material, and backup copies may remain; it is not a promise of physical erasure. Verifier cleanup uses the same withdrawal semantics. Failed cleanup stays visible with the fixture identifier.

## Delegation is a separate capability

Only grant delegation when you want this client to start work on the brain host. Supply a nonempty set of tools from the running registry:

```bash
gbrain mcp grant research-example --harness grok-bot \
  --profile delegating-agent --source default \
  --bound-tools search,get_page --delegated-namespace job \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token \
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
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token --dry-run --json
```

Get the current revision with `gbrain mcp admin client CLIENT_ID` using the
same server URL and owner credential. Review the before/after grant, then repeat
without `--dry-run`. `--if-version` rejects a stale edit. The client ID and secret
remain unchanged. When updating a client, omit `--profile` to preserve its
profile, scopes, operation snapshot, and bindings while changing only the fields
you supply. An explicit profile selection regrants its eligible operations.
Advanced local-maintenance repairs remain available through `gbrain auth
rescope-client CLIENT_ID --help`; omitted restrictions are retained.

Omitting `--skills` preserves the existing follow choice, including previously
approved membership when reapplying a profile. Explicit custom scope/operation
lists are respected instead of silently repaired. To explicitly
enroll an old memory client, preview `mcp grant` with its client ID, current
revision, and `--skills follow`, without `--profile`. Apply the reviewed change.
For a machine client, recover its private handoff, issue a token carrying the
added scope, and reconnect. For native OAuth, restart authorization in the
harness to request the added scope. Exact follow and dedicated-editor examples are
in [shared-skills permissions](shared-brain-skills.md#connect-each-installation).
Do not grant editing merely because the client can write memory.

Scope removals affect existing tokens immediately. Added scopes need a newly issued access token; refresh cannot expand its original scope grant. Source, operation, fence, binding, and surface changes apply on the next authenticated request. Repairing bindings benefits an existing token that already carries `agent`. TTL changes apply only to newly issued tokens. New renewable connections use one-hour access tokens; static-token adapters use 30 days. Check the receipt for the selected expiry.

## Recover an interrupted handoff

The host retains a private delivery journal before committing a new client. If the response or destination write is lost, recover the original handoff without duplicating the client:

```bash
gbrain mcp grant agent-example --client CLIENT_ID --resume --harness codex \
  --url https://brain.example.com/mcp \
  --admin-token-file /absolute/private/admin-token \
  --credentials-out /absolute/private/recovered-agent.json --json
```

Resume changes no permissions and rotates no secret. If the client ID was lost,
use `gbrain mcp admin clients` with the same URL and owner credential and inspect
the existing registration before retrying. A lost response can follow a
committed mutation; it does not prove that creation failed.

In the admin dashboard, use the existing client's setup/delivery action. New
confidential clients use the same private host journal. If registration loses
its response, inspect the existing client before recovery. Machine clients
receive a machine handoff; native OAuth clients receive their distinct OAuth
setup. Keep any secret-bearing download private and set its permissions to
`0600` on the target computer. Recovery refuses a revoked client or a journal
whose secret has since been rotated.

An expired or lost machine **access token** can be reissued using the existing
client secret. For native OAuth, reconnect in the harness. A lost **client
secret** requires journal/handoff recovery or an explicit maintenance decision;
see [legacy rotation limits](../mcp/ADMIN.md#recover-a-failed-step). The local
`agent register --reissue` path supports confidential machine clients and leaves
outstanding access tokens valid; it is not a general remote/native-PKCE recovery
command. Protect or remove the host's `.gbrain/credential-deliveries` files
deliberately after secure delivery; they contain credentials and are excluded
from default backups.

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

Remove a managed configuration with the same private handoff and `gbrain connect
... --remove`, or remove the native OAuth connection through its harness
settings. Disable saved skills/routines through the harness controls. Use
[token invalidation, revocation, or deletion](../mcp/ADMIN.md#invalidate-tokens-revoke-or-delete)
when server authority should change. Removing configuration alone does not
revoke access or delete memory.

Managed removal also attempts to leave its shared-skills enrollment and removes
only unchanged owned artifacts. `left_with_retained_files` requires review of
the preserved edits and a native restart/disable step. A server-side
`leave_brain` alone cannot remove files on the client. Offline or revoked access
does not prevent local following from being disabled: inspect
`remote_membership_pending` to distinguish local cleanup from host-acknowledged
departure and retry the latter when possible. Back up operational DB
state as well as canonical content; Git alone cannot restore memberships,
policy history, revocations, or receipts. See
[shared-skills recovery limits](shared-brain-skills.md#troubleshoot-leave-and-recover).

| Symptom | Next action |
| --- | --- |
| PGLite is busy | Use authenticated host administration (`--admin-token-file ~/.gbrain/serve/admin-token` against the running server) or wait for the current owner to close. Never remove a live lock. |
| Published URL unreachable from the agent | On the host, `gbrain mcp expose --status`. A cloud agent needs `--funnel`; tailnet-only reach serves only the owner's own devices. Certificate issuance can leave tailnet health `pending` for a minute. See the [remote MCP troubleshooting table](remote-mcp.md#troubleshooting). |
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
