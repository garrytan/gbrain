---
name: remote-mcp
description: |
  Publish the user's own gbrain over MCP so other devices, desktop apps and
  cloud agents can reach it. `gbrain mcp expose` installs and signs in
  Tailscale, publishes the running `gbrain serve --http` on the tailnet
  (HTTPS, tailnet-only by default; Funnel only when a client lives in a
  vendor cloud), keeps the server alive as a user service, and hands back the
  MCP URL. Then register one least-privilege client per consumer, choose
  native OAuth/PKCE or a private machine handoff for that client, and verify
  the connection inside the intended harness.
triggers:
  - "use my brain over mcp"
  - "serve my brain over mcp"
  - "expose my brain over mcp"
  - "gbrain mcp server"
  - "remote mcp access to my brain"
  - "put my brain on tailscale"
  - "connect grok bot to my brain"
  - "connect muse to my brain"
  - "connect claude desktop to my brain"
  - "reach my brain from my phone"
  - "gbrain mcp expose"
tools:
  - exec
mutating: true
# exempt: this skill changes host networking/service state and never answers
# a knowledge question, so there is nothing to look up in the brain first.
brain_first: exempt
---

# Remote MCP — use your brain from anywhere

> The brain already runs on the user's computer. This skill makes it reachable
> over MCP from their other devices and from the agents they use elsewhere,
> without moving the data and without putting a database on the public
> internet. Tailscale is the default transport; publishing is one command,
> access is one scoped grant per client.

## Contract

This skill guarantees:
- **Tailscale by default.** `gbrain mcp expose` publishes the local server
  with `tailscale serve` (HTTPS on the tailnet, nothing public). ngrok and
  cloud hosts stay documented alternatives, never the first suggestion.
- **Funnel is explicit.** Cloud agents whose runtime is not on the tailnet
  (Grok Bot, Muse, ChatGPT, Claude.ai / Cowork, Perplexity) need
  `--funnel`, which makes the same `*.ts.net` name publicly reachable. Say
  so before running it; the endpoint is then protected by gbrain's OAuth /
  bearer auth and scoped grants, not by the network.
- **Consent before system changes.** Installing Tailscale, running
  `tailscale up`, writing a serve/funnel config and creating a user service
  are host-state changes. Show the operator the printed plan and get a yes
  before passing `--yes`.
- **Engine-free.** `gbrain mcp expose` never opens the database. On a PGLite
  brain the running server owns the single-writer lock, so every later
  provisioning step goes through the server's authenticated admin API
  (`--admin-token-file`), never a second process on the database.
- **No secrets in chat.** The admin token lives in
  the receipt's `admin_token_file` (normally `~/.gbrain/serve/admin-token`);
  machine and confidential OAuth credentials land in a private
  `--credentials-out` file. Public PKCE has no secret. Quote redacted
  receipts; deliver a requested owner login link privately and unopened.
- **Owner authority is separate.** The expose-managed wrapper loads its
  token file as `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`; that file authorizes
  `gbrain mcp admin` and `mcp grant` against that server. An ordinary MCP
  token, client secret, or OAuth `admin` scope does not. With `--no-service`,
  use the independently running server's actual configured owner credential;
  creating an expose token file does not configure that process.
- **Least privilege.** One client per consumer, `memory-writer` for ordinary
  memory use or `memory-reader` for read-only access. Broader access requires
  the user's request. Never `operator` / `full` / `admin` to make a convenience
  check pass.
- **Server checks are not native activation.** `gbrain mcp verify` accepts a
  private machine handoff and checks the access that grant permits. Native
  OAuth is verified through the native client's authenticated connection.
  A generated file or server probe does not prove that client loaded its tools.

## Decision table — who is connecting?

