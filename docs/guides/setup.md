# Connect an agent with `gbrain setup`

`gbrain setup claude-code` and `gbrain setup codex` give Claude Code or Codex
memory in one command: a brain (the existing one, or a new keyless local
brain), a stdio MCP entry, the read-context hooks and a short
[brain-first instruction block](#brain-first-instructions), verified with the same
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
| Transport | Local stdio: the harness starts `<launcher> serve --surface <surface>`, plus `--advertise verbs` on a new registration that chose no surface. |
| Launcher | `--gbrain-bin`, else the absolute `gbrain` on `PATH` (GUI-launched hosts inherit no `PATH`, so a bare name is never written). |
| Surface | `--surface`, else `GBRAIN_SURFACE`, else the surface already registered, else `starter`, listing only the seven memory verbs and `request_tools` (`--advertise verbs`). A chosen surface is listed in full; `--surface full` is the opt-in for every tool; an existing registration keeps its surface and listing. |
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

- `[mcp_servers.<name>]` with `command` (the hook launcher), `args` (`<launcher> serve …`) and
  `env` (`GBRAIN_HOME`, `GBRAIN_SOURCE` when set): Codex starts stdio servers in
  the session's directory, so serve starts through the hook launcher too (#8426);
- one hooks.json group per event, running
  `env GBRAIN_HOOK_LANE=setup … <hook launcher> <launcher> hook session-start|user-prompt --harness codex`
  (the hook launcher, `<gbrain config dir>/hook-launcher/gbrain-hook`, starts
  gbrain from its own directory so the session directory's `bunfig.toml` and
  `.env` never load; SECURITY.md)
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

## A brain that serves several people

A brain serves several people when config `access.serves` is `several`, or when it is
unset and the brain has two or more enabled members (`gbrain access serves` shows which).
One bot reading for all of them with one unbound key pulls one person's notes into
another person's answers, so setup labels each person instead:

```bash
gbrain setup claude-code --serves several --members alice-example,bob-example
# or --members-file people.txt (one id per line)
```

For each person this adds a member (existing ones are kept), a folder rule
`people/<member>/` that only that member reads (repo brain: committed to
`.gbrain/access.yml` through `gbrain git commit-push`; repo-less brain: the
database rule log), and one key bound to that member, written to
`~/.gbrain/member-keys/<member>.key` (mode 0600, never inside a git checkout; the
receipt prints the path, never the key). It sets `access.serves = several` last,
then proves the labels by reading every other member's folder as each member
(`gbrain find people/<other>/ --as <member>`): none may return a page.
The receipt also lists any other `people/<name>/` folder that no rule covers, since
every member reads it, and the run is not OK until it has a rule. It then counts the
other pages no rule or `readable_by` restricts, which every member's key still reads,
by folder, with the commands that label them; `--labelled-only` keeps each member to
the pages labelled for it instead (never the owner). See
[pages every member's key can read](access-designations.md#pages-every-members-key-can-read).
Setup leaves the stdio server unbound: stdio sessions read only pages no rule
restricts, and the harness's instructions keep the one-person scoping lines.
For a Claude Code or Codex install only one person uses, bind that harness alone:
`gbrain setup claude-code --stdio-member <member>` (or `codex`) writes
`serve --stdio-member <member>` into that harness's MCP entry, so its sessions read
as that member, including pages only that member may read. Other harnesses on the
machine, and other machines that open the same brain (PGLite or Postgres), are
unchanged. The member must be enabled (or one of `--members` in the same run).
Re-runs, `gbrain post-upgrade` and doctor fixes keep the entry's member and never
add one; `--no-stdio-member` removes it, also on a brain that serves several
people. Setup refuses `--stdio-member` where OpenClaw or Hermes is installed,
because those harnesses serve several people, and `gbrain serve` refuses to start
with the flag there too: a bot that answers several people runs
`gbrain serve --http` with each member's key. Setup also refuses it when a gbrain
plugin serves the harness, since setup does not write the plugin's launch arguments.
Setup never writes config `mcp.stdio_member`; set by hand, it still binds every
stdio session on the brain that starts without `--stdio-member`.

The preview runs first, and a BLOCKED line (a disabled member, an existing rule on
`people/<member>/` that someone else also reads, a key whose file is gone or holds
another key) stops the whole run with nothing written. Every step is idempotent on
the member id, so a re-run after a failure finishes the rest; a key whose file could
not be written is revoked on the spot. A key whose file is gone is never replaced on
its own: revoke it (`gbrain auth revoke member-<id>`) and run setup again. An
empty roster refuses.
`--serves one` (the default) changes nothing, but on a brain that already serves
several people a plain setup refuses (`setup_serves_several`) rather than write a
connection bound to nobody, unless the harness's entry (`--stdio-member`) or
`mcp.stdio_member` already binds it, and
a brain setup cannot read refuses (`setup_serves_unreadable`).
`gbrain doctor` fails `unlabeled_people_folders` when such a brain has a
`people/<name>/` folder with pages and no rule naming its readers.
`gbrain access serves several --members ...` does the labelling alone (preview, then
`--yes`).

On such a brain every remote read must say whom it reads for. A token, OAuth
client or stdio server bound to no member is refused with
[`requester_scope_required`](write-refusals.md#requester_scope_required) before
any work, and `gbrain auth create` / `register-client` refuse to create one
(`credential_scope_required`). A connection that existed when the brain started
serving several people (config `access.serves_since`, or the upgrade that added
the refusal) keeps reading for 14 days, with `_meta.access.requester_scope` on
every answer naming the date and the fix; `gbrain doctor` fails
`unscoped_shared_reads` and `gbrain post-upgrade` lists each one with its
command. Bind each connection to its person
(`gbrain auth rescope --token <name> --member <id>`). A stdio harness only one
person uses is bound with `gbrain setup claude-code|codex --stdio-member <id>`,
which writes the member into that one harness entry on that machine, on PGLite
or Postgres. For a harness several people talk to, give each person a key over
HTTP instead (`gbrain serve --http` with `gbrain auth create <name> --member <id>`
keys). A brain pinned `access.serves one` never refuses, however many members
it has.
Nothing binds stdio on its own: upgrade, post-upgrade and doctor never write
`mcp.stdio_member`, and `gbrain doctor` fails `shared_stdio_binding` when it is
set on a host where OpenClaw or Hermes is installed and the brain serves several
people (its fix is
`gbrain config unset mcp.stdio_member`). A team that shares everything may
mark one credential `gbrain auth rescope --token <name> --reads-unscoped --yes`
(`--reads-unscoped none` takes it back); every change is recorded in the
`access-reads-unscoped` audit file. Hosted brains keep
`access.requester_scope_enforce false` until their control plane binds each
connection to a member, so they see the notice and no refusal. Writes are not
affected, and a one-person brain sees no change.

## Brain-first instructions

Registering MCP makes the tools available; it does not make agents use them.
Without a line in the harness's own instructions, sessions rarely call the
brain. So setup also writes one short marked block (`<!-- gbrain:brain-first:begin -->`
… `<!-- gbrain:brain-first:end -->`) into the file the harness loads every
session: before answering any turn, search the brain first, read the best hit,
fill gaps with other tools, apply your own access rules (`source_ids` narrows a
search to what the current requester may see), then finish the task. On a brain
that serves several people, once this harness's stdio server is bound to a member,
the access line says instead that the connection reads only what the person asking
may read (see below).

| Harness | File |
|---|---|
| claude-code | `~/.claude/CLAUDE.md` (`--scope project`: `./CLAUDE.local.md`) |
| codex | `$CODEX_HOME/AGENTS.md`, or a non-empty `AGENTS.override.md` (the file Codex loads) |
| opencode | `~/.config/opencode/AGENTS.md` |
| openclaw | `<workspace>/AGENTS.md` (`agents.defaults.workspace`, else `~/.openclaw/workspace`; several agents need `--workspace`) |
| hermes | `$HERMES_HOME/SOUL.md`, after the identity text; never created, since a SOUL.md replaces Hermes's default identity |
| cursor | `./.cursor/rules/gbrain-brain-first.mdc` (an always-applied project rule) |

Text outside the markers is never touched, and a re-run upgrades the block in
place. `--dry-run` previews it, `--no-instructions` (or
`GBRAIN_AGENT_INSTRUCTIONS=0`) removes it and remembers the opt-out,
`--instructions` opts back in, `--instructions-only` manages only the block,
and `--remove` takes it out with the rest. A hand-edited block with damaged
markers is left alone and reported. Clients with no instruction file gbrain can
write (Claude Desktop, ChatGPT, Perplexity, Grok Build, Grok Bot, Muse) get the
block printed to paste. `gbrain connect --install` and
`gbrain bootstrap harness` write the same block beside the connection they
install, and the thin-client `GBRAIN-INSTRUCTIONS.md` starts with it.
`gbrain doctor` (`harness_wiring`) warns when a registered harness's block is
missing, stale or damaged, with a fix that rewrites only the block.

A rule in the system prompt is easy for a model to pass over, so the same rule
also rides each turn where the harness has a per-turn hook: Claude Code and
Codex get it from setup's UserPromptSubmit hook while the block is installed,
OpenClaw from a hook-only plugin (`gbrain-turn-rule`, `before_prompt_build`)
that `gbrain setup openclaw` installs with the openclaw CLI, and Hermes from a
marked, self-contained `pre_llm_call` hook that `gbrain setup hermes` adds to its
config.yaml. Cursor's rule is always applied; opencode reads its AGENTS.md on
every request. QM has no per-turn hook an install can set: its gateway's
`instructions` are per turn but belong to the surface that posts the turn. The
opt-out turns the per-turn rule off with the block.

## Skill loading (opt-in)

GBrain ships step-by-step skills (meeting ingestion, fact-checking, the
bulk-delete gate, filing rules, …). By default no install lane hands them to
the agent. `--skill-loading spring` adds a second marked block
(`<!-- gbrain:skills:begin -->` … `<!-- gbrain:skills:end -->`) right after
the brain-first block in the same file: a compact index of the bundled skills,
one line per skill with its trigger phrases (about 1.5k tokens, capped at
6,144 bytes). The full skill is loaded only when a task matches, with

    <launcher> bundled-skill <name>                 # the SKILL.md, then the files it names
    <launcher> bundled-skill <name> --asset <path>  # one of those files

`gbrain bundled-skill` reads the skills built into gbrain itself: it opens no
brain and needs no MCP server or skill publication, so it works on a thin
client and from a compiled binary. The index names the absolute launcher the
install recorded, so the index and the skills it loads come from the same
gbrain. MCP `get_skill` is unchanged.

| | |
|---|---|
| Select | `--skill-loading off\|spring` on `gbrain setup <harness>` (`resolve` on `setup claude-code\|codex` turns on the per-turn skill resolver instead: [skill-resolver guide](skill-resolver.md#hook-lane-claude-code-and-codex); on `setup openclaw`, `resolve\|shadow` installs the [skill-resolver plugin](skill-resolver.md#openclaw-plugin)), `gbrain connect --install`, `gbrain connect --harness … --install` and `gbrain bootstrap harness`; or `GBRAIN_SKILL_LOADING`. Flag, then env, then the recorded choice, then `off`. |
| Default | `off`: no index is written, and `off` removes one an earlier run wrote. |
| Which skills | Host installs (`setup`, `bootstrap harness`) list all bundled skills; hosted and thin-client connections leave out the host-maintenance ones. |
| Opt out | `--skill-loading off`; `--no-instructions` removes both blocks; `--remove` takes both out and deletes a file only gbrain created once nothing else is in it. On Codex, `--skill-loading off`, `--no-instructions` and `GBRAIN_SKILL_LOADING=off` also strip an index gbrain recorded in the other global instruction file of the same `CODEX_HOME` (`AGENTS.md` or `AGENTS.override.md`) and print it as a second skills line (`paired` in `--json`, in `--dry-run` too), so the index cannot return when the override file goes. |
| After an upgrade | The block records the skill catalog it indexes. `gbrain doctor` (`harness_wiring`) names a stale index and the refresh command (`gbrain setup <harness> --skills-index-only`, which rewrites only the skills block, keeping its recorded file, launcher and skill set). It never warns on a stale index alone, and nothing rewrites the file during an upgrade. |
| Launcher check | Before writing, setup runs `<launcher> bundled-skill --json` and refuses (nothing written, exit 1) when the launcher is not an absolute path, does not run, or serves other skills than the ones indexed. Pass `--gbrain-bin <absolute path>` to name another gbrain. `gbrain doctor` reports an index whose recorded launcher is gone. |
| Claude Code permission | Claude Code asks before each Bash command it has no rule for (and headless runs deny it), so on Claude Code spring also adds one rule, `Bash(<launcher> bundled-skill:*)`, to `~/.claude/settings.json`. gbrain records that it added it and takes it out with the last index that uses it; a rule you had before is left alone. If you delete the rule, gbrain doesn't add it back until you run with `--skill-loading spring` again. |
| Choice record | `~/.gbrain/skill-loading.json` (harness, file, mode, launcher, audience, catalog, and the Claude Code rule and whether gbrain added it). It and the brain-first record (`agent-instructions.json`) share one lock, `~/.gbrain/agent-instructions.lock`, held for each install step, so two installs at once cannot drop each other's entry. An install that cannot take the lock within 10 seconds changes nothing and says why (`ledger_locked` in `--json`); re-run it once the other install finishes. A dry run takes no lock. |

## Harness capability table

The table is data (`src/core/setup/capabilities.ts`, version 2). Push is never
claimed from documentation alone.

| Harness | Transport | Setup | Push |
|---|---|---|---|
| claude-code | local stdio | supported | native-pending |
| codex | local stdio | supported | native-verified: on codex-cli 0.162.1, after a fresh `gbrain setup codex`, the `UserPromptSubmit` hook put a randomized brain item into a fresh native `codex exec` session, which answered it with no tool call (3 of 3 installs); a `--no-hooks` control answered NONE |
| openclaw | local context engine | instruction block; MCP per [its guide](../mcp/OPENCLAW.md) | native-pending |
| openclaw | thin client | instruction block; MCP per [its guide](../mcp/OPENCLAW.md) | unsupported |
| hermes | local stdio | instruction block; MCP per [its guide](../mcp/HERMES.md) | unsupported |

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
