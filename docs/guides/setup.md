# Connect an agent with `gbrain setup`

`gbrain setup claude-code` and `gbrain setup codex` give Claude Code or Codex
memory in one command: a brain (the existing one, or a new keyless local
brain), a stdio MCP entry, and the read-context hooks, verified with the same
smoke test `gbrain doctor --only harness_wiring` runs. Setup changes only what
it records, and `--remove` undoes exactly that.

**Say to your agent:** *"set up gbrain memory for Claude Code"* (or *"for Codex"*) — *"preview what gbrain setup would change"* — *"remove the gbrain setup from Codex"*. The agent runs `gbrain setup claude-code` or `gbrain setup codex` (with `--dry-run` or `--remove`).

```bash
bun install -g github:garrytan/gbrain
gbrain setup codex --dry-run   # the resolved target and every step; writes nothing
gbrain setup codex             # wire and verify (or: gbrain setup claude-code)
gbrain setup codex --remove    # remove only what setup wrote
```

## Target first

Before it writes anything, setup resolves and prints:

| Part | How it is chosen |
|---|---|
| Brain | This install's config (`GBRAIN_HOME`). With none, a new keyless PGLite brain from `gbrain init --pglite --no-embedding`. |
| Source | `--source`, else `GBRAIN_SOURCE`, else unpinned (the server uses the brain's default source). |
| Transport | Local stdio: the harness starts `<launcher> serve --surface <surface>`. |
| Launcher | `--gbrain-bin`, else the absolute `gbrain` on `PATH` (GUI-launched hosts inherit no `PATH`, so a bare name is never written). |
| Surface | `--surface`, else `GBRAIN_SURFACE`, else the surface already registered, else `full`. |
| Owner | Who owns the MCP name now: nobody, this setup (its receipt), or the gbrain Claude Code or Codex plugin (setup then adds hooks only). |

It refuses with a coded error, before any write, when the target is not safe:
a hosted brain is already connected (`setup_hosted_connection`: setup never
creates a second, local brain), or another owner holds the target
(`setup_owner_conflict`: a live PGLite server it did not register, an entry it
did not write, another install's receipt, or the `bootstrap harness` lane;
for Codex also the bootstrap Codex hook lane on an event setup would wire).
Each code's fix is in [setup refusals](repair.md#setup-refusals).

## Three decisions

Setup records three separate decisions in its receipt. Running it again keeps
the recorded answers; a flag changes one.

| Decision | Default | Change it |
|---|---|---|
| Wiring scope | User scope (every session), read-context hooks `SessionStart` and `UserPromptSubmit` | `--scope project` (Claude Code only: sessions in this directory), `--no-hooks` (MCP only; `GBRAIN_HOOKS=0` counts as the same opt-out) |
| Automatic capture | Declined: no capture hook (Claude Code `Stop` and `SessionEnd`, Codex `SessionEnd`), so no transcript capture | `--capture`. An existing `memory.auto_writeback: off` wins over `--capture`. |
| Provider use | Declined: a new brain is keyless, and setup configures no paid provider | `--providers` (a new brain is then created with embeddings) |

Provider keys in the environment do not change these defaults.

### Provider use declined

A declined provider decision holds even when provider keys sit in the
environment: gbrain sends no request to a model provider it was not asked to
use. OpenAI model discovery (`GET /v1/models`, which otherwise runs only before
the first OpenAI-routed call) is skipped,
and `gbrain doctor --probe` does not probe the embedding provider. `gbrain
doctor` reports the decision as `provider_consent` ("skipped by consent").
Only the user changes it: `gbrain setup claude-code --providers` records
provider use as accepted for this install. A decline in any of this install's
setup receipts wins.

## First-run settings

When setup creates the brain, it prints init's first-run settings once, after
the wiring and its check (an `[AGENT]` block at the end of the output, or
`notices` in `--json`): the search mode init applied, with the cost matrix,
and automatic saving (`memory.auto_writeback`, off until the user turns it
on). Setup leaves out init's wiring question and its copy-paste quickstart,
because it has just done both. Memory works without an answer, so the agent
relays these settings in the reply that reports the install, as the settings
in effect and how to change them, and applies a choice whenever the user makes
one. Automatic saving is separate from the capture decision above; while
unanswered it comes back in a later session until the user answers or mutes
it.

## States

Setup reports how far the wiring is proven:

1. `configured`: the MCP entry and hooks are written.
2. `connection-verified`: the registered command answered initialize,
   tools/list and a `recall` (the `harness_wiring` smoke), or the live stdio
   server this registration started holds the brain.
3. `native-pending`: no observed event has shown gbrain context reaching a
   fresh session of this harness yet. Open a new session (the harness reads
   its config at session start) and check that `/mcp` lists gbrain.

In a new Claude Code session (SessionStart `startup` or `resume`) the
SessionStart hook waits up to 4 seconds for the stdio serve Claude Code starts
alongside it, then prints the context pack (recent world-visible facts; private
facts are never pushed). Without the wait a fresh session got nothing, because
the serve binds its socket about 2 seconds after spawn.
4. `native-verified`: the capability table records an observed push for the
   harness, and setup wired and trusted that event. Codex reaches it when
   setup owns the trusted `UserPromptSubmit` hook (observed on codex-cli
   0.162.1, see the table below); Claude Code stays `native-pending`.

## Ownership and removal

Setup owns entries by exact hash, recorded in the connection receipt
`~/.gbrain-connection-claude-code-<name>.json` (the receipt `gbrain connect
--install` uses, with `connection: "local-stdio"`). The write order is
receipt (decisions and pending hashes), brain, MCP entry, hooks, receipt
`installed`; a run interrupted at any step resumes from the receipt without
duplicating an entry. A second run on an unchanged install writes nothing.

### Codex

Codex keeps its MCP table and the hook trust entries in
`$CODEX_HOME/config.toml` and the hooks in `$CODEX_HOME/hooks.json`; a user hook
runs only when config.toml carries a `[hooks.state."<hooks.json>:<event>:<index>:0"]`
table with its `trusted_hash`, otherwise Codex lists it and silently skips it.
`gbrain setup codex` writes:

- `[mcp_servers.<name>]` with `command`, `args` and `env` (`GBRAIN_HOME`,
  `GBRAIN_SOURCE` when set);
- one hooks.json group per event, running
  `env GBRAIN_HOOK_LANE=setup … <launcher> hook session-start|user-prompt --harness codex`
  (15 s), plus the detached `hook session-end --harness codex` capture command
  (3 s) only after `--capture`;
- one trust table per group.

Each of these entries is owned by its sha256 fingerprint (canonical JSON of the
exact parsed entry), stored per entry in
`$CODEX_HOME/.gbrain-connection-codex-<name>.json` (`setup_receipt_version: 2`:
the version 1 fields plus `hooks_path` and the per-event `trust` map). The write
order is: receipt `prepared` (the three decisions and pending fingerprints,
before anything else), brain, MCP table, hooks.json groups (inert until
trusted), trust tables (activation, last), receipt `installed`. `--remove` runs
it backwards: trust, hooks, MCP table, receipt. A crash at any point resumes
from the receipt without a duplicate, and a hook that is not yet trusted never
runs.

The trust key carries the group's index. When a group is inserted before
setup's (or setup's group moves), the next run removes setup's stale trust table
and trusts the group at its new index; trust entries setup did not write are
never touched. Removing setup's groups shifts groups that sat after them, so
Codex treats their trust entries as stale; setup prints a note, and running
setup again for another install re-trusts its own groups.