| Client | Shape | Command |
| --- | --- | --- |
| Your own devices: Claude Desktop, Claude Code / Codex / opencode on another laptop, phone apps joined to the tailnet | tailnet-only HTTPS (default) | `gbrain mcp expose --dry-run` (preview; the run itself is Phase 2, after consent) |
| Cloud agents running in a vendor's cloud: Grok Bot, Muse, ChatGPT connector, Claude.ai / Cowork, Perplexity Computer | public HTTPS on the same `*.ts.net` name | `gbrain mcp expose --funnel --dry-run` (preview; Phase 2 after consent) |
| Cloud agent whose runtime you can join to your tailnet (userspace `tailscaled`, ephemeral auth key) | tailnet-only | Advanced, unverified, not automated — see the [remote MCP guide](../../docs/guides/remote-mcp.md) |
| Local agents on the same machine (Claude Code, Codex, opencode) | loopback — no Tailscale needed | Postgres: `gbrain bootstrap harness --yes --port 3131`. PGLite: mint the token BEFORE the service runs (`gbrain auth create local-agents --scopes read,write` — before `gbrain mcp expose`, or while the service is briefly stopped) and pass `gbrain bootstrap harness --yes --port 3131 --token <value>`; OR use the scoped path `gbrain mcp grant <name> --harness <id> --profile memory-writer --source default --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json` then `gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/<name>.json --install` (MCP wiring only, no per-turn hooks) |
| Thin client only (this machine has no brain) | — | Stop: run this skill on the brain host |

Grok Bot and Muse users with no always-on machine keep the in-agent local
install described in [setup](../setup/SKILL.md) as the alternative.

Network reach and authentication are separate choices. A vendor name or
tailnet/Funnel mode does not select the credential flow: inspect the intended
client's native OAuth settings or supported private-handoff adapter in Phase 3.

## Phase 1 — Detect

```bash
gbrain engine status --json
gbrain mcp expose --status --json
```

- `thin_client: true` → the brain lives elsewhere. Stop and say the command
  runs on the brain host.
- `effective_engine: "pglite"` → note the single-writer rule (below) before
  continuing; `"postgres"` → concurrent local commands stay fine.
- `--status` reports `status: "not_exposed"` (exit 2 with `--json`) →
  Phase 2. `status: "exposed"` → skip to Phase 3 with the printed
  `mcp_url`. `status: "pending"` → the certificate or service is still coming
  up; re-run `--status` in a minute before changing anything.
  `reason: "leftovers_without_receipt"` (exit 1) → an interrupted run left
  the wrapper, the unit / service or a `:443` handler behind; run the exact
  `gbrain mcp expose --remove --yes …` line from `next_actions` (it carries
  `--force` only when a handler stands alone), then Phase 2.
- The brain is already reachable over HTTPS by other means (an existing
  `serve --http` behind ngrok / a reverse proxy, or a brain hosted elsewhere) →
  do NOT run `gbrain mcp expose`. Go straight to hosted access: choose the
  client's connection method and register it against that endpoint (Phase 3
  with its URL and owner authority), then configure the client (Phase 4).
- Ask which clients should reach the brain (the decision table decides
  tailnet vs `--funnel`). Do not ask questions the user already answered.

## Phase 2 — Publish

Preview first, then run with consent:

```bash
gbrain mcp expose --dry-run            # prints the plan; changes nothing
gbrain mcp expose --yes                # your own devices (tailnet only)
gbrain mcp expose --funnel --yes       # a cloud agent must reach it
```

Options: `--port N` (default 3131), `--surface verbs|starter|full` (default
`full`, mirrors `serve --http`), `--enable-dcr`, `--no-tailscale` (publish
nothing; just install the service), `--no-service` (publish only; the
operator runs `serve` themselves), `--no-install` (fail instead of
installing Tailscale), `--force` (take over a serve handler that already
points at another local port), `--json`.

What the command does, in order: plan (refuses up front when anything —
HTTP or not — already listens on the port and `--no-service` is absent, and
when `--no-tailscale` is passed over a receipt that records a live tailnet
mapping) → consent → find or install the `tailscale` binary → sign in if
needed (Linux: `sudo tailscale set --operator=$USER`, then `sudo tailscale up`
— `sudo` only in front of a system-installed binary; the operator preference
is persistent and `--remove` does not revoke it; macOS: `tailscale up`) →
read the machine's tailnet DNS name and pre-check that HTTPS certificates are
enabled (and, with `--funnel`, that the node has the Funnel capability) →
`tailscale serve` / `funnel` → ensure the admin token →
write the wrapper and a launchd agent / systemd user unit → poll local and
tailnet `/health` → write the receipt `~/.gbrain/serve/expose.json`. With
`--json` every step is a named check (`plan`, `consent`, `tailscale.binary`,
`tailscale.login`, `tailscale.identity`, `tailscale.publish`, `admin_token`,
`service`, `verify.local`, `verify.tailnet`, `receipt`); the health checks
are `verify.local` and `verify.tailnet`, not `verify`.

