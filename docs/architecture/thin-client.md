# Thin-client routing (remote MCP)

On-demand reference (see CLAUDE.md Reference map). Current behavior + invariants
only; release history lives in `CHANGELOG.md` + git.

`gbrain init --mcp-only` sets up a thin-client install: no local brain content,
just an OAuth client pointing at a remote `gbrain serve --http`. Every operation
surface routes through the remote brain — a thin-client install never opens the
empty local PGLite, so a populated remote brain can't silently return
"No results." Local-only commands refuse with a pinpoint hint instead of
falling through.

Installed thin-client launchers clear inherited brain and source overrides without
adding `--brain host` or pinning the grant's write source onto reads. Unqualified
reads use the host grant's readable sources; explicit `--source` remains subject
to host authorization. Local PGLite launchers retain their host/source binding.
The generic `gbrain call` dispatcher is host-only and refuses before opening a
local engine; use the named CLI command or an authorized MCP tool instead.

**Requester scope:** on a host brain that serves several people (two or more
enabled members, or `access.serves = several`), every remote read op except the
identity and health calls (`src/core/access/requester-scope.ts`) must come from a
connection bound to a member, naming an audience, or attested; a thin client's
unbound OAuth client is refused `requester_scope_required` with a host-side fix
(`gbrain auth rescope --client <id> --member <id>`), after a 14-day grace for
clients older than the brain's `access.serves_since`. The gate runs in
`dispatchToolCall` after access resolves and inside agent jobs; it reads only the
request's config snapshot and the verifier's AuthInfo (`readsUnscoped`,
`createdAt`). `access.requester_scope_enforce false` (hosted) turns it into the
`_meta.access.requester_scope` notice.

**Surface posture:** thin CLI clients use the full MCP surface for remote
command compatibility. Bootstrap pins `--surface starter --advertise verbs`; managed thin CLI grants
for OpenClaw, Grok Bot, and Muse also select `full`. Surface visibility does not
grant authority: profiles, token scopes, operation snapshots, sources, and write
fences still restrict requests. A `memory-writer` thin client gains neither
administration nor delegation from its full surface.

