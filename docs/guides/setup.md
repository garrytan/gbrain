# Connect an agent with `gbrain setup`

`gbrain setup claude-code` gives Claude Code memory in one command: a brain
(the existing one, or a new keyless local brain), a stdio MCP entry, and the
read-context hooks, verified with the same smoke test `gbrain doctor --only
harness_wiring` runs. It changes only what it records, and `--remove` undoes
exactly that.

**Say to your agent:** *"set up gbrain memory for Claude Code"* — *"preview what gbrain setup would change"* — *"remove the gbrain setup from Claude Code"*. The agent runs `gbrain setup claude-code` (with `--dry-run` or `--remove`).

```bash
bun install -g github:garrytan/gbrain
gbrain setup claude-code --dry-run   # the resolved target and every step; writes nothing
gbrain setup claude-code             # wire and verify
gbrain setup claude-code --remove    # remove only what setup wrote
```

## Target first

Before it writes anything, setup resolves and prints:

| Part | How it is chosen |
|---|---|
| Brain | This install's config (`GBRAIN_HOME`). With none, a new keyless PGLite brain from `gbrain init --pglite --no-embedding`. |
| Source | `--source`, else `GBRAIN_SOURCE`, else unpinned (the server uses the brain's default source). |
| Transport | Local stdio: Claude Code starts `<launcher> serve --surface <surface>`. |
| Launcher | `--gbrain-bin`, else the absolute `gbrain` on `PATH` (GUI-launched hosts inherit no `PATH`, so a bare name is never written). |
| Surface | `--surface`, else `GBRAIN_SURFACE`, else the surface already registered, else `full`. |
| Owner | Who owns the MCP name now: nobody, this setup (its receipt), or the gbrain Claude Code plugin (setup then adds hooks only). |

It refuses with a coded error, before any write, when the target is not safe:
a hosted brain is already connected (`setup_hosted_connection`: setup never
creates a second, local brain), or another owner holds the target
(`setup_owner_conflict`: a live PGLite server it did not register, an entry it
did not write, another install's receipt, or the `bootstrap harness` lane).
Each code's fix is in [setup refusals](repair.md#setup-refusals).

## Three decisions

Setup records three separate decisions in its receipt. Running it again keeps
the recorded answers; a flag changes one.

| Decision | Default | Change it |
|---|---|---|
| Wiring scope | User scope (every Claude Code session), read-context hooks `SessionStart` and `UserPromptSubmit` | `--scope project` (only sessions in this directory), `--no-hooks` (MCP only; `GBRAIN_HOOKS=0` counts as the same opt-out) |
| Automatic capture | Declined: no `Stop` or `SessionEnd` hook, so no transcript capture | `--capture`. An existing `memory.auto_writeback: off` wins over `--capture`. |
| Provider use | Declined: a new brain is keyless, and setup configures no paid provider | `--providers` (a new brain is then created with embeddings) |

Provider keys in the environment do not change these defaults.

## States

Setup reports how far the wiring is proven:

1. `configured`: the MCP entry and hooks are written.
2. `connection-verified`: the registered command answered initialize,
   tools/list and a `recall` (the `harness_wiring` smoke), or the live stdio
   server this registration started holds the brain.
3. `native-pending`: no observed event has shown gbrain context reaching a
   fresh Claude Code session yet. Open a new session (Claude Code reads its
   config at session start) and check that `/mcp` lists gbrain.
4. `native-verified`: reserved for an observed injected event; this release
   never claims it.

## Ownership and removal

Setup owns entries by exact hash, recorded in the connection receipt
`~/.gbrain-connection-claude-code-<name>.json` (the receipt `gbrain connect
--install` uses, with `connection: "local-stdio"`). The write order is
receipt (decisions and pending hashes), brain, MCP entry, hooks, receipt
`installed`; a run interrupted at any step resumes from the receipt without
duplicating an entry. A second run on an unchanged install writes nothing.

`--remove` deletes only entries whose hash it recorded. An entry you edited
after setup wrote it stays where it is and is reported, and a later setup
leaves it alone. The brain, its notes, unrelated MCP servers and hooks stay.
Two installs on one machine (different `GBRAIN_HOME`) each use their own
`--name` and remove only their own entries.

## Harness capability table

The table is data (`src/core/setup/capabilities.ts`, version 1). Push is never
claimed from documentation alone.

| Harness | Transport | Setup | Push |
|---|---|---|---|
| claude-code | local stdio | supported | native-pending |
| codex | local stdio | refusal with [its guide](../mcp/CODEX.md) | native-pending |
| openclaw | local context engine | refusal with [its guide](../mcp/OPENCLAW.md) | native-pending |
| openclaw | thin client | refusal with [its guide](../mcp/OPENCLAW.md) | unsupported |
| hermes | local stdio | refusal with [its guide](../mcp/HERMES.md) | unsupported |

## How setup relates to the other entry points

- `gbrain init`: setup runs `gbrain init --pglite --no-embedding` when no brain
  exists, and nothing when one does.
- `claude mcp add` and `gbrain bootstrap hooks`: setup writes the same stdio
  entry and the same `gbrain hook` commands, without the personal-agent
  workspace, and owns them by hash instead of a marker.
- `gbrain connect <url> --install`: the path for a hosted brain; setup refuses
  rather than replace it.
- `gbrain bootstrap harness`: the path for a shared `gbrain serve --http`; setup
  points to it when a live HTTP server owns the brain.
- `gbrain mcp expose` and `gbrain agent register`: host-side steps that publish
  a brain to other devices or mint scoped clients; setup does not run them.
- `gbrain onboard`: improves an existing brain's content (link and timeline
  coverage, embeddings) after setup has connected it.
