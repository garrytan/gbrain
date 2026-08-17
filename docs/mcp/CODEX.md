# Connect GBrain to Codex

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

**What ships.** The MCP server runs `gbrain serve --surface starter
--source-guard` through the bundled launcher (`.agents/gbrain-launcher`,
resolution order: `$GBRAIN_BIN` → `~/.bun/bin/gbrain` → `gbrain` on PATH — the
sanctioned install location is preferred over PATH so a stray `gbrain` earlier
on PATH can't shadow it).
`starter` is the daily-driver surface (the seven memory verbs + daily
brain ops) — the curated skills drive everything else through the `gbrain`
CLI. Widen a machine without editing the snapshot: `GBRAIN_SURFACE=full` in
the env that launches Codex (new sessions pick it up), or use the bootstrap
lane below. Unlike the OpenClaw bundle, the plugin ships the host-side skills
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
(the user-global stdio serve binds the source from `GBRAIN_SOURCE`, not a flag); a sole
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
variable. On THIS page's `gbrain connect` path the token lives in your shell
env, not in Codex's config file. The exception is `gbrain bootstrap harness`
(local agent-framework boxes): framework-spawned codex inherits no shell
profile, so that lane writes the token INLINE into a managed, 0600
`[mcp_servers.gbrain]` block in the codex config — stated in its consent
block, removable with `gbrain bootstrap harness --remove`.

## Fastest path: `gbrain connect`

Run anywhere `gbrain` is installed (mint a token on the brain host first):

```bash
gbrain auth create "codex"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --agent codex
```

This prints a copy-paste block. Or wire it up directly and smoke-test the token:

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --agent codex --install
```

`--install` runs `codex mcp add` for you, then makes one real call to the brain so
a wrong/expired token fails right away. Because Codex reads the token from the env
var at runtime, keep `GBRAIN_REMOTE_TOKEN` exported in your shell profile.

## Manual setup

```bash
export GBRAIN_REMOTE_TOKEN=gbrain_xxx
codex mcp add gbrain --url https://YOUR-DOMAIN.ngrok.app/mcp \
  --bearer-token-env-var GBRAIN_REMOTE_TOKEN
```

Codex stores the env-var *name* (`GBRAIN_REMOTE_TOKEN`), not the token itself, and
reads the value when it launches the MCP server. Add the `export` line to your
`~/.zshrc` / `~/.bashrc` so it's set in every session.

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
> [tutorial A1](../tutorials/connect-coding-agent.md#a1-on-the-host-serve-over-http).

## Remove

```bash
codex mcp remove gbrain
```

## Notes

- The token is a long-lived, full-access secret. Keep `GBRAIN_REMOTE_TOKEN` out of
  version control and prefer a scoped token if your host supports one.
- Local stdio also works if you run the brain on the same machine:
  `codex mcp add gbrain -- gbrain serve --surface verbs` — the memory-verb
  protocol ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)); drop the flag
  for the full operation catalog.
- **Ambient recall (Codex has no lifecycle hooks — use the pull path).** At the
  start of a topical thread and after a compaction, call
  `context_pack(entities, budget_tokens)` to warm the standing entities; on a
  periodic wake call `delta(session_id, budget_tokens)` for "what changed since
  my last wake" (deduped per session). Both are zero-LLM, sub-second, world-only
  by default, and on `--surface verbs`. See
  [ambient recall](../guides/ambient-recall.md) for the placement frontier.