OAuth bootstrap challenges advertise `scope="read write"` without enforcing it
as a literal transport requirement. Existing writer, administrator, and
delegated tokens keep their granted authority. A connection following the hint
receives only what its client row allows (`grantScopes` caps every request to
the row's `scope`), so a read-only row still yields a read-only token. The hint
lists `write` because some authorization_code clients (claude.ai custom
connectors) request exactly the hinted scope and never step up after an
`insufficient_scope` tool error, so a narrower hint would keep their writer rows
read-only.
Discovery excludes `agent`, which DCR cannot grant, while explicit DCR requests
for delegation remain rejected.

**Result rows:** the thin client sends `X-Gbrain-Client: gbrain-remote-cli/<version>`
on every request, so hosts serve it full `search`/`query` rows (renderers and
`--explain` read the ranking diagnostics) while other remote callers get lean
rows. It never sends `fields`, so `mcp.strict_params=reject` hosts of any
version accept its calls. The header is unverified and selects a row shape
only; CLIs that predate it get lean rows unless the host sets
`mcp.result_rows: full`.

Keep general-purpose thin-client OAuth rows at `full` (or NULL). Native MCP
configurations can deliberately use starter/verbs to expose fewer tools. Stdio
serves the server-resolved surface directly, without a client row; per-client
surface ceilings (`effectiveSurfaceForClient`) apply only to OAuth HTTP.

**Writes to a strict source:** a thin client's write is an ordinary remote
journal request. On a source in git-canonical mode (`canonical: git`) the
brain owner's door commits it to Git before the database row commits, and the
receipt names the commit (`outcome.persistence.git_commit`). While the owner
is down the call ends `write_pending` (exit 10) with its request id, and
`gbrain write-request <id>` follows it; nothing is written to the
database first. Design: `docs/designs/GIT_CANONICAL_MEMORY.md`, "Remote and
hosted writes".

Key files (per-file detail lives in each file's `KEY_FILES.md` entry; this doc
carries the routing-seam picture):

- `src/cli.ts` — Routing seam INSIDE the existing op-dispatch path (no
  parallel `src/core/thin-client/` module; routing is a ~80-line conditional
  in `runThinClientRouted`). Detects `isThinClient(cfg)` BEFORE `connectEngine`
  so thin-client installs never open the empty PGLite; `connectEngine` itself
  refuses a host connect on a thin client with no `database_url`, so a command
  without its own route fails with its hint, never "No database URL". localOnly ops on
  thin-client refuse via `refuseThinClient` (with pinpoint hint table
  `THIN_CLIENT_REFUSE_HINTS`, which covers the full DB-bound command surface —
  sync, embed, extract, migrate, enrich, dream, jobs, sources, pages, files,
  eval, code-*, and more). Banner via `printIdentityBannerBestEffort`
  before each routed call (suppressed by `--quiet`, `GBRAIN_NO_BANNER=1`,
  non-TTY default). Exhaustive TS `never` switch on `RemoteMcpError.reason`
  for canned, actionable error messages. Renderer parity: the local-engine
  path runs `JSON.parse(JSON.stringify(result))` so renderers see the same
  shape on both paths (no Date/bigint/Buffer drift between them).
  `applyThinClientSourceScope` maps `--source` / `GBRAIN_SOURCE` /
  `.gbrain-source` onto a declared `source_id` and returns the ambient binding
  it used; an empty array result from an op that declares `all_sources`
  names that binding and the `--all-sources` rerun on stderr.
  `checkHostHonoredParams` fails the command when the host's unknown-parameter
  warning names a scope param the client sent (an older host would otherwise
  answer unscoped); hosts that predate those warnings cannot be detected.
- `src/core/mcp-client.ts` — `callRemoteTool(config, toolName, args, opts)`,
  the transport under the routing seam. All transport errors normalize to
  `RemoteMcpError` via the `toRemoteMcpError` funnel, with a stable
  `RemoteMcpErrorReason` union the dispatcher's `never` switch keys off.
  Full symbol-level detail: the `src/core/mcp-client.ts` entry in
  [`KEY_FILES.md`](./KEY_FILES.md).
- `src/commands/recall.ts` — explicit `--budget-policy` calls bypass the local
  engine in the CLI dispatcher and use the remote recall operation, as do the
  fact-list forms (no `--query`/`--budget-tokens`). An in-process `--query` or
  `--budget-tokens` call without a policy is refused with a hint naming the
  policy flag. The dispatcher reuses the command's parser, so a query value that
  resembles a policy flag does not activate this route. An explicit `--brain` is
  rejected as on the shared thin route. `--source`/`--source-id`, environment and dotfile scope use the
  engine-free resolver; an explicit `default` is forwarded, not dropped.
  The host's declared `recall.source_id` narrows both arms through the existing
  authorization resolver. On a local install, a call without a policy runs locally.
- `src/core/cli-options.ts` — `parseGlobalFlags` supports `--timeout=Ns`
  (accepts `30s`, `2m`, `500ms`, plain ms). Default `null` = per-command
  default (30s for most ops, 180s for `think`). `parseTimeout(s)` exported
  helper.
- `src/core/doctor-remote.ts` — `gbrain remote doctor` includes the
  `oauth_client_scopes_probe` check. Probes the read tier via
  `get_brain_identity` and the admin tier via `get_health`; reports per-tier
  status with pinpoint remediation when admin is missing. `buildScopeCheck`
  + `ScopeProbeResult` exported for test access. Skippable via
  `GBRAIN_DOCTOR_SKIP_SCOPE_PROBE=1` for fixtures that mock /mcp at JSON-RPC
  initialize level only (MCP SDK Client hangs on shape mismatch).
- `src/core/operations.ts` — `get_brain_identity` op (read scope, no params,
  banner-only): cheap counter packet `{version, engine, page_count,
  chunk_count, last_sync_iso}` for the thin-client identity banner. Reuses
  `engine.getStats()`; the banner's 60s client-side TTL bounds frequency to
  ≤1/60s per CLI process.
- `src/commands/{salience,anomalies,graph-query,think}.ts` — Per-command
  thin-client routing branches. These commands bypass the operation-layer
  dispatch in cli.ts (call `engine.foo()` directly), so each gets its own
  `if (isThinClient(cfg)) { callRemoteTool(...) }` branch that maps CLI flags
  to op params. `think` is a special case: the server's `think` op is
  read-scoped for OAuth/MCP and intentionally disables `--save`/`--take` for
  remote callers (the `safeSave`/`safeTake` trust-boundary gate in the `think`
  handler in `operations.ts`); thin-client `think` warns loudly when those
  flags are set.

## stdio bridge

On a thin client, bare `gbrain serve` is a stdio MCP server that relays to
the brain host instead of refusing (#8543). A harness that only speaks stdio
(OpenClaw, a desktop app, a gateway) can then use a remote brain with the
same entry it would use for a local one.

- **What it relays.** `tools/list` returns the host's tool list for the
  stored OAuth client; every `tools/call` goes to the host with that
  client's token, `_meta` included, and comes back unchanged, refusals
  included. The bridge opens no local database, writes no page text, and
  never marks a call as the trusted local CLI. Its client name is
  `gbrain-stdio-bridge`, so the host serves the lean rows and windowed pages
  any remote agent gets.
- **What it accepts.** `--surface`, `--advertise` and `--source-guard` (the
  argv gbrain's plugins register). `--surface` and `--advertise` narrow the
  local listing only; `request_tools {surface}` widens this session locally
  and writes nothing on the host. `serve --http`, `--access` and every other
  host flag still refuse with `requires_local_engine`: the host enforces
  what a client may do, so a restriction belongs on a narrower client
  (`gbrain auth register-client <name> --grant-types client_credentials
  --scopes read`) used from its own `GBRAIN_HOME`.
- **Failures.** A transport failure becomes the v1 agent envelope with a
  bounded `recovery` and a `fix` that never adds a scope. A write that may
  have reached the host keeps its `request_id` with
  `submission_status: "unknown"` (`write_outcome_unknown`): read the receipt
  with `get_write_request` or `gbrain write-request -- <id>`, or resend with
  the same `request_id`. One HTTP 401 re-mints the token and resends once with
  the same `request_id`. URLs in every envelope and stderr line lose their
  userinfo, query and fragment. An unexpected fault writes a 0600 trace under
  `<GBRAIN_HOME>/.gbrain/bridge-traces/`, answers `internal_error`, and the
  bridge keeps serving.
- **Audience.** A call carrying `_meta.on_behalf_of` is relayed only to a host
  at gbrain 0.60.543.0 or newer, and a read answer must report
  `_meta.access.audience`; otherwise the bridge answers
  `host_upgrade_required` instead of the credential's whole view.
- **Lifecycle.** Same as local stdio serve: signals, the parent watchdog,
  `MCP_STDIO=1` (stdin EOF is not a disconnect), and a stdin-EOF drain whose
  bound is the call timeout (`gbrain --timeout=Ns serve`, default 180 s). A
  write still in flight when the drain expires is logged with its
  `request_id` and the exit code is 1.

Code: `src/mcp/remote-bridge.ts`, `src/mcp/remote-bridge-errors.ts`,
`src/mcp/remote-bridge-args.ts`, `src/mcp/stdio-lifecycle.ts`, and
`forwardRemoteToolCall` in `src/core/mcp-client.ts`.

Cross-modal search files (image query, SSRF-guarded image loading, spend
tracking, multimodal reindex) are indexed per-file in
[`KEY_FILES.md`](./KEY_FILES.md) and described behaviorally in
[`RETRIEVAL.md`](./RETRIEVAL.md) — they are not part of the thin-client
routing seam.
