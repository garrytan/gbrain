# Connect GBrain to Codex

Adding memory to an existing Codex agent preserves its identity and needs no private repository. Use the [memory-only walkthrough](../tutorials/connect-coding-agent.md). Connecting an existing hosted brain? Choose [native OAuth or a private machine handoff](../guides/hosted-harness-access.md). Opening the owner dashboard or managing clients uses [MCP administration](ADMIN.md) with its separate owner credential.

> New to this? The [Give your coding agent a memory](../tutorials/connect-coding-agent.md)
> tutorial walks both paths (local-from-nothing and connect-to-an-existing-brain)
> end to end, plus the brain-first protocol that makes it worth it. This page is
> the connection reference.
>
> Want the **full agent** — identity, memory, schedules, and a private repo as its
> durable body — not just a connection? That's `gbrain bootstrap`: see the paste
> block in the README and [docs/guides/bootstrap.md](../guides/bootstrap.md).

## Install as a Codex plugin (recommended)

gbrain ships as a native Codex plugin — MCP server + a curated brain-first
skill set in two commands:

```bash
codex plugin marketplace add garrytan/gbrain@codex-plugin   # slim dist branch
codex plugin add gbrain@gbrain
```

The `@codex-plugin` ref is the release-published plugin dist (force-advanced
each release, like `latest-stable`). The bare `garrytan/gbrain` form also
works but downloads the full development repo and tracks master tip — use it
only for from-source installs. Refresh a snapshot with
`codex plugin marketplace upgrade`; remove with `codex plugin remove
gbrain@gbrain` + `codex plugin marketplace remove gbrain`.

**Persona variants (Claude-lane only, for now).** The `gbrain-coding` /
`gbrain-daily` curated variants ship in the Claude Code marketplace; the
codex marketplace deliberately stays at the single full plugin until codex's
handling of multi-entry marketplaces gets its observation run (the dist
branch carries the variant trees already, so enabling is a two-line
marketplace edit once verified — TODOS.md follow-up).

**Prerequisites.** The plugin cannot ship the gbrain binary; install it once
(`bun install -g github:garrytan/gbrain#latest-stable` — the npm package
named `gbrain` is unrelated, never `npm install -g gbrain`) and create a
brain (`gbrain init` — zero-config local PGLite by default). The bundled
`setup` skill walks both. With no binary, the plugin's MCP server exits with
that exact install one-liner on stderr; with no brain, it exits with
"No brain configured. Run: gbrain init". Unix (macOS/Linux) only.