Relay every prompt the command surfaces:

| Output | What you do |
| --- | --- |
| Tailscale login URL printed by `tailscale up` | Give the user the URL, wait for them to sign in; on exit 2 (`tailscale_login_pending`) re-run the exact command the output prints |
| `declined` (exit 2, "Nothing changed.") | The operator said no at the prompt. Nothing was installed or published; pass `--yes` only after they confirm the printed plan |
| `tailscale_https_not_enabled` — pre-check, exit 2, nothing published (`CertDomains` empty) | Enable MagicDNS + HTTPS Certificates at `https://login.tailscale.com/admin/dns`, then re-run the printed command. The same reason with exit 1 means the `tailscale serve` call itself refused for the same cause — same fix |
| `tailscale_funnel_not_enabled` — pre-check, exit 2, nothing published (the node lacks the Funnel capability) | Enable the `funnel` node attribute in the tailnet policy (`https://login.tailscale.com/admin/acls`; see `https://tailscale.com/kb/1223/funnel`), then re-run. Exit 1 with this reason is the post-`funnel` classified form — same fix |
| `tailscale_needs_operator` | Run `sudo tailscale set --operator=$USER`, then re-run |
| `tailscale_unknown` (exit 1) — `tailscale serve --bg` did not finish within 60s | The CLI is waiting on the operator (an enablement step the pre-checks could not see). Have them run the printed `tailscale serve --bg <port>` by hand to see its prompt, then re-run |
| `tailscale_needs_login` | Linux: `sudo tailscale set --operator=$USER` then `sudo tailscale up`; macOS: `tailscale up` or open the Tailscale app and sign in; then re-run |
| `tailscale_login_manual` (exit 2) — "tailscale at <path> is not a system install, so gbrain will not run it with sudo" | The `tailscale` on `PATH` is user-writable (e.g. `~/.local/bin`); gbrain never runs it as root. The printed command names that path — `sudo <path> set --operator=$USER && sudo <path> up` (a bare `sudo tailscale` would not find a binary outside sudo's `secure_path`). Running it is the operator choosing to trust that binary: say so, let them run it themselves, then re-run the printed command |
| `tailscale_receipt_present` (exit 1, `plan` fails) — "This brain is already published on your tailnet at <url>" | `--no-tailscale` was passed while a live Serve/Funnel mapping is on record. Run `gbrain mcp expose --remove --yes` first, or drop `--no-tailscale` |
| `tailscale_daemon_not_running` (exit 2) | macOS `open -a Tailscale`; Linux `sudo systemctl enable --now tailscaled`; then re-run |
| `foreign_serve_config` — "tailscale serve already proxies :443 to …" (exit 1) | Show the user what the existing handler proxies (`tailscale serve status`); only `--force` on their explicit yes. A handler owned by another terminal's foreground `tailscale serve` session cannot be taken over — it must be stopped in that terminal |
| `foreign_listener` — "Something already answers on 127.0.0.1:<port> and no expose receipt claims it" (exit 1, refused BEFORE anything is published; ANY listener counts — an accepted TCP connect from a non-HTTP service as much as a 404) | Stop the other process, pick another `--port`, or pass `--no-service` to publish it as-is. If it is a gbrain server left by an interrupted run, `gbrain mcp expose --remove --yes` first (receipt-less recovery) |
| `no_brain_config` (exit 1, `plan` fails) — "No brain is configured on this host (gbrain init first), so a service would only crash-loop" | Run `gbrain init` on this host first, then re-run; or pass `--no-service` to only publish a server the operator starts themselves. Never install the service around a missing brain |
| `pglite_lock` warn — "a live process holds this PGLite brain (pid N, …)" | Tell the user which process holds the lock; the service cannot start until it exits. Stop it (or route to [postgres-adopt](../postgres-adopt/SKILL.md) for concurrent use), then `gbrain mcp expose --status` |
| "could not read tailscale serve status" — `tailscale.publish` fails (publish: exit 1 `tailscale_<kind>`, nothing published; `--status`: exit 1; `--remove`: exit 1 `tailscale_serve_status_unreadable` — with a receipt, receipt + wrapper kept; without one, the service is still removed but the wrapper is kept as the corroboration the re-run needs) | The command fails closed instead of guessing. Run `tailscale serve status --json`, apply the classified fix (operator / daemon / login), then re-run the same command |
| `handler_not_removed` (`--remove`, exit 1) — "the tailscale handler for port <port> is still present" / "could not be confirmed gone" | The `off` ran but gbrain's handler survived (or the re-read failed). The service is already gone; the receipt and wrapper were kept on purpose. Run `tailscale serve status`, fix what it reports, then `gbrain mcp expose --remove --yes` again — never `serve reset` |
| `verify.tailnet: warn` — "this host cannot resolve <name>" (exit 0) | MagicDNS is off on the brain host itself; `tailscale set --accept-dns=true`, then `gbrain mcp expose --status`. Other devices may already reach the server; do not treat it as a certificate wait |
| `service: manual` (no supervisor: cloud sandbox, container) | Relay the printed foreground and `nohup … &` commands; this is a documented outcome, not a failure |
| `verify.local: warn` (exit 2, `local_health_timeout`) | The handler is published, the service installed and the receipt written — this exit 2 is NOT "nothing published"; `--status` / `--remove` find them. `/health` did not answer within the wait: check `~/.gbrain/serve/serve.err`, then `gbrain mcp expose --status` |
| `verify.tailnet: pending` (exit 2, `tailnet_health_pending`; `--status` reports it with exit 1) | Same: handler, service and receipt are already in place. First certificate issuance can take a minute; `gbrain mcp expose --status` later |
| `confirmation_required` (exit 2) | Non-TTY run without `--yes`. Nothing changed; show the printed plan, get the operator's yes, then re-run with `--yes` |
| `tailscale_no_dns_name` (exit 1) — the node has no MagicDNS name | Enable MagicDNS + HTTPS Certificates at `https://login.tailscale.com/admin/dns`, then re-run; nothing was published |
| `tailscale_missing` (exit 1, `--no-install`) / `tailscale_unsupported_platform` / `tailscale_install_failed` (exit 1) | Tailscale is not installed and was not (or could not be) installed. Relay the printed install command or `https://tailscale.com/download`, have the user sign in, then re-run |
| `tailscale_publish_unconfirmed` (exit 1) — `serve --bg` exited 0 but the re-read shows no handler (or could not be read) | Run `tailscale serve status`; `gbrain mcp expose --remove --yes` clears a handler for the port without a receipt (`--force` when no wrapper or service of gbrain's exists yet), then re-run |
| `service_install_failed` (exit 1) | The handler IS published and the receipt written with `service.state: stopped`. Read the error and `~/.gbrain/serve/serve.err`, fix, re-run; or `gbrain mcp expose --remove --yes` |
| `status_unhealthy` (`--status`, exit 1) | A named check failed (`tailscale.publish`, `service`, `verify.local`); apply that row, then `gbrain mcp expose --yes` repairs |
| `recovered_without_receipt` (`--remove`, exit 0) | The receipt-less recovery finished: report what was removed and what was left (the admin token stays) |

Never work around a classified error by editing Tailscale state by hand;
apply the printed fix and re-run.

## Phase 3 — Choose the client flow and owner authority

Use the successful expose receipt's `mcp_url` and `admin_token_file`; substitute
them for the example URL/default path below, including when `GBRAIN_HOME` is
customized. Run owner commands on the host or in a separately authorized admin
harness with that server's protected credential. An ordinary connecting client
hands these steps to that administrator; its OAuth scopes cannot grant owner
authority. Follow [mcp-access](../mcp-access/SKILL.md) and
[MCP administration](../../docs/mcp/ADMIN.md) for owner actions and recovery.

To open the dashboard:

```bash
gbrain mcp admin login-link --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --json
```

Deliver the single-use link privately without fetching it. The plain admin URL
does not authenticate. For pending native consent, add `--oauth-request ID`
with the exact opaque ID from the client's browser request; the owner then
reviews consent separately. Expired requests or a restart require restarting
authorization in the native client.

| Intended connection | Register | Deliver |
| --- | --- | --- |
| Native public PKCE | `mcp admin register`, method `none`, exact client callback | Native OAuth metadata; no client secret |
| Native confidential PKCE | `mcp admin register`, actual `client_secret_post` or `client_secret_basic`, exact callback | Private `OAuthClientSetup` via `--credentials-out` |
| Machine credentials / managed bearer configuration | `mcp grant --harness ID` | Private machine handoff for `gbrain connect` |

For native OAuth, obtain the actual redirect URI and authentication method from
the intended harness. `CLIENT_REDIRECT_URI` below must be replaced with that
exact URI; it is not a suggested callback:

```bash
gbrain mcp admin register native-example --redirect-uri 'CLIENT_REDIRECT_URI' \
  --token-endpoint-auth-method none --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --dry-run --json
```

Review the preview, then repeat without `--dry-run`. For confidential PKCE, use
the client's actual POST/Basic method and add `--credentials-out PRIVATE_FILE`
before creation. Native registration creates authorization-code and refresh
grants, not a machine token. Retrieve instructions using its returned ID:

```bash
gbrain mcp admin setup CLIENT_ID --harness generic --flow authorization-code \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --json
```

Use the actual supported adapter ID when known; `generic` gives manual native
settings instructions. The native client initiates OAuth and owns its verifier.
An `OAuthClientSetup` is not a machine handoff for `gbrain connect` or
`gbrain mcp verify`. Keep DCR off unless the owner explicitly chooses it; manual
owner registration works without `--enable-dcr`.

For a client using a private machine handoff, preview through the same running
server's admin API:

```bash
gbrain mcp grant agent-example --harness grok-bot --profile memory-writer \
  --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/agent-example.json --dry-run --json
```

- `--harness` is the real adapter id (`gbrain mcp adapters`): `grok-bot`,
  `muse`, `claude-desktop`, `codex`, `claude-code`, `opencode`, ...
- Review the preview, then repeat without `--dry-run` to create the client.
- Profiles (`memory-reader`, `memory-writer`, `coding-agent`, `operator`,
  `delegating-agent`, `full`) and delegation limits are defined in
  [hosted harness access](../../docs/guides/hosted-harness-access.md);
  default to `memory-writer`, or `memory-reader` when only reading is requested.
- The receipt is redacted; the credentials file is 0600. Move it to the
  client through a private channel, never through the chat.

## Phase 4 — Configure the selected connection inside the client

| Client | Install |
| --- | --- |
| Any native OAuth client, including a supported Desktop/cloud connector | Enter the native registration's actual endpoint, client ID, callback, and method in its supported settings; confidential clients also receive the private OAuth secret. Start authorization in that client and obtain owner consent. Follow its `docs/mcp/` guide when manual client configuration is unavailable; do not substitute machine credentials. |
| Grok Bot using the private machine path | Inside the Bot: `gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness grok-bot --credentials-file /private/agent-example.json --install --root /workspace/gbrain`; enable the generated instruction as a native skill (a visible, separate step) |
| Muse using the private machine path | Same `gbrain connect … --harness muse … --install --root <verified durable root>`; establish the durable user-files location first — never `/tmp`, never an invented path |
| Claude Code / Codex / opencode using managed private configuration on another machine | `gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness codex --credentials-file /private/agent-example.json --install`; select the actual adapter |
| Local agents on the brain host | Postgres: `gbrain bootstrap harness --yes --port 3131`. PGLite: `bootstrap harness` refuses under the live serve unless `--token` is passed — mint BEFORE the service runs (`gbrain auth create local-agents --scopes read,write`, run before `gbrain mcp expose` or while the service is briefly stopped) and pass `gbrain bootstrap harness --yes --port 3131 --token <value>`; or skip hooks and use the scoped `gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json` + `gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/<name>.json --install` path (MCP wiring only) |
| ChatGPT / Perplexity / other cloud OAuth clients | Requires explicit `--funnel` when the runtime is outside the tailnet; follow the native OAuth path and per-client page under `docs/mcp/` with the published URL |

Tailnet-only endpoints are reachable only from devices signed in to the same
tailnet — if a device cannot resolve `your-machine.your-tailnet.ts.net`,
install Tailscale there and sign in; do not switch to `--funnel` for that.

## Phase 5 — Verify

For the private machine path, from the client's environment:

```bash
gbrain mcp verify --client CLIENT_ID --harness grok-bot \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-file /private/agent-example.json --json
```

`server_status: "passed"` proves the permitted server checks; writable grants
also exercise randomized write/readback and cleanup. Native activation remains
separate; exit 2 (`partial`) is not completed native verification.

For native OAuth, observe `gbrain://capabilities` and an allowed call through
that harness's authenticated MCP connection. Do not pass an OAuth setup export
to the private-handoff verifier. For either path, observe calls in the intended
harness and inspect the advertised schemas before a memory test. With an
authorized writable grant, use only a harmless synthetic fact
with provenance and explicit `visibility: "world"` within its source grant;
retain its returned ID, verify recall in a new conversation, correct it, and
withdraw it. Private facts cannot be recalled or withdrawn through these remote
operations; never change real private content to pass a test. With read-only
access, observe an authenticated read without adding write authority. Report
registration, setup delivery, server checks, native calls, and cleanup separately.

Host-side check at any time: `gbrain mcp expose --status` (without a receipt
it reports leftovers as `leftovers_without_receipt`, exit 1, with the exact
cleanup command). Remove the exposure and host service:
`gbrain mcp expose --remove` (stops and removes the service — also when the
receipt says it was skipped but the unit exists — clears only gbrain's
serve/funnel handler with `--https=443 --set-path=/ off`, keeps Tailscale
installed and signed in — the Linux operator preference too — and keeps the
admin token unless `--force`; without a receipt — an interrupted publish — it
recovers from what is on disk: the wrapper, the unit and the `:443` handler
for `--port`, default 3131, leaving the token; the handler is turned off only
when the wrapper, unit or service corroborates it — a handler standing alone
is reported and left until `--force`). A handler that survives the `off` is
never reported as removed: exit 1 `handler_not_removed`, receipt + wrapper
kept for the re-run. An unreadable `tailscale serve status` stops both paths
with exit 1 `tailscale_serve_status_unreadable` (the service is already
removed; receipt and/or wrapper kept) — fix Tailscale, re-run the printed
command. Declining the prompt exits 2 with "Nothing changed."; a
`--no-service` re-run keeps an existing service.

Removing exposure does not revoke client registrations or erase brain data.
Use the owner lifecycle commands in [MCP administration](../../docs/mcp/ADMIN.md)
to invalidate tokens, revoke, or delete a selected client after reviewing its
consequences and revision.

## PGLite single-writer note

While the exposed server runs, it holds the PGLite lock. Host-side commands
that open the database (`gbrain doctor`, `gbrain mcp grant` WITHOUT an owner
file or protected `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, `gbrain bootstrap harness`
without `--token`) FAIL FAST
with `live_serve` — they do not wait. Administer through the running server
instead. `gbrain sync` and `gbrain sweep --once` are the exceptions: they
delegate into the live serve automatically. Always provision through
`--admin-token-file`; if the user needs concurrent local commands, route to
[postgres-adopt](../postgres-adopt/SKILL.md) rather than stopping the server.

## Anti-Patterns

- NEVER recommend ngrok or a cloud host first; Tailscale is the default and
  the alternatives are for people who explicitly want them.
- NEVER `gbrain serve --http --bind 0.0.0.0` for this shape. Tailscale Serve
  terminates TLS and forwards to loopback; the default bind is correct.
- NEVER pass `--funnel` silently. Say that it makes the endpoint publicly
  reachable and why this client needs it.
- NEVER paste the admin token or a credentials file into the conversation,
  a commit, or a command argument the harness logs.
- NEVER run `tailscale serve reset`, `tailscale logout`, or uninstall
  Tailscale to clean up — `gbrain mcp expose --remove` touches only gbrain's
  handler.
- NEVER grant `operator`/`full`/`admin` because a health check failed.
- NEVER treat OAuth `admin` scope as owner authority, or install a native
  OAuth setup file as a private machine handoff.
- NEVER claim the client is connected because `mcp verify` passed; native
  activation and new-conversation recall are observed in the client.
- NEVER open the live PGLite database from a second process to provision.

## Output Format

Report the host state and one line per client:

```
MCP URL   https://your-machine.your-tailnet.ts.net/mcp   (reach: tailnet only | public via Funnel)
Service   launchd com.gbrain.serve, running   (log: ~/.gbrain/serve/serve.log)
Engine    pglite — provision via --admin-token-file
Client    agent-example (grok-bot, memory-writer): granted, installed, verify passed, native activation pending
Pending   <exact next command, or "nothing">
```

Quote `gbrain mcp expose --status` and `gbrain mcp verify` output as-is (both
are redacted). Name every unverified step explicitly; a passing server check
never stands in for observed recall inside the client.
