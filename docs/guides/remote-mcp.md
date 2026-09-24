# Use your brain from anywhere over MCP

Your brain runs on your own computer. `gbrain mcp expose` publishes its MCP
server on your [Tailscale](https://tailscale.com) tailnet with HTTPS, keeps
it running as a user service, and prints the URL your other devices, apps and
cloud agents connect to. Tailscale is the recommended path; ngrok and cloud
hosts stay as [alternatives](#alternatives).

**Say to your agent:** *"use my brain over mcp"* — *"put my brain on
tailscale"* — *"connect grok bot to my brain"* / *"connect claude desktop to
my brain"* — *"reach my brain from my phone"*. The `remote-mcp` skill
(`skills/remote-mcp/SKILL.md`) walks the agent through publishing, choosing
native OAuth or a private machine handoff, and verifying the intended client;
the exact commands are below.

## Who reaches what

| Client | Shape | Why |
| --- | --- | --- |
| Your own devices — Claude Desktop, Claude Code / Codex / opencode on another laptop, phone apps on the tailnet | `tailscale serve` (tailnet-only HTTPS) — the **default** | Nothing on the public internet; Tailscale ACLs plus gbrain auth |
| Cloud agents that run in a vendor's cloud — Grok Bot, Muse, ChatGPT connector, Claude.ai / Cowork, Perplexity Computer | `tailscale funnel` (public HTTPS on the same `*.ts.net` name) — explicit `--funnel` | Their runtime is not on your tailnet; gbrain's OAuth/bearer auth plus scoped grants protect the endpoint |
| A cloud agent whose runtime you can join to your tailnet (userspace `tailscaled`, ephemeral auth key) | tailnet-only | Advanced; not automated and not verified against a real vendor runtime |

`gbrain mcp expose` never publishes to the public internet unless you pass
`--funnel`. Both shapes keep `gbrain serve --http` on its default loopback
bind (`127.0.0.1`); Tailscale terminates TLS and forwards to it. The
"`--public-url` is set but `--bind` is not" warning at startup is expected
in this shape.

## What `gbrain mcp expose` does

```bash
gbrain mcp expose                # tailnet-only, port 3131, full surface, service installed
gbrain mcp expose --funnel       # also reachable by cloud agents (public HTTPS)
gbrain mcp expose --dry-run      # print the plan, change nothing
```

Run it **on the brain host** (a thin client is refused: "run on the brain
host"). It never opens the database, so it works while `gbrain serve` holds a
PGLite brain's single-writer lock. Every step is reported as a named check
(`--json` lists them):

| Step | What happens |
| --- | --- |
| `plan` | Resolves options; detects platform, execution environment and engine kind (PGLite vs Postgres); prints what will be installed or changed. A host with **no brain config** (no `gbrain init` yet, or an unreadable config) is refused here with `no_brain_config` — a service there would only crash-loop — unless you pass `--no-service` to publish a server you run yourself (`--dry-run` still prints the plan, with the refusal marked, and exits 0). On a PGLite brain it also reads the lock file: a live process that is not gbrain's own running service adds a `Lock` line and a `pglite_lock` **warning** (the service cannot start until that process exits — stop it, or move to Postgres); the run proceeds. `--no-tailscale` while the receipt says the brain is published on the tailnet (it records a MagicDNS name) is refused with `tailscale_receipt_present` — rewriting the receipt to loopback would leave the live Serve/Funnel mapping unfindable; run `gbrain mcp expose --remove --yes` first, or drop the flag. Then it probes `127.0.0.1:<port>`: **anything listening there** — a TCP connect that is accepted (a non-HTTP service too) or an HTTP answer of any status on `/health` (a 404 or 500 counts — the port is occupied) — with no receipt claiming that port stops the run with `foreign_listener` ("Something already answers on 127.0.0.1:<port> and no expose receipt claims it. Stop it, pick another --port, or pass --no-service to only publish it. If this is a gbrain server left behind by an interrupted `gbrain mcp expose`, run `gbrain mcp expose --remove --yes` first.") **before** anything is published. `--dry-run` stops here. |
| `consent` | Installing Tailscale, running `tailscale up`, writing the serve/funnel config and creating a user service change system state. Interactive: one y/N prompt; declining is `pending` / exit 2 with "Nothing changed. Re-run with --yes to confirm." Non-interactive without `--yes`: prints the plan plus "pass --yes to confirm" and exits 2. |
| `tailscale.binary` | Finds `tailscale` on PATH or in the usual macOS/Homebrew/Linux locations. Missing: macOS installs `brew install --cask tailscale-app`; Linux runs the official `curl -fsSL https://tailscale.com/install.sh \| sh` installer (it prompts for sudo itself). `--no-install` prints the plan and exits 1 instead. Other platforms: exit 1 with https://tailscale.com/download. |
| `tailscale.login` | Reads `tailscale status --json`. Not logged in: Linux runs `sudo tailscale set --operator=$USER` first (so you can run `serve` without root afterwards; a failure is noted, not fatal) and then a flagless `sudo tailscale up`; macOS runs the app CLI's `tailscale up` (after a fresh `brew` install it opens the app and gives it a moment first). Linux puts `sudo` in front of the binary **only when it is a system install** (`/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, or a symlink resolving there); a `tailscale` found elsewhere on `PATH` (say `~/.local/bin`) is never run as root — the step stops with `tailscale_login_manual` (exit 2) and, if you trust that binary, asks you to run `sudo <that path> set --operator=$USER && sudo <that path> up` yourself (the full path, because a binary outside sudo's `secure_path` is exactly this case), then re-run. Shows the login URL. Waits up to five minutes; still not running: exit 2 (`tailscale_login_pending`) with the exact re-run command. |
| `tailscale.identity` | Takes your MagicDNS name → `https://your-machine.your-tailnet.ts.net`, then pre-checks the tailnet features `serve`/`funnel` need — the Tailscale CLI does not fail when they are missing, it prints an enablement URL and waits for you interactively, so `expose` never starts it blind. `CertDomains` empty (HTTPS certificates not enabled) → `pending`, exit 2, reason `tailscale_https_not_enabled`, with https://login.tailscale.com/admin/dns and the re-run command. `--funnel` on a node without the Funnel capability → `pending`, exit 2, reason `tailscale_funnel_not_enabled`, with https://login.tailscale.com/admin/acls and the [Funnel docs](https://tailscale.com/kb/1223/funnel). In both cases nothing has been published yet. |
| `tailscale.publish` | Reads `tailscale serve status --json` — including other terminals' foreground serve sessions and a raw TCP forward on `:443` — and refuses to overwrite a `/` handler that already proxies a different local port unless `--force` (`foreign_serve_config`; a foreground session has to be stopped in its own terminal, `--force` cannot replace it). That read **fails closed**: a non-zero or killed exit, or output that is not a JSON object, is never treated as "nothing configured" — the run stops with the classified reason (`tailscale_needs_operator`, `tailscale_daemon_not_running`, `tailscale_unknown`, …) and nothing is published; only an empty document from a clean exit is an empty config. Then `tailscale serve --bg <port>` (or `tailscale funnel --bg <port>`) with a 60s timeout; a hang is reported as `unknown` with the command to run by hand. Stderr failures are classified as a second line of defense (see [Troubleshooting](#troubleshooting)). Re-reads the status to confirm the port is proxied. Switching your own handler from Funnel back to tailnet-only turns Funnel off first (`tailscale funnel --https=443 --set-path=/ off` — `--set-path=/` scopes `off` to gbrain's one mount; without it the CLI removes every mount under `:443` and prompts when several exist); if the following `serve --bg` then fails, times out or cannot be confirmed, the previous Funnel handler is re-published and the check says whether that restore worked, and the existing receipt is kept. The other direction is one atomic `funnel --bg`. |
| `admin_token` | Ensures `~/.gbrain/serve/admin-token` (0600, 64 hex chars). Reused on later runs; never printed. The expose-managed service wrapper loads it as `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, so `gbrain mcp admin` and `gbrain mcp grant --admin-token-file` work headlessly. With `--no-service`, the independently running server must already use the matching credential; creating this file does not configure that process. |
| `service` | Writes the wrapper `~/.gbrain/serve/gbrain-serve.sh`, then installs a **launchd user agent** (`com.gbrain.serve`; `launchctl bootout gui/$(id -u)` then `launchctl bootstrap gui/$(id -u)`, so a re-run relaunches the regenerated wrapper — a bootstrap that fails while launchd is still unloading the previous job ("Input/output error", "already in progress") is retried up to five times a second apart; the legacy `unload`/`load` pair is used only when that launchctl does not know the modern verbs) on macOS or a **systemd user unit** (`gbrain-serve.service`) on Linux with a user bus (`daemon-reload` → `enable` → `restart`, so a re-run's regenerated wrapper takes effect) and starts it. The receipt is written **right after this step** (before verify), so an interrupted run always leaves something `--status` / `--remove` can find. No supervisor (cloud sandbox, ephemeral container): `service: manual` — the wrapper is written and the exact foreground and `nohup … &` commands are printed. `--no-service` only publishes an already-running server; on a re-run it keeps the service block of the existing receipt and leaves the wrapper alone. If the install fails (`service_install_failed`, exit 1) the receipt is still written with `service.state: stopped` so `--status` and `--remove` can see and clean up the published handler. |
| `verify.local` / `verify.tailnet` | `verify.local` polls `http://127.0.0.1:<port>/health` (20s wall clock; a timeout is a `warn` and exit 2 with `verify.tailnet` skipped). `verify.tailnet` polls `https://<your name>/health` (30s); `pending` is exit 2 (first certificate issuance can take a while), never a hard failure. When **this host cannot resolve its own MagicDNS name** the check is a `warn`, not `pending`, and the run exits 0: MagicDNS is probably off on this machine (`tailscale set --accept-dns=true`), and devices that do resolve the name may already reach the server. Bun's `fetch` reports an unresolvable name and a refused connection with the same error, so after a rejected probe `expose` asks the system resolver directly — `ENOTFOUND`, `EAI_AGAIN`, `EAI_NONAME`, `EAI_NODATA` mean "unresolved here" (a rejection whose message already names one of those counts too); a name that resolves but does not answer stays `pending`. |
| `receipt` | Rewrites `~/.gbrain/serve/expose.json` (0600) with the settled service state (the early copy from the `service` step is updated; `created_at` is kept): port, URLs, mode, surface, service target and paths, engine kind. No secrets. |

Exit codes: `0` done, `1` failed, `2` needs confirmation (`--yes`, or you
declined the prompt) or a step is still pending (a tailnet feature to enable,
Tailscale login, certificate issuance). Which exit 2 it is matters:

- A **pre-check** exit 2 — `consent` (`confirmation_required`, `declined`),
  `tailscale.login` (`tailscale_daemon_not_running`, `tailscale_login_manual`,
  `tailscale_login_pending`) or `tailscale.identity`
  (`tailscale_https_not_enabled`, `tailscale_funnel_not_enabled`) — happens
  before anything is published, so it adds no serve/funnel handler, no service
  and no receipt. The login step may already have changed node state on the
  way there, though: on Linux `sudo tailscale set --operator=$USER` records a
  persistent preference (your user may configure `serve` without root from
  then on; `--remove` does not revoke it — `sudo tailscale set --operator=`
  resets it) and `sudo tailscale up` may have joined the machine to your
  tailnet.
- A **`pending`** exit 2 from `verify.local` / `verify.tailnet`
  (`local_health_timeout`, `tailnet_health_pending`) happens AFTER the handler
  was published, the service installed and the receipt written. Nothing is
  missing — the server just has not answered yet; `--status` re-probes it and
  `--remove` finds everything.

The wrapper reads the admin token from its file at run time, sources your
shell profile and `~/.gbrain/env`, prepends the Bun directory to `PATH`, and
`exec`s `gbrain serve --http --port N --public-url URL [--surface X]
[--enable-dcr]`. The token never lands in the plist, unit or wrapper.

Paths above use the default GBrain home. Use the receipt's `admin_token_file`
and `mcp_url` for the intended server, especially with a custom `GBRAIN_HOME`.
The owner credential authorizes administration; an ordinary MCP token, client
secret, or OAuth `admin` scope does not. For `--no-service`, use that existing
server's actual protected owner credential, or follow its normal maintenance
procedure to configure one. A generated file or healthy endpoint alone does
not prove owner access.

### Success output

Example for a managed service; command paths use the actual resolved home:

```
GBrain MCP server published on your tailnet
  MCP URL   https://your-machine.your-tailnet.ts.net/mcp
  Admin     https://your-machine.your-tailnet.ts.net/admin   (owner session required)
  Owner     ~/.gbrain/serve/admin-token (protected service credential)
  Reach     tailnet only — your devices. Cloud agents (Grok Bot, Muse, ChatGPT) need `--funnel`.
  Service   launchd com.gbrain.serve, running   (log: ~/.gbrain/serve/serve.log)
  Engine    PGLite (single-writer): host-side commands that open the database fail with `live_serve` —
            administer through the running server (--admin-token-file; `gbrain sync` delegates to it),
            or move to Postgres for concurrent local use.

Next — choose the connection method supported by the intended client
  Owner login      gbrain mcp admin login-link --url https://your-machine.your-tailnet.ts.net/mcp --admin-token-file '/home/example/.gbrain/serve/admin-token'
  Native OAuth     gbrain mcp admin register --help (public/confidential PKCE; exact client redirect URIs)
                   The native client starts authorization; the owner separately reviews consent.
  Machine client   gbrain mcp grant <name> --harness <id> --profile memory-writer --source default \
                     --url https://your-machine.your-tailnet.ts.net/mcp \
                     --admin-token-file '/home/example/.gbrain/serve/admin-token' --credentials-out /private/<name>.json
  Machine install  gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness <id> --credentials-file /private/<name>.json --install
  Local agents     PGLite: mint before the service runs (gbrain auth create local-agents --scopes read,write),
                   then gbrain bootstrap harness --yes --port 3131 --token <value>; or grant a scoped client with
                   gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token
                   and gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file … --install
  Check            gbrain mcp expose --status
```

The `Engine` and `Local agents` lines depend on the engine the receipt
recorded: a Postgres brain prints `Local agents     gbrain bootstrap harness
--yes --port 3131` because minting works while the server runs.

The displayed machine grant/connect example is the **private machine handoff** path.
For a native OAuth client, use the registration/setup path below instead.
Tailnet versus Funnel controls reachability, not which authentication flow a
client supports. The printed admin URL opens a login page; it does not sign in.

## Command surface

```
gbrain mcp expose [--port N] [--funnel] [--surface verbs|starter|full] [--enable-dcr]
                  [--no-tailscale] [--no-service] [--no-install] [--force]
                  [--dry-run] [--yes] [--json]
gbrain mcp expose --status [--json]
gbrain mcp expose --remove [--yes] [--json]
```

| Flag | Meaning |
| --- | --- |
| `--port N` | Local port for `gbrain serve --http` (default `3131`). Tailscale proxies `:443` on your MagicDNS name to it. With `--status` or `--remove` and no receipt, the port whose leftover `:443` handler is looked for and cleaned up. |
| `--funnel` | Public HTTPS via Tailscale Funnel instead of tailnet-only Serve. Required for cloud agents. |
| `--surface verbs\|starter\|full` | Tool surface of the served MCP server (default `full`, same as `serve --http`). |
| `--enable-dcr` | Turn on self-service client registration on the served server (off by default; every self-registered connection still stops for your approval in the admin dashboard). |
| `--no-tailscale` | Skip Tailscale entirely: install the service on loopback only, publish nothing. Exclusive with `--funnel`. |
| `--no-service` | Do not create a user service; only publish a server you run yourself. Also the way to publish from a host with no brain config (`no_brain_config`). |
| `--no-install` | Never install Tailscale; print the install plan and exit 1 when it is missing. |
| `--force` | Replace a `/` handler on `:443` that already proxies another local port. With `--remove`: also delete the admin token file, and — without a receipt — turn off a `:443` handler for `--port` that no wrapper, unit or service of gbrain's corroborates. |
| `--dry-run` | Print the plan and stop (exit 0). Exclusive with `--status`. |
| `--yes` | Skip the consent prompt (required for non-interactive runs). |
| `--json` | One JSON document on stdout: `{ status, receipt, checks: [{name, status, detail}], next_actions, reason?, message? }`; prose goes to stderr. |

`--status` and `--remove` are exclusive with each other. Defaults: port
3131, tailnet-only, `--surface full`, DCR off, service installed whenever a
supervisor exists.

### `--status`

Reads the receipt, re-probes the Tailscale serve/funnel config, the service
state (`launchctl print gui/$(id -u)/com.gbrain.serve` or `systemctl --user
is-active gbrain-serve.service`) and the local and tailnet health endpoints.
Exit 0 when everything verifies, 1 otherwise. A `tailscale serve status` that
cannot be read (non-zero exit, killed, or non-JSON output) is a **failed**
`tailscale.publish` check, never "handler present". A tailnet `/health` that
fails only because this host cannot resolve the name is a `warn`, not
`pending`, and still exits 0 (see `verify.tailnet` above).

**No receipt:** `--status` does not just say "not exposed" — it looks for the
leftovers an interrupted run can leave behind (the wrapper, a
`com.gbrain.serve` / `gbrain-serve.service` unit or live service, a `:443`
handler proxying `--port`, default 3131). Anything found is one `warn` check
per artifact, the recovery command goes into `next_actions`
(`gbrain mcp expose --remove --yes`, plus `--force` when only a handler stands
and nothing else of gbrain's corroborates it), and the exit is 1 with reason
`leftovers_without_receipt` (also under `--json`). Nothing found: "not
exposed", exit 0 — with `--json` exit 2 so scripts can tell.

### `--remove`

Asks for consent (or `--yes`; declining is `pending` / exit 2, nothing
changed), then stops and removes the user service (it probes the supervisor
and removes a `com.gbrain.serve` / `gbrain-serve.service` that exists even
when the receipt says the service was skipped), clears **only gbrain's own**
serve/funnel handler (the one whose proxied port matches the receipt; Funnel
is switched off first when it was on) with
`tailscale serve --https=443 --set-path=/ off` — the `--set-path=/` scopes the
command to gbrain's one mount, so other mounts under `:443` are never touched
and the CLI never falls into its several-mounts prompt — and deletes the
wrapper and receipt. It never runs `tailscale serve reset`, never uninstalls
Tailscale and never logs you out; the Linux operator preference the login step
set stays as well (`sudo tailscale set --operator=` resets it). The admin
token file is kept unless you pass `--force` (a dashboard session may still be
using it). It prints what was left in place. On macOS a `launchctl bootout`
that fails for a reason other than "not loaded" is a `service` **warn** and
"the launchd job (bootout failed)" is named as left in place — check
`launchctl print gui/$(id -u)/com.gbrain.serve`.

If `tailscale serve status` cannot be read, `--remove` **fails closed**: the
`tailscale.publish` check fails with "could not read tailscale serve status;
handler left as is", the receipt and the wrapper are kept so a re-run can
finish the job, and the exit code is 1. The same holds after the `off`
attempt: `--remove` never reports success while gbrain's handler survives.
When the re-read still shows the handler (or cannot be read at all), the
service is already uninstalled but the receipt and the wrapper are kept, the
exit is 1 with reason `handler_not_removed`, and the message tells you to run
`tailscale serve status` and re-run `gbrain mcp expose --remove --yes`.

**No receipt** (an interrupted `gbrain mcp expose` — killed between
`tailscale serve --bg` and the receipt write): `--remove` recovers from what
is on disk. It looks for the wrapper, the launchd plist / systemd unit (or a
loaded service) and a `/` handler on `:443` that proxies to `--port` (default
3131 — pass the port you published with), prints a "Recovering without a
receipt" plan, asks for consent as usual, and removes exactly those artifacts
(Funnel off first when it was on). The handler is turned off only when
something else of gbrain's corroborates it — the wrapper, the unit/plist, or
the supervisor reporting the service — because another tool may proxy `:443`
to the same port; a handler standing alone is reported and left in place
(exit 0) until you pass `--force`. A handler that survives the `off` attempt
is `handler_not_removed` here too (exit 1); the wrapper is kept as the
corroboration the re-run needs. When `tailscale serve status` cannot be read
while the wrapper or the service is there, this path fails closed exactly like
the receipt path: the service (when found) is still stopped and removed, but
the wrapper is **kept** — it is the corroboration the re-run needs — the
`tailscale.publish` check fails with "could not read tailscale serve status;
handler state unknown", and the exit is 1 with reason
`tailscale_serve_status_unreadable`; fix Tailscale and re-run the printed
command to finish. The admin token file is left alone. When nothing of
gbrain's is found the answer stays "not exposed — nothing to remove", exit 0
(reason `not_exposed`; an unreadable serve status is then only a caveat, since
there is nothing to keep and a handler alone would not be touched anyway). A
completed recovery exits 0 with reason `recovered_without_receipt`.

## Grant, connect, verify

The published server accepts the same clients as any `gbrain serve --http`.
Choose the connection method supported by the intended harness before creating
its least-privilege registration. Native OAuth/PKCE and private machine
handoffs are different paths. A cloud/tailnet choice or vendor name does not
select between them.

Run owner actions on the host or in a separately authorized administrator
harness through the running server's API. This uses the existing connection
while a PGLite service holds its lock. The default expose credential file below
is valid for the expose-managed service; substitute the actual receipt path
and configured URL. An ordinary connecting client without owner authority must
hand these actions to that administrator, not request broader OAuth scopes.

### Open the owner panel

```bash
gbrain mcp admin login-link \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --json
```

Deliver the returned single-use link privately without fetching or opening it
to test it. The plain admin URL does not authenticate the browser. During
native OAuth, preserve the exact opaque pending request with
`login-link --oauth-request REQUEST_ID`. The owner then reviews and approves
consent separately. Expired requests or a server restart require restarting
authorization in the native client. See [MCP administration](../mcp/ADMIN.md)
for owner login, client inspection, permission edits, and lifecycle actions.

### Native OAuth/PKCE

Get the exact callback and token authentication method from the native client's
settings or guide. Public PKCE uses `none` and has no secret; confidential PKCE
uses the client's actual `client_secret_post` or `client_secret_basic` method.
Replace `CLIENT_REDIRECT_URI` below with that actual callback, then preview:

```bash
gbrain mcp admin register native-example --redirect-uri 'CLIENT_REDIRECT_URI' \
  --token-endpoint-auth-method none --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --dry-run --json
```

Use `memory-reader` when only reading is requested. Review the result and repeat
without `--dry-run`. Confidential creation uses the actual POST/Basic method
and requires `--credentials-out /absolute/private/oauth-setup.json`; keep that
export private. Registration creates authorization-code and refresh grants
without minting a machine token. Retrieve setup using the returned client ID:

```bash
gbrain mcp admin setup CLIENT_ID --harness generic --flow authorization-code \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token --json
```

Use the actual supported adapter when known; `generic` supplies manual native
settings guidance. Enter the registration's live method, callbacks, and client
metadata in the intended harness. The native client starts OAuth and retains
its PKCE verifier; the owner signs in and approves its consent request. An
`OAuthClientSetup` document is **not** a private machine handoff for
`gbrain connect` or `gbrain mcp verify`. If manual client configuration is not
available, follow that client's guide; do not substitute machine credentials.
DCR remains opt-in, and manual owner registration works with DCR disabled.

### Private machine handoff

For a harness using machine credentials or managed bearer configuration,
preview a scoped grant through the owner API:

```bash
# On the authorized host/admin harness — one grant per client
gbrain mcp grant bot-example --harness grok-bot --profile memory-writer --source default \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /private/bot-example.json --dry-run --json
```

After reviewing it, repeat without `--dry-run`. Then, inside the client's
environment after moving the machine credential file through a private channel:

```bash
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --harness grok-bot \
  --credentials-file /private/bot-example.json --install --root /workspace/gbrain
gbrain mcp verify --client CLIENT_ID --harness grok-bot \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-file /private/bot-example.json --json
```

Profiles (`memory-reader`, `memory-writer`, `coding-agent`, `operator`,
`delegating-agent`, `full`), private handoff, repair and the honest
verification bar are in [hosted harness access](hosted-harness-access.md).
Per-client notes:

- **Grok Bot / Muse** — the runtime lives in the vendor cloud, so publish
  with explicit `--funnel`. Select native OAuth when that is the intended
  connector; the commands above apply to the separate private machine path.
  For that path, Grok Bot's root is `/workspace/gbrain`; Muse needs a verified
  durable root first. See the [Grok Bot](grok-bot.md) and [Muse](muse.md) guides.
- **Claude Desktop** — follow its [current connection guide](../mcp/CLAUDE_DESKTOP.md)
  for the supported native OAuth or local adapter mode. Native settings need
  a native registration, not credentials from a machine grant. Tailnet-only
  is enough when the actual connection runs on your tailnet laptop.
- **Local coding agents on the host** — on a Postgres brain,
  `gbrain bootstrap harness --yes --port 3131` wires Claude Code / Codex /
  opencode to the running server. On a PGLite brain `bootstrap harness`
  refuses to mint while the service holds the database: either mint **before**
  the service runs (`gbrain auth create local-agents --scopes read,write`,
  run ahead of `gbrain mcp expose` or while the service is briefly stopped)
  and pass `gbrain bootstrap harness --yes --port 3131 --token <value>`, or
  grant a scoped client through the running server —
  `gbrain mcp grant <name> --harness <id> --profile memory-writer --source default --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/<name>.json`
  then `gbrain connect http://127.0.0.1:3131/mcp --harness <id> --credentials-file /private/<name>.json --install`
  (MCP wiring only, no per-turn hooks; `http://` is accepted on loopback).
- **Coding agents on another tailnet machine** — for the private machine
  path, use `gbrain connect <url> --harness <id> --credentials-file <private-file> --install`.
  Native OAuth uses the native registration/settings path instead
  ([Claude Code](../mcp/CLAUDE_CODE.md), [Codex](../mcp/CODEX.md)).
- **ChatGPT, Perplexity, Claude Cowork** — cloud connectors: `--funnel`, then
  the client guide ([ChatGPT](../mcp/CHATGPT.md),
  [Perplexity](../mcp/PERPLEXITY.md), [Cowork](../mcp/CLAUDE_COWORK.md)).

### Verify the selected connection

A passing `gbrain mcp verify` checks the private machine handoff's permitted
server access; writable grants also exercise write/readback and cleanup. For
native OAuth, use the intended harness's authenticated MCP connection to read
`gbrain://capabilities` and perform an allowed call. Do not feed the OAuth setup
export to the machine verifier. Registration, configuration delivery, server
probes, and observed native activation remain separate results.

Inspect advertised tool schemas before proposing a memory test. For an
authorized writable grant, use a harmless synthetic fact with provenance and
explicit `visibility: "world"` within the client's source grant. Keep its ID,
observe recall in a fresh conversation, correct it, then withdraw it and check
active recall. Private facts cannot be recalled or withdrawn by these remote
operations; never widen real private content to pass a test. Read-only clients
verify authenticated read access without adding write permission. Keep failed
cleanup visible, and do not promise erasure from history or backups.

Removing the exposure/service does not revoke client registrations or erase
brain data. To end one client's access, follow the distinct preview/revision
flows for token invalidation, revocation, or deletion in
[MCP administration](../mcp/ADMIN.md#invalidate-tokens-revoke-or-delete).

## PGLite brains

PGLite is single-writer. While the service runs, host-side commands that open
the database (`gbrain doctor`, `gbrain import`, `gbrain auth create`, a second
`gbrain serve`) fail fast with `live_serve` — they do not wait. `gbrain sync`
and `gbrain sweep --once` are the exceptions: they delegate into the live
serve automatically. Administer the brain through the running server instead
(`gbrain mcp admin … --admin-token-file`, `gbrain mcp grant … --admin-token-file`,
or an authenticated owner dashboard), or move to
Postgres for concurrent local use ([ENGINES.md](../ENGINES.md)). The success
banner says which engine the receipt recorded.

Local agents on a PGLite host: `gbrain bootstrap harness` refuses to mint
under the live serve. Mint **before** the service runs
(`gbrain auth create local-agents --scopes read,write` — run it ahead of
`gbrain mcp expose`, or stop the service briefly) and pass
`gbrain bootstrap harness --yes --port 3131 --token <value>`; or skip
bootstrap and use the scoped grant path against the loopback URL
(`gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file ~/.gbrain/serve/admin-token`
then `gbrain connect http://127.0.0.1:3131/mcp … --install`). Postgres
brains mint fine while the server runs: `gbrain bootstrap harness --yes --port 3131`.

## Troubleshooting

`gbrain mcp expose --status` re-runs the probes; `--json` names the failing
check. Logs: `~/.gbrain/serve/serve.log` and `serve.err`.

| Symptom / classified error | Fix |
| --- | --- |
| `tailscale_https_not_enabled` (exit 2, `tailscale.identity` pending) — the tailnet has no HTTPS certificates (`CertDomains` empty); nothing was published | Enable **MagicDNS** and **HTTPS Certificates** for your tailnet at https://login.tailscale.com/admin/dns, then run the printed re-run command. |
| `tailscale_funnel_not_enabled` (exit 2, `tailscale.identity` pending) — the node lacks the Funnel capability; nothing was published | Enable the `funnel` node attribute in your tailnet policy at https://login.tailscale.com/admin/acls ([Funnel docs](https://tailscale.com/kb/1223/funnel)), then re-run with `--funnel`. |
| `tailscale_https_not_enabled` / `tailscale_funnel_not_enabled` / `tailscale_needs_login` (exit 1) — the classified kinds: a `tailscale serve status` read or the `tailscale serve` / `funnel` call itself refused after the pre-checks passed | Same fixes as the rows above (for `tailscale_needs_login`: finish the login, macOS via the Tailscale app); the classifier reads the CLI's stderr as a second line of defense. `tailscale_unknown` (exit 1) after 60s means the CLI is waiting on you — run the printed `tailscale serve --bg <port>` by hand to see its prompt. |
| `tailscale_needs_operator` (exit 1) — "Access denied" from `tailscale serve` (or its `status` read) on Linux | `sudo tailscale set --operator=$USER`, then re-run. `expose` runs that `set --operator` itself before its flagless `sudo tailscale up` (a failure there is noted, not fatal); a tailnet joined earlier by other means may not have it. |
| `tailscale_login_pending` (exit 2) — after the login URL, `tailscale status` still is not `Running` | Finish the login in the browser (macOS: open the Tailscale app and sign in), then run the printed re-run command. Nothing was published. |
| `tailscale_login_manual` (exit 2) — "tailscale at <path> is not a system install, so gbrain will not run it with sudo" | The `tailscale` on your `PATH` lives outside the system install locations, and gbrain never hands root to a user-writable binary. If you trust that binary, sign in yourself with the printed command — `sudo <that path> set --operator=$USER && sudo <that path> up`, the full path because sudo's `secure_path` would not find it — then re-run the printed command. |
| `tailscale_receipt_present` (exit 1, `plan` fails) — "This brain is already published on your tailnet at <url>" | You passed `--no-tailscale` while the receipt records a live Serve/Funnel mapping. Run `gbrain mcp expose --remove --yes` first, or re-run without `--no-tailscale`. |
| `tailscale_daemon_not_running` — "failed to connect to local Tailscale service" (exit 2 from the login step, nothing published; exit 1 when a `serve status` read or the publish itself is classified this way) | macOS: `open -a Tailscale`. Linux: `sudo systemctl enable --now tailscaled`. Then re-run. |
| `confirmation_required` / `declined` (exit 2, `consent` pending) | Not a TTY without `--yes`, or you answered no at the prompt. Nothing changed; pass `--yes` once the printed plan is what you want. |
| `invalid_arguments` (exit 1) | An unknown, duplicate, conflicting or malformed flag; the message names it. `gbrain mcp expose --help`. |
| `tailscale_missing` (exit 1, `--no-install`) / `tailscale_unsupported_platform` (exit 1) / `tailscale_install_failed` (exit 1) | Tailscale is not installed and `expose` would not (or could not) install it: run the printed install command, or install from https://tailscale.com/download, sign in, then re-run. |
| `tailscale_no_dns_name` (exit 1, `tailscale.identity` fails) — the node has no MagicDNS name | Enable **MagicDNS** and **HTTPS Certificates** at https://login.tailscale.com/admin/dns, then re-run. Nothing was published. |
| `tailscale_publish_unconfirmed` (exit 1) — `tailscale serve --bg` exited 0 but the re-read does not show the handler (or could not be read) | Run `tailscale serve status` to see what Tailscale holds; `gbrain mcp expose --remove --yes` clears a handler for the port without a receipt (add `--force` when no wrapper or service of gbrain's is on the host yet), then re-run. |
| `service_install_failed` (exit 1) — the supervisor refused the unit | The handler IS published and the receipt written with `service.state: stopped`. Read the error (and `~/.gbrain/serve/serve.err`), fix it, and re-run; or `gbrain mcp expose --remove --yes` to take the handler down. |
| `verify.tailnet: pending` / `tailnet_health_pending` (publish exit 2; `--status` exit 1) | The first certificate for your MagicDNS name is being issued. The handler, the service and the receipt are already in place — `gbrain mcp expose --status` in a minute. Local health `ok` means the server itself is fine. |
| `status_unhealthy` (`--status`, exit 1) — one of the checks failed | The failing check is named (`tailscale.publish`, `service`, `verify.local`); apply its row here and re-run `gbrain mcp expose --yes` to repair. |
| `not_exposed` (`--status` / `--remove` without a receipt and without leftovers; exit 0, `--status --json` exit 2) / `recovered_without_receipt` (`--remove`, exit 0) | Informational: nothing of gbrain's is published on this host, or the receipt-less recovery removed what an interrupted run left behind. |
| `mcp_expose_failed` (exit 1) — an unexpected error | The `internal` check carries the message, and it says whether a handler published by this run was turned off again or left in place (a written receipt is never torn down — `--status` / `--remove --yes`). Re-run; report it if it repeats. |
| `verify.tailnet: warn` — "this host cannot resolve your-machine.your-tailnet.ts.net" (exit 0) | The brain host itself cannot resolve its MagicDNS name, usually because MagicDNS is off on this machine: `tailscale set --accept-dns=true`, then `gbrain mcp expose --status`. Devices that do resolve the name may already reach the server; this is not a certificate wait. |
| Another device cannot resolve `your-machine.your-tailnet.ts.net` | Resolution needs **MagicDNS** on the tailnet (https://login.tailscale.com/admin/dns) and "Use Tailscale DNS settings" turned on in that device's Tailscale client. Reaching the name over HTTPS additionally needs the tailnet's **HTTPS Certificates** toggle on the same page (the `tailscale_https_not_enabled` pre-check catches that on the host). |
| Service not starting (`--status` reports the service stopped) | Read `~/.gbrain/serve/serve.err`. Typical causes: `gbrain` not on `PATH` for a login-less shell (the wrapper falls back to `type -P gbrain`; install into `~/.bun/bin` or reinstall), a key missing from `~/.gbrain/env`, or the port already taken. `launchctl print gui/$(id -u)/com.gbrain.serve` / `systemctl --user status gbrain-serve.service` show the supervisor's view. |
| `foreign_listener` — "Something already answers on 127.0.0.1:<port> and no expose receipt claims it. Stop it, pick another --port, or pass --no-service to only publish it. If this is a gbrain server left behind by an interrupted `gbrain mcp expose`, run `gbrain mcp expose --remove --yes` first." | **Anything** listening on `127.0.0.1:<port>` counts as occupied — an accepted TCP connect (a database, a non-HTTP service) as much as a 404 or 500 on `/health` — and no receipt claims that port. Refused during `plan`, before anything is published. Stop it, choose another `--port`, or pass `--no-service` to only publish the server you already run. A gbrain server left behind by an interrupted run is cleaned up by `gbrain mcp expose --remove --yes` (receipt-less recovery, see [`--remove`](#--remove)). |
| `no_brain_config` (exit 1, `plan` fails) — "No brain is configured on this host (gbrain init first), so a service would only crash-loop; pass --no-service to publish a server you run yourself." | This host has no `gbrain` config (or it cannot be read), so `gbrain serve` would have nothing to open and the supervisor would restart it forever. Run `gbrain init` on this host first, then re-run; or pass `--no-service` to only publish a server you start yourself. `--dry-run` still shows the plan. |
| `pglite_lock` warn — "a live process holds this PGLite brain (pid N, …): the service cannot start until it exits" | PGLite is single-writer and a process other than gbrain's own running service holds the lock, so the freshly installed service will crash-loop until it exits. Stop that process (or let it finish), then `gbrain mcp expose --status`; for concurrent local use move to Postgres ([ENGINES.md](../ENGINES.md)). The publish itself still completes. |
| "could not read tailscale serve status" — `tailscale.publish` fails during publish (exit 1, reason `tailscale_<kind>`), `--status` (exit 1) or `--remove` (exit 1, `tailscale_serve_status_unreadable`: with a receipt, receipt and wrapper kept; without one, the service is still removed but the wrapper is kept as the corroboration the re-run needs) | `tailscale serve status --json` exited non-zero, was killed, or printed something that is not JSON. The command fails closed rather than guess: nothing is published over, removed from, or reported about a config it could not read. Run `tailscale serve status --json` by hand and apply the classified fix (operator, daemon, login), then re-run the same command. |
| An interrupted `gbrain mcp expose` (no receipt, but a handler / service / wrapper is left behind) — `gbrain mcp expose --status` reports `leftovers_without_receipt` (exit 1) naming each artifact | Run the command `--status` prints: `gbrain mcp expose --remove --yes` (add `--port N` if you published a non-default port; `--force` when only a handler stands) recovers without a receipt: it removes the service, the wrapper and the `:443` handler proxying that port, and leaves the admin token. A handler with no wrapper, unit or service next to it is left in place until you add `--force`. See [`--remove`](#--remove). |
| `handler_not_removed` (exit 1) — "--remove" stopped with "the tailscale handler for port <port> is still present" (or "could not be confirmed gone") | `tailscale serve --https=443 --set-path=/ off` ran but the re-read still shows gbrain's handler (or the serve status could not be re-read). The service was already uninstalled; the receipt and the wrapper were kept on purpose so the re-run finds everything. Run `tailscale serve status`, fix what it reports (operator, daemon), then `gbrain mcp expose --remove --yes` again. |
| `foreign_serve_config` — "tailscale serve already proxies :443 to <target>. Re-run with --force to take it over, or pick another local port for that service." | A `/` handler on `:443` (a background config, another terminal's foreground `tailscale serve` session, or a raw TCP forward) already points somewhere else. Inspect it with `tailscale serve status` (the suggested next action), move that service, or — for a background handler only — re-run with `--force`; a foreground session must be stopped in its own terminal. |
| `verify.local` warn / `local_health_timeout` (exit 2) | The service was installed but `http://127.0.0.1:<port>/health` did not answer within 20s; `verify.tailnet` is skipped. Read `~/.gbrain/serve/serve.err`, then `gbrain mcp expose --status`. |
| `service: manual` (cloud sandbox, ephemeral container, no user bus) | There is no supervisor to keep the server alive. Run the printed foreground command, or the `nohup ~/.gbrain/serve/gbrain-serve.sh &` line, and re-run `--status`. On Linux without a user bus, `loginctl enable-linger $USER` may enable one. |
| `thin_client` (exit 1) — "run on the brain host" | This install is a thin client; `expose` publishes the machine that holds the database. Run it there. |
| Clients see `needsAuth` while tool calls succeed | Spec discovery, not a failed login — see [DEPLOY.md troubleshooting](../mcp/DEPLOY.md#troubleshooting). |

## Security posture

- **Tailnet-only is the default.** Only devices in your tailnet, subject to
  your Tailscale ACLs, can reach the name at all; every request still needs a
  gbrain OAuth token or bearer.
- **Funnel is public exposure.** Use it only for clients that cannot join
  your tailnet, and give each one its own least-privilege grant (a
  `memory-writer` profile scoped to one source, not `operator`). Revoke the
  client on the host when it should stop. Self-service registration stays
  off unless you pass `--enable-dcr`, and even then every new connection waits
  for your approval in the admin dashboard.
- **Loopback bind.** The server keeps `127.0.0.1`; never pass
  `--bind 0.0.0.0` for this shape. Tailscale is the only way in.
- **No secrets in chat or config.** The admin token lives in a 0600 file the
  wrapper reads at run time; the receipt carries none. Credential handoffs go
  through private files (`--credentials-out`), never pasted into a
  conversation.
- **Removal is scoped.** `--remove` touches only gbrain's own handler (the
  `--set-path=/` mount) and service; your Tailscale login, other serve
  configs and the Linux operator preference the login step set stay as they
  were (`sudo tailscale set --operator=` resets the latter).
- **Keep `GBRAIN_HTTP_TRUST_PROXY` at its default for this shape.** Tailscale
  is a loopback proxy and the default (`loopback`) trusts exactly that hop, so
  every tailnet or Funnel client keeps its own rate-limit bucket; turning
  trust off makes every request look like `127.0.0.1` and collapses the
  per-client limits into one bucket, and a wider setting trusts hops Tailscale
  does not vouch for.

See [SECURITY.md](../../SECURITY.md) for the HTTP server's hardening knobs
(CORS allowlist, trust-proxy, rate limits, body cap).

## Alternatives

**ngrok.** Public tunnel with a fixed domain on the paid tier. Run the server
yourself and point `--public-url` at the ngrok domain:

```bash
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
ngrok http 3131 --url your-brain.ngrok.app
```

ngrok connects to loopback on the same machine, so the default bind is right.
The [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) covers the auth
token and fixed domain; [ALTERNATIVES.md](../mcp/ALTERNATIVES.md) compares
the options.

**Cloud hosts (Fly.io, Railway, your own VM).** For a brain that must answer
while your laptop is closed, run `gbrain serve --http` on the host with a
Postgres engine and a real HTTPS front, and set `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`
through the platform's secret store ([DEPLOY.md](../mcp/DEPLOY.md)). The
owner-administration and native-OAuth/private-machine paths above still apply;
use that host's configured URL and owner credential.

**No Tailscale, no tunnel.** `gbrain mcp expose --no-tailscale` installs the
user service on loopback only. Local agents on the same machine use
`gbrain bootstrap harness --yes --port 3131` on a Postgres brain; on PGLite,
pre-mint before the service runs and pass `--token <value>`, or use the scoped
`gbrain mcp grant … --url http://127.0.0.1:3131/mcp --admin-token-file …` +
`gbrain connect … --install` path (see [PGLite brains](#pglite-brains)).