`--remove` deletes only entries whose hash it recorded. An entry you edited
after setup wrote it stays where it is and is reported, and a later setup
leaves it alone. The brain, its notes, unrelated MCP servers and hooks stay.
Two installs on one machine (different `GBRAIN_HOME`) each use their own
`--name` and remove only their own entries.

## Harness capability table

The table is data (`src/core/setup/capabilities.ts`, version 2). Push is never
claimed from documentation alone.

| Harness | Transport | Setup | Push |
|---|---|---|---|
| claude-code | local stdio | supported | native-pending |
| codex | local stdio | supported | native-verified: on codex-cli 0.162.1, after a fresh `gbrain setup codex`, the `UserPromptSubmit` hook put a randomized brain item into a fresh native `codex exec` session, which answered it with no tool call (3 of 3 installs); a `--no-hooks` control answered NONE |
| openclaw | local context engine | refusal with [its guide](../mcp/OPENCLAW.md) | native-pending |
| openclaw | thin client | refusal with [its guide](../mcp/OPENCLAW.md) | unsupported |
| hermes | local stdio | refusal with [its guide](../mcp/HERMES.md) | unsupported |

## How setup relates to the other entry points

- `gbrain init`: setup runs `gbrain init --pglite --no-embedding` when no brain
  exists, and nothing when one does.
- `claude mcp add`, `codex mcp add` and `gbrain bootstrap hooks`: setup writes
  the same stdio entry and the same `gbrain hook` commands, without the
  personal-agent workspace, and owns them by hash instead of a marker.
- `gbrain connect <url> --install`: the path for a hosted brain; setup refuses
  rather than replace it.
- `gbrain bootstrap harness`: the path for a shared `gbrain serve --http`; setup
  points to it when a live HTTP server owns the brain.
- `gbrain mcp expose` and `gbrain agent register`: host-side steps that publish
  a brain to other devices or mint scoped clients; setup does not run them.
- `gbrain onboard`: improves an existing brain's content (link and timeline
  coverage, embeddings) after setup has connected it.