**What ships.** The MCP server runs `gbrain serve --surface full
--source-guard` through the bundled launcher (`.agents/gbrain-launcher`,
resolution order: `$GBRAIN_BIN` → `~/.bun/bin/gbrain` → `gbrain` on PATH — the
sanctioned install location is preferred over PATH so a stray `gbrain` earlier
on PATH can't shadow it).
`full` is every operation (the seven memory verbs, page and bulk writes
such as `put_pages`, graph and skill tools), the surface every registration
gbrain writes pins; the curated skills drive host-side work through the
`gbrain` CLI. A harness that caps its tool count can narrow every new session
on this machine with `GBRAIN_SURFACE=starter` (or `verbs`) in the env that
launches Codex, or use the bootstrap lane below. Unlike the OpenClaw bundle, the plugin ships the host-side skills
too (setup, migrate, smoke-test, gbrain-upgrade, schema authoring) — a plugin
user IS the brain host.

**Routing under the plugin lane.** The plugin serve is user-global and runs
with the plugin snapshot as its working directory, so the per-project
`.gbrain-source` / `.gbrain-mount` dotfiles never apply. Route the source
axis with `GBRAIN_SOURCE=<source-id>` in the environment that launches
Codex; route the brain axis with `GBRAIN_BRAIN_ID` (env only — there is no
config default for the brain axis). `--source-guard` makes this fail-closed:
when a brain has more than one source to choose from and no binding, write
and admin operations error with an actionable message until a source is bound
(the user-global stdio serve binds the source from `GBRAIN_SOURCE`, not a flag,
and exits at startup when that value names a source that is missing or
archived); a sole
real source is unambiguous and unaffected, and reads always pass. (Edge case:
a `.gbrain-source` dotfile placed at `$HOME` is an ancestor of the plugin
snapshot dir and would bind every plugin-lane write to it — put source pins
in project directories, not `$HOME`.)

**One owner per name.** Three lanes can each provide a server named
`gbrain`: this plugin, a hand-wired `codex mcp add` (below), and the
`gbrain bootstrap harness` managed block. Keep one. `gbrain bootstrap hooks`
skips its registration when the plugin is enabled (override:
`--mcp-even-if-plugin`), and `gbrain doctor` warns on a real
double-registration. A plugin being ENABLED is a config signal, not a health
signal — if its server isn't working, fix the binary, or remove the plugin.

**Upgrading** has two halves: `codex plugin marketplace upgrade` refreshes
the plugin snapshot (skills + manifests); the `gbrain-upgrade` skill or a
`bun install -g github:garrytan/gbrain#latest-stable` re-run refreshes the
binary the launcher resolves.

## Connect without the plugin

Recent versions of the Codex CLI (`@openai/codex`) support remote
streamable-HTTP MCP servers with a bearer token read from an environment
variable. Where the token lives depends on the path:

| Path | Where the bearer token lives |
| --- | --- |
| `gbrain connect <url> --token <token> --agent codex [--install]` (this page) | Your shell environment (`GBRAIN_REMOTE_TOKEN`); Codex's config stores only the variable name. |
| `gbrain connect <url> --harness codex --credentials-file <handoff> --install` (the [machine handoff](../guides/hosted-harness-access.md)) | **Inline** in a managed, 0600 `[mcp_servers.<name>]` block in `~/.codex/config.toml`. |
| `gbrain bootstrap harness` (local agent-framework boxes) | **Inline** in the same managed block; stated in its consent block, removable with `gbrain bootstrap harness --remove`. |

The inline paths exist because framework-spawned Codex inherits no shell
profile. Anything that reads or prints that config file (support bundles,
config diffs, agents inspecting MCP entries) can see a live token. The
`--harness codex --install` receipt says so: `token_storage: "inline"`,
`config_path`, the `renew_command` that writes a fresh token (with
`--fresh-token`, so it exchanges a new token instead of reinstalling an
unexpired cached one), and `if_exposed`, which lists the
[token invalidation](ADMIN.md#invalidate-tokens-revoke-or-delete) preview and
apply commands for the brain host, then the renew command (a handoff without a
client secret needs a new handoff from the owner instead), then the Codex
reload. When the config file sits in a Git working tree that does not
ignore it, the receipt adds `token_warning`: add the file to that repository's
`.gitignore` or move the config, and follow `if_exposed` if it was already
committed. Rotating a client secret does not invalidate access tokens already
issued, so it is not the fix for an exposed token.

## Fastest path: `gbrain connect`

Use the brain's configured HTTPS endpoint if it already has one. Otherwise,
publish on the brain host with `gbrain mcp expose` (tailnet-only is enough for
your own laptops; [remote MCP guide](../guides/remote-mcp.md)), which prints
`https://your-machine.your-tailnet.ts.net/mcp`. Mint a token on the brain host,
then run `gbrain connect` inside the intended client environment. Substitute
the configured endpoint below for an existing ngrok or cloud-host deployment:

**Say to your agent:** *"use my brain over mcp"* — *"put my brain on tailscale"*.

```bash
gbrain auth create "codex"
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --token gbrain_xxx --agent codex
```

> **PGLite brains:** `gbrain auth create` opens the database, which fails with
> `live_serve` while the expose-managed service holds it. Mint the token
> **before** the service runs (ahead of `gbrain mcp expose`, or while the service
> is stopped briefly), or provision through the running server instead —
> `gbrain mcp grant … --admin-token-file ~/.gbrain/serve/admin-token` or the
> `/admin` dashboard. Postgres brains mint fine while the server runs.

This prints a copy-paste block. Or wire it up directly and smoke-test the token:

```bash
gbrain connect https://your-machine.your-tailnet.ts.net/mcp --token gbrain_xxx --agent codex --install
```

`--install` runs `codex mcp add` for you, then makes one real call to the brain so
a wrong/expired token fails right away. Because Codex reads the token from the env
var at runtime, keep `GBRAIN_REMOTE_TOKEN` exported in your shell profile.

## Manual setup

```bash
export GBRAIN_REMOTE_TOKEN=gbrain_xxx
codex mcp add gbrain --url https://your-machine.your-tailnet.ts.net/mcp \
  --bearer-token-env-var GBRAIN_REMOTE_TOKEN
```

Codex stores the env-var *name* (`GBRAIN_REMOTE_TOKEN`), not the token itself, and
reads the value when it launches the MCP server. Add the `export` line to your
`~/.zshrc` / `~/.bashrc` so it's set in every session.

## Always-loaded core memory

Codex does not put MCP server instructions in the prompt, so core memory
([guide](../guides/core-memory.md)) reaches Codex through its user-global
instruction file:

```bash
gbrain compile-context --target codex-global
```

This writes the default source's core block into a managed block in
`$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`), which Codex loads in
every session. Rerun it after core changes (`gbrain doctor` names a stale copy);
`gbrain compile-context --target codex-global --remove-core` takes it out.

## Verify

In Codex, ask it to use the brain:

```
Call get_brain_identity, then search my brain for [topic].
```

`get_brain_identity` confirms whose brain you're connected to; `list_skills` shows
everything it can do.

> **`list_skills` empty?** It's gated by `mcp.publish_skills` on the host — enable
> it with `gbrain config set mcp.publish_skills true`. The core tools (search,
> query, get_page, put_page, capture, think, find_experts) work regardless —
> prefer `capture` for quick notes (auto-slug + dedupe), `put_page` for
> full-control writes; if a narrowed token's list lacks capture, use `put_page`.
> Why brains differ on the default:
> [tutorial A1](../tutorials/connect-coding-agent.md#a1-on-the-host-grant-memory-access).

## Remove

```bash
codex mcp remove gbrain
```

## Notes

- The token is a long-lived, full-access secret. Keep `GBRAIN_REMOTE_TOKEN` out of
  version control and prefer a scoped token if your host supports one.
- Local stdio also works if you run the brain on the same machine:
  `codex mcp add gbrain -- "$(command -v gbrain)" serve --surface full` — the
  whole operation catalog, memory verbs ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md))
  included, the surface every registration gbrain writes pins. A
  `GBRAIN_SURFACE` value in the Codex server entry's `env` table overrides the
  flag (`starter` or `verbs` for a harness that caps its tool count).
- **PGLite brains are single-process.** PGLite is a single-writer embedded
  Postgres: the first running `gbrain serve` (the plugin's, or a stdio
  registration) owns the brain's data directory via the data-dir lock. A
  second `serve` — say, gbrain registered in a second harness on the same
  machine — or any CLI command that opens the DB fails on the lock while
  that serve is live (`gbrain sync` is the one exception: it delegates to
  the live serve). If multiple processes need the brain at once, run ONE
  shared `gbrain serve --http` and point every client at it (the remote
  paths above), or migrate to the Postgres/Supabase engine, which tolerates
  concurrent connections. Details:
  [serve ↔ sync concurrency](../architecture/serve-sync-concurrency.md).
- **Ambient recall (Codex has no lifecycle hooks — use the pull path).** At the
  start of a topical thread and after a compaction, call
  `context_pack(entities, budget_tokens)` to warm the standing entities; on a
  periodic wake call `delta(session_id, budget_tokens)` for "what changed since
  my last wake" (deduped per session). Both are zero-LLM, sub-second, world-only
  by default, and on every surface, `--surface verbs` included. See
  [ambient recall](../guides/ambient-recall.md) for the placement frontier.
