# Thin-client routing (remote MCP)

On-demand reference (see CLAUDE.md Reference map). Current behavior + invariants
only; release history lives in `CHANGELOG.md` + git.

`gbrain init --mcp-only` sets up a thin-client install: no local brain content,
just an OAuth client pointing at a remote `gbrain serve --http`. Every operation
surface routes through the remote brain — a thin-client install never opens the
empty local PGLite, so a populated remote brain can't silently return
"No results." Local-only commands refuse with a pinpoint hint instead of
falling through.

**Surface posture:** thin clients stay FULL-surface. The thin-client CLI routes
arbitrary `gbrain <op>` invocations over MCP, so a narrowed per-client surface
(`oauth_clients.surface`, WP4) would break commands the install legitimately
owns — bootstrap pins `--surface full` on its serve registrations and operators
should keep thin-client OAuth rows at `full` (or NULL). The stdio transport has
no client row at all: it serves the server-resolved surface directly, and the
per-client ceiling machinery (`effectiveSurfaceForClient`) applies only to the
OAuth HTTP transport. The starter/verbs narrowing is for agent-harness clients,
not for thin-client installs.

Key files (per-file detail lives in each file's `KEY_FILES.md` entry; this doc
carries the routing-seam picture):

- `src/cli.ts` — Routing seam INSIDE the existing op-dispatch path (no
  parallel `src/core/thin-client/` module; routing is a ~80-line conditional
  in `runThinClientRouted`). Detects `isThinClient(cfg)` BEFORE `connectEngine`
  so thin-client installs never open the empty PGLite. localOnly ops on
  thin-client refuse via `refuseThinClient` (with pinpoint hint table
  `THIN_CLIENT_REFUSE_HINTS`, which covers the full DB-bound command surface —
  sync, embed, extract, migrate, enrich, dream, jobs, sources, pages, files,
  eval, code-*, and more). Banner via `printIdentityBannerBestEffort`
  before each routed call (suppressed by `--quiet`, `GBRAIN_NO_BANNER=1`,
  non-TTY default). Exhaustive TS `never` switch on `RemoteMcpError.reason`
  for canned, actionable error messages. Renderer parity: the local-engine
  path runs `JSON.parse(JSON.stringify(result))` so renderers see the same
  shape on both paths (kills the Date/bigint/Buffer drift class).
- `src/core/mcp-client.ts` — `callRemoteTool(config, toolName, args, opts)`,
  the transport under the routing seam. All transport errors normalize to
  `RemoteMcpError` via the `toRemoteMcpError` funnel, with a stable
  `RemoteMcpErrorReason` union the dispatcher's `never` switch keys off.
  Full symbol-level detail: the `src/core/mcp-client.ts` entry in
  [`KEY_FILES.md`](./KEY_FILES.md).
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

Cross-modal search files (image query, SSRF-guarded image loading, spend
tracking, multimodal reindex) are indexed per-file in
[`KEY_FILES.md`](./KEY_FILES.md) and described behaviorally in
[`RETRIEVAL.md`](./RETRIEVAL.md) — they are not part of the thin-client
routing seam.
