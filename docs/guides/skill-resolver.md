# Skill resolver: the few skills that fit this turn

A harness with hundreds of skills cannot show the model every name and
description on every turn: native listings truncate, and the model then picks
from whatever survived. The skill resolver ranks a catalog of skills against
the user's message and prints a short `<relevant_skills>` block (at most
five suggestions, at most 400 tokens) for the harness to put in front of the
model.

- **Off by default.** Nothing changes until you build a catalog and wire a
  harness to call `gbrain skills resolve`, or turn on the hook lane with
  `gbrain setup <claude-code|codex|hermes> --skill-loading resolve` (OpenClaw and
  Pi: the plugin and extension below; Cursor: pinned skills only, below).
  Setup writes nothing for it otherwise.
- **Words, plus meaning when the brain can embed.** Word matching (BM25F)
  over the catalog's names, descriptions, triggers, routing rows and the first
  4 KB of each body, done on the machine. When the brain has an embedding
  model, Claude Code and Codex turns also rank by meaning with
  [skill vectors](#skill-vectors), which sends each message to that
  embedding provider. With no embedding model and the
  [model picker](#model-picker-opt-in) off, nothing leaves the machine and
  the same message always gets the same block.
- **No brain needed.** It works on a keyless, repo-less or brainless install,
  on a thin client, and while `gbrain serve` holds the PGLite lock. It never
  reads or writes the brain.

## Quick start (no brain needed)

```bash
mkdir -p skills-example/deploy
printf -- '---\nname: deploy\ndescription: Ship a service to production after the tests pass\n---\nRun the tests, then deploy.\n' > skills-example/deploy/SKILL.md
gbrain skills index build --catalog example --dir skills-example
gbrain skills resolve --catalog example --text "deploy the api to production" --harness claude-code
gbrain skills resolve --catalog example --text "deploy the api to production" --json
gbrain skills index status --catalog example
gbrain skills index remove --catalog example
```

## Build a catalog per harness

One catalog per skill set. Names are 1-64 characters of `a-z`, `0-9`, `_` and
`-`. Pass `--harness` so the receipt records which loader the block names.

| Harness | Build | Notes |
|---|---|---|
| Claude Code | `gbrain skills index build --catalog claude-user --dir ~/.claude/skills --harness claude-code` | Plugin skills get their `<plugin>:` prefix from `.claude-plugin/plugin.json`. |
| Claude Code plugins | `gbrain skills index build --catalog claude-code-plugins --claude-plugins ~/.claude --harness claude-code` | The enabled user-scope plugins (`enabledPlugins` in `settings.json`, install paths from `plugins/installed_plugins.json`), each skill as `<plugin>:<skill>`. |
| Codex | `gbrain skills index build --catalog codex-user --dir ~/.codex/skills --harness codex` | Suggestion lines carry the SKILL.md path; Codex opens it. |
| Hermes, qm | `--dir <skills dir> --harness hermes` (or `qm`) | The id is the name the loader takes. |
| Pi, Cursor | `--dir <skills dir> --harness pi` (or `cursor`) | Suggestion lines carry the SKILL.md path; the agent reads the file. For Pi, `gbrain setup pi --skill-loading resolve` builds `pi-user` for you (see below); for Cursor, `gbrain setup cursor --skill-loading resolve` builds the project's `cursor-project-<16 hex>` catalog for pinned skills. |
| OpenClaw | `openclaw skills list --json \| gbrain skills index build --catalog openclaw-main --from-json - --dir <skills dir> --harness openclaw` | The list builds as is: the name is the id, and a skill OpenClaw hides from the model is skipped as ineligible. Each listed skill takes its body, path and triggers from the `--dir` skill of the same name; folder-only skills stay out. |
| Other adapters | `gbrain skills index build --catalog <name> --from-json - --harness <h>` | The adapter pipes its skill list (schema below) and owns rebuilds. |
| gbrain's own skills | `gbrain skills index build --catalog gbrain --bundled` | Rebuilt when the gbrain version changes. |

- `--dir` is repeatable; earlier directories win duplicate ids (the loser is
  listed in the receipt as `duplicate_id`). A symlink that leaves the root
  is followed only when it points at a skill folder (a directory with a
  `SKILL.md`) or at a `SKILL.md` file, the way gstack and other installers
  link skills in from a checkout; the skill is indexed under the link's path.
  Any other symlink that leaves the root (`symlink_outside_root`), skills
  with `disable-model-invocation: true` and JSON entries with
  `eligible: false` are never indexed. Dot-entries (harness-owned state such
  as Codex's `.system/` or Hermes's `.usage.json`) and `node_modules` are
  never read, so a harness writing them does not make the index stale.
- A skill with `deprecated: true` in its SKILL.md frontmatter (a JSON entry:
  `"deprecated": true`) is indexed but never suggested from a word match or
  offered to the model picker. It still loads when the turn names it
  (`use the reports skill`, `/reports`), and its reason then says so; add
  `replaced_by: <skill>` and the reason reads `deprecated, use <skill>
  instead`. It also leaves the trigger index that `gbrain check-resolvable`
  and the routing eval read: its frontmatter triggers and its RESOLVER.md rows
  are dropped, and it is not reported as unreachable.
- `--routing <file>` adds the rows of one RESOLVER-style routing table to
  the skills they name.
- `--scope project` marks a cloned repository's skills: their blocks show ids
  and names only, never their summaries, because the text came from someone else.
- Bounds: 10,000 skills per catalog, 64 KB per SKILL.md, 64 MB of JSON. JSON
  bodies are trimmed to the 4 KB the ranker reads, and a snapshot over 8 MB is
  kept trimmed. An invalid JSON entry fails with `skill_source_invalid`, naming
  the entry and the field.
- Several catalogs merge on one turn: `--catalog user --catalog project`.
  Each ranks with its own variant; the session's no-repeat set and budget are
  shared.

The ranker variant is chosen per catalog: **T** (triggers and routing rows
weighted 3) when at least 25% of skills carry triggers or routing rows, else
**D** (name 2, description 1, body 0.2). A rebuild keeps T until the share
drops below 20%. The constants were frozen on the Step 1 offline eval
(gbrain-evals `docs/benchmarks/2026-11-07-skill-ranker-offline`) and are
recorded in the receipt.

## Hook lane: Claude Code and Codex

`gbrain setup claude-code --skill-loading resolve` (or `codex`) turns on a
per-turn hook that puts the block in front of the model on every prompt:

1. It builds the user catalog `claude-code-user` from `~/.claude/skills` and
   `claude-code-plugins` from the enabled Claude Code plugins (Codex:
   `codex-user` from `~/.agents/skills` and `$CODEX_HOME/skills`). With no
   skill found it stops with `skill_resolver_setup_incomplete` and writes
   nothing else.
2. It sets `skills.resolver.enabled` and `skills.resolver.harnesses` in
   `~/.gbrain/config.json`. A brainless install stays brainless: the file
   holds no engine, so nothing reads it as a brain.
3. It adds the lane's own hook: Claude Code gets UserPromptSubmit and
   SessionStart entries marked `skill-resolver-v1` in `~/.claude/settings.json`;
   Codex gets UserPromptSubmit and SessionStart groups in `hooks.json`
   (`--harness codex`), each trusted in `config.toml`. Both run through the
   existing hook launcher.
4. It prints a sample block and `skill resolver: on; N skills; fresh`.

`--dry-run` lists every write, and re-running changes nothing. A bare
`gbrain setup <harness>` refreshes a lane that is on.

**Hermes**: `gbrain setup hermes --skill-loading resolve` builds `hermes-user`
from `$HERMES_HOME/skills` (nested category folders included) and adds the
lane's `pre_llm_call` entry to gbrain's marked `hooks:` block in
`$HERMES_HOME/config.yaml`, the same block that carries the brain-first turn
rule, approving it in `shell-hooks-allowlist.json`. Each lane owns only its
own entry: `--no-instructions` drops the turn rule and keeps the resolver,
`--skill-loading off` the reverse, and the block goes with its last entry.
Hermes splits the command like a shell would but runs no shell, so it starts
with `/usr/bin/env`:
`/usr/bin/env GBRAIN_HOOK_LANE=skill-resolver <launcher> /abs/path/to/gbrain hook user-prompt --harness hermes`.
When config.yaml already has a `hooks:` section of yours, setup refuses with
the entry to paste under it; once pasted, the next run approves and keeps it.
`--skill-loading off` withdraws that approval but leaves your own section
alone, so delete the pasted entry yourself. A Hermes with no SOUL.md still gets the resolver. `hermes hooks doctor` checks
the entry on the Hermes host, and gbrain's doctor `skill_resolver` check
covers Hermes.

The lane reads `extra.user_message`, `session_id`, `cwd`, `extra.sender_id`,
`extra.is_first_turn` and the length of `extra.conversation_history` from
the hook's stdin and answers `{"context": "<block>"}`. Hermes sends the whole
conversation history on every turn, so the lane streams stdin and keeps only
those fields (each string capped at 8 KB): a history of any size is read,
never refused. Hermes compacts in place, keeping the session id, and tells
hooks nothing, so a first turn, or a history shorter than the last turn saw,
starts the session's dedupe fresh. To show suggestions only on turns from
some senders (a group chat), list them:
`gbrain config set skills.resolver.per_harness.hermes.owner_sender_ids <id>,<id>`;
a turn from anyone else, or with no sender, then gets no block.

Pinned skills for Hermes (`gbrain skills pin add <id> --catalog hermes-user`)
go in a marked block in `$HERMES_HOME/SOUL.md` while the lane is on, so every
turn sees them; with no pins there is no block, and SOUL.md is never created.

The lane runs the resolver in the hook process (never through `gbrain serve`),
so it works with serve down and with no brain. Each block names the skill ids
and gives the harness's own load line; Codex lines also carry the SKILL.md path.
The lane always exits 0 and prints nothing when it cannot deliver:

- **Deadline:** 50 ms for the turn, counted from the moment the ranking
  worker thread has loaded, plus at most 250 ms for that worker to load. A
  cold machine can take most of 50 ms just to load it (measured: up to about
  50 ms on an idle 4-core machine with an empty file cache, and up to about
  105 ms with the CPU oversubscribed), so the turn's own clock starts once it
  is ready. With the [model picker](#model-picker-opt-in) on, the turn also
  gets the picker's wait (`router_timeout_ms`) plus 100 ms; with it off and a
  catalog built with [skill vectors](#skill-vectors), the turn also gets 1
  second for the message's vector plus 100 ms. At either limit
  the process prints nothing, exits and commits no session state.
- **Turn settings:** `skills.resolver.top_k` (1-8, default 5),
  `skills.resolver.min_match` (the weakest `match_strength` to suggest;
  default every match), `skills.resolver.top_gate` (0.6 unless set, 0 turns it off; see
  [the gate](#top_gate-the-no-skill-gate-on-by-default)) and
  `skills.resolver.pinned` (skill ids the harness always loads itself, never
  suggested). `skills.resolver.per_harness.<harness>.top_k`, `.min_match`
  and `.top_gate` override one harness; what it leaves out falls back to the
  global key, and an entry that is not an object counts as unset. Set them with `gbrain config set`; a bad value makes the lane
  log `skill_resolver_config_invalid` and deliver nothing.
- **Extra skill directories:** `gbrain config set
  skills.resolver.per_harness.claude-code.dirs /abs/dir,/abs/other` (or
  `.codex.dirs`; at most 32 absolute paths) adds directories to that
  harness's user catalog. Setup builds the catalog from the default directory
  plus every listed one that exists, records them in the catalog's rebuild
  command (so the auto-rebuild keeps them), and keeps them on every later
  setup run; unset the key and run setup again to drop them.
- **Pins and a session-start note:** at every SessionStart that starts or
  restores a context (`startup`, `resume`, `clear`, `compact`), the lane
  prints the user catalog's [pins](#pinned-skills) (`--catalog
  claude-code-user` or `codex-user`; Codex lines carry the SKILL.md path)
  and then the text in
  `skills.resolver.per_harness.<claude-code|codex>.session_start`, as the
  hook's `additionalContext`. Set the text with `gbrain config set
  skills.resolver.per_harness.claude-code.session_start "<text>"`: plain
  text of at most 600 tokens (about 2,400 characters), no control characters
  but newlines and tabs. Both live in `~/.gbrain/config.json`, so they work
  with no brain and no brain repository. With neither set, SessionStart
  prints nothing. Each part has its own cap, so the block is held to the
  harness's 10,000-character hook output cap rather than
  `lane_payload_chars`. An install from before the SessionStart entry
  (doctor shows its hook `outdated`) needs one setup run first; `gbrain
  skills pin` says so.
- **Session cleanup:** after the dedupe commit the lane runs one session GC
  pass before it exits, at most 64 files and never past the deadline.
- **Payload:** at most `skills.resolver.lane_payload_chars` characters of hook
  output (default 4000, 500 to 10,000); a larger block is dropped whole and
  counted as `payload_dropped`.
- **One owner:** when several settings files wire the lane, only the first
  entry whose home has the lane on delivers.
- **Catalogs:** a turn searches the user catalog, Claude Code's
  `claude-code-plugins` (setup builds it from enabled plugins) and the project
  catalog, each only once it is built. With none built the turn prints nothing
  and logs `no_catalog`.
- **Project skills:** Claude Code's `.claude/skills` in the project gets its
  own catalog, `claude-code-project-<hash of the root>`. Codex's gets
  `codex-project-<hash of the dirs>`, over every `.agents/skills` from the
  project root (the nearest folder above the working directory that holds a
  `.git`, else the working directory) down to the working directory, root
  first, the way Codex 0.165 loads them; your own `~/.agents/skills` stays in
  `codex-user`. Each is built in the background the first time the project is
  seen and merged by name only. Stale catalogs rebuild the same way, at most
  once a minute; `skills.resolver.auto_rebuild false` or
  `GBRAIN_SKILLS_NO_AUTOREBUILD=1` stops both.
- **Compaction:** a SessionStart with `source: compact` (Claude Code, and Codex
  0.165 and later) resets the session, so skills can be offered again, and
  prints the pins and session-start note again. A Codex
  install from before gets the SessionStart group on its next setup run.
  Hermes sends no compaction event; the lane resets a session when its history shrinks or on a first turn.

Each turn appends one line (outcome, error code, duration, the worker's load
time as `worker_ms`, catalogs, with the model picker on, `router`: who
answered, the fallback code and the picker's wait, and with skill vectors,
`vectors`: whether the turn ranked with them, the fallback code and the wait
for the message's vector; never turn text) to `skill-index/logs/lane-<UTC date>.jsonl`, one file per day,
kept 14 days and capped at 2 MB a day. `gbrain doctor` (`skill_resolver`, and
`harness_wiring`'s details) reports the hook, each catalog's freshness and
the recent error codes; it says nothing while the resolver is off. A hook from
before the compaction reset (UserPromptSubmit without SessionStart) shows as
`outdated` and warns with its fix, `gbrain setup codex --skill-loading
resolve` (or `claude-code`).

Compiled binaries carry the lane's worker as a second entrypoint
(`bun build --compile src/cli.ts src/core/skills/resolver/hook-worker.ts`); a
binary built without it delivers nothing and logs `skill_resolver_internal`.
The release and `bun run build` also pass `--define GBRAIN_BUILD_COMMIT=<sha>`,
so a compiled binary's build receipts record `gbrain_commit`.

## OpenClaw plugin

OpenClaw runs its turns inside one long-lived gateway, so a per-turn CLI call
is too slow there. `gbrain setup openclaw --skill-loading resolve --gbrain-bin <abs path>`
installs a separate plugin, `gbrain-skill-resolver`, that ranks inside the
gateway's Node process instead:

1. It builds one catalog per agent, `openclaw-<agent>`, from every skill
   folder OpenClaw loads for that agent: the workspace and `.agents/skills`
   folders, managed, Skill Workshop, custodian and bundled skills, and each
   extra dir (`skills.load.extraDirs` and plugin skill folders). When two
   folders hold a skill of the same name, the catalog keeps the copy OpenClaw
   loads. It writes the Node library to `~/.gbrain/lib/<sha256>.mjs`.
2. It writes the plugin to `<openclaw state dir>/gbrain/gbrain-skill-resolver`
   and its state to `~/.gbrain/openclaw-skill-resolver.json` (mode 0600). The
   state names `gbrain_home` (the gbrain home the plugin reads, so another
   tool can check it agrees) and, per agent, the mode, catalog, top_k, floor,
   top_gate when set, pinned block, rollout knobs, the skill folders with
   their OpenClaw source (`skill_roots`; `skill_dirs` lists the same
   folders), each skill's `SKILL.md` path (`skill_files`), and which paths
   the agent's `read` tool may open (`path_reads`: `any`, `workspace`
   under `tools.fs.workspaceOnly` with `workspace_dir`, or `none` in a
   sandbox).
3. It runs `openclaw plugins install --link`, `plugins enable` and
   `config set ...hooks.allowConversationAccess true`, then
   `plugins inspect` and one self-test turn under Node. Anything short of a
   loaded plugin exits 3 with `skill_resolver_plugin_not_installed` and the
   commands still to run; it never reports a partial install as done.

Setup asks OpenClaw which skills each agent's model can use and where each
one lives: the running gateway's `skills.status` first (`openclaw gateway
call skills.status`, about 2 s), and when no gateway answers,
`openclaw skills list --json --agent <id>` plus one `openclaw skills info
--json` for each source whose folder it cannot place (that list carries no
file paths; about 4 s per call). A skill OpenClaw loads from a different folder
than the catalog's copy is never suggested, and setup counts them. A
skill in the agent's directories that OpenClaw hides from it (not eligible on
this host, outside the agent's skill filter, model invocation off) or does not
list at all (cut at load, see `skill_resolver_host_load_cut`) goes into that
agent's `exclude_ids` and is never suggested, and setup names it. If the
command fails on a later run, the skills it hid at the last run it answered
stay hidden, and setup says so; on a first setup, or when it lists none of the
catalog's skills (usually a different workspace), nothing is filtered and
setup says so. Run setup again after you
change which skills an agent can use; `gbrain doctor --only skill_resolver`
asks OpenClaw again (read-only) and warns when the plugin still suggests a
skill OpenClaw now hides or no longer lists; its fix,
`gbrain setup openclaw --skills-index-only`, re-reads that list and rewrites
only the plugin state. A
`--skill-loading` re-run that changes nothing runs no install command for
either plugin when OpenClaw's config already loads, enables and allows it and
its plugin policy (`plugins.enabled`, `allow`, `deny`) lets it load.

The plugin never adds to or edits OpenClaw's own skill list. On each real user
turn (`before_prompt_build`; see [session classes](#session-classes) for the
turns it skips) it ranks the message the user just sent (OpenClaw's `event.prompt`;
`event.messages` holds only earlier turns) and puts up to 3 suggestions with at
least a description match in `appendContext`, and the pinned block for the
turn's session class in `appendSystemContext`. Each suggestion carries its `SKILL.md` path, and the
block tells the model to open it with `read` first and fall back to
`skills_read` by name (through `dispatch_action` when OpenClaw lists
`skills_read` only behind its tool search). That still works with OpenClaw's
skill listing off (`skillsLimits.maxSkillsPromptChars: 0`). When a
suggested skill sits where the agent's `read` cannot reach (outside the
workspace under `tools.fs.workspaceOnly`, or anywhere in a sandbox), the
block leads with `skills_read` instead. A turn whose run OpenClaw already ended (its
`assertActive` check throws) commits nothing toward the session. Ranking runs
in a worker thread with a 50 ms deadline: a miss injects nothing, commits
nothing and is logged as `timeout`; three misses in a row restart the worker.
A retried attempt of the same run (same `runId`, or the same message id when
OpenClaw sends one) resolves nothing new and commits nothing again: it gets
the first attempt's block back when it resends the user's text, and nothing
when it sends other text or its transcript already holds that block, so the
model sees the block once. It is logged as `retry`. It
loads the library only from `~/.gbrain/lib`, owned by the gateway's user, not
writable by others and matching the recorded sha256.

Flipping modes or knobs only rewrites the state file, which the plugin reads
on its next turn, so no OpenClaw command runs and the gateway does not reload:

- `--skill-loading shadow`: rank and log what would have been suggested
  (`would_suggest`), inject nothing. Use it to measure before going live.
- `--agent <id>` (repeatable) or `--all-agents`: which agents; otherwise
  the agents already on, else `main`.
- `--live-fraction <0-1>`: the share of sessions that see suggestions; the
  rest are logged as the control arm.
- `--pins-route system|first_turn`: the owner's pins every turn in the system
  context (default), or once per session as the session-start brief (see
  below). Conversation pins always go in the system context.
- `--owner-sender <id>` (repeatable): only turns from these senders get
  suggestions; others get the pins only. When OpenClaw sends no memory
  audience, a direct session from one of these senders also counts as the
  owner's, and a turn from anyone else on the shared main session (OpenClaw's
  default `session.dmScope: main` puts every DM there) counts as another
  person's DM. Set it when people other than you can message the agent and
  OpenClaw has no memory provider.
- `--suggest-in owner|conversation|owner,conversation`: which session classes
  get suggestions (default both). Pins are unaffected.
- `--skill-loading off`: uninstalls the plugin and removes its files and
  state. Pins stay in config.json.

`skills.resolver.per_harness.openclaw.{top_k,min_match,top_gate}` overrides the
defaults (3, `description` and the resolver's gate); the global `skills.resolver.top_k`,
`min_match` and `top_gate` apply when it is unset, and `skills.resolver.pinned` lists skills
OpenClaw already loads, which are never suggested. The plugin reads these the
way every lane does, so a bad value makes setup refuse with
`skill_resolver_config_invalid` and write nothing; a change takes effect at
the next `gbrain setup openclaw`.

Each turn appends one line (agent, outcome, duration, error code, arm,
suggested ids, the session class and each suggestion's OpenClaw source; never
turn text) to `skill-index/logs/openclaw-<date>.jsonl`, and a `read` line
when the model opens a skill, by `skills_read` or by `read` of its
`SKILL.md` path, directly or through `dispatch_action` (counted once),
marked with whether it was suggested, the tool, the source and the session
class. Each line also says whether OpenClaw sent a memory audience (`audience`:
`host` or `unknown`); a line with `brief: true` delivered the session-start
brief. `gbrain doctor --only
skill_resolver` reports the plugin, the library, the gbrain home, each agent's
catalog, pins, skill listing and read reach and, over the last 24 hours, the
turns, outcomes, how many reads were of suggested skills (also split by
session class and by source) and the deadline-miss rate. An agent with
OpenClaw's listing off reads `listing off, resolver live` while the plugin
suggests for it; a load cut then does not warn when its `read` may open any
path (`path_reads: any`). Above 5% over at least 20 turns
it warns with `skill_resolve_timeout`; keep a rollout in shadow until the rate
is under that on the real host.

### Session classes

Each turn gets a session class, and the class decides what the plugin adds:

| Class | When | Pins | Suggestions | `audience: owner` skills |
|---|---|---|---|---|
| `owner`, `main` | the agent owner's own session | owner pins (or the session-start brief) | yes | yes |
| `direct`, `group`, `channel`, `conversation`, `unknown` | anyone else's DM, a group, a channel, or a session gbrain cannot place | conversation pins | yes | never |
| `relay`, `cron`, `heartbeat`, `webhook`, `internal` | another session's message, a scheduled run, a webhook, a subagent | none | none | never |

The class comes from what OpenClaw resolved for the turn: its trigger and
input provenance first (cron, heartbeat, a webhook's `event` trigger, an
inter-session relay), then its `memoryAudience` (`owner-private` is the
owner; `conversation` is a group, channel or another person's DM). OpenClaw
sends a memory audience only with a native memory provider. Without one, the
class comes from the session key's shape (`agent:<id>:main` is `main`,
`...:direct:<peer>` is `direct` unless the sender is an `--owner-sender`, and
with `--owner-sender` set, `main` from any other sender, or with no sender
id, is `direct` too,
`...:group:<id>` is `group`, `...:cron:...`, `...:relay-<sender>`,
`...:subagent:...` and `hook:...` are silent) and the log line says
`audience: unknown`. Owner pins and owner-only skills never reach a session
that is not the owner's, with or without an audience.

A skill whose `SKILL.md` front matter says `audience: owner` is suggested
and pinned only in the owner's sessions. `owner` is the only defined value;
any other non-empty `audience` (a list, a typo, `true`, a number, a mapping)
is treated as `owner`, and so is an `Audience:` key in another letter case, or
front matter that does not parse or is never closed (no second `---`) but has an
`audience:` line, so a mistake never makes a skill public. A catalog built before gbrain recorded
audiences suggests nothing and pins nothing outside the owner's sessions
until it is rebuilt, which happens on its own after an upgrade.

**The session-start brief.** With `--pins-route first_turn`, the owner's pins
arrive once, on the first turn of each owner session, and again after a
compaction. gbrain records each session by OpenClaw's durable session id in
`~/.gbrain/openclaw-session-briefs.jsonl`, so a gateway restart or a retried
run never repeats the brief; a new session (`/new`, a reset) gets a new one.

## Pi extension

Pi runs extensions inside its own Node process, so the resolver goes there as
an extension instead of a per-turn CLI call.
`gbrain setup pi --skill-loading resolve --gbrain-bin <abs path>`:

1. Builds one catalog, `pi-user`, from the skill directories Pi loads in every
   project: `$PI_CODING_AGENT_DIR/skills` (default `~/.pi/agent/skills`) and
   `~/.agents/skills`. Project skills (`.pi/skills`, a project's
   `.agents/skills`) are not in it.
2. Writes the Node library to `~/.gbrain/lib/<sha256>.mjs` (the same one the
   OpenClaw plugin uses), the state to `~/.gbrain/pi-skill-resolver.json`
   (mode 0600) and the extension to
   `$PI_CODING_AGENT_DIR/extensions/gbrain-skill-resolver/`.
3. Runs one turn through the extension under Node, and, with `pi` on PATH,
   checks that `pi --help` lists the extension's `--gbrain-skill-resolver`
   flag. If it does not, Pi is not loading the extension: setup exits 3 with
   `skill_resolver_plugin_not_installed` (check that `PI_CODING_AGENT_DIR` is
   the same for Pi and for setup).

Before each user run (Pi's `before_agent_start`) the extension sends up to 3
suggestions with at least a description match as one hidden message right
after the prompt, with each skill's SKILL.md path. Pi stores that message in
the session and replays it on later turns, and a skill already suggested in a
session is not suggested again, so each suggestion costs its tokens once.
After a compaction (`session_compact`) the session starts fresh, so skills can
be offered again. Pinned skills go in a system prompt section,
`<gbrain_pinned_skills>`, on every run with the same text, so the prompt
cache keeps working. Runs Pi starts itself (`messageType: custom`) get the pins
but no suggestions. A pinned skill is never suggested, and neither is a skill
Pi does not show the model on that run (not loaded, or
`disable-model-invocation: true`).

Ranking runs in a worker thread. A run waits at most 150 ms while the worker
starts (the first run of a `pi -p` process) and 50 ms after that; a miss sends
nothing and is logged as `timeout`. Measured with Pi 1.5.2 on a 4-core cloud
machine, a cold `pi -p` run waited 70 to 100 ms, and the whole run took about
150 ms longer than with `--no-extensions`. Each run appends one line (outcome,
duration, suggested ids; never the prompt) to
`skill-index/logs/pi-<date>.jsonl`, and `gbrain doctor --only skill_resolver`
reports the extension, the library, the catalog and the last day's runs.

Coverage is partial: Pi started with extensions off (`pi --no-extensions`, or
a program that embeds Pi with `noExtensions`, as QM does) loads no extension,
so those sessions get nothing, and doctor says so. `gbrain skills pin add <id>
--catalog pi-user` updates the pins from Pi's next run. `gbrain setup pi
--skill-loading off` removes the extension and the state; pins stay in
config.json.

## Cursor pinned skills

Cursor gets pinned skills only. No Cursor hook can add text to the model's
request, so there are no per-turn suggestions, and no check on this machine
can see Cursor's request, so this route is unverified. Doctor reports Cursor
as partial: pinned only, no per-turn hook, unverified.

Run `gbrain setup cursor --skill-loading resolve` in the project:

1. Setup builds the project's catalog, `cursor-project-<16 hex>`, from the skill
   directories Cursor loads there: the project's `.agents/skills`,
   `.cursor/skills`, `.claude/skills` and `.codex/skills`, then the same four
   under your home directory. It records the project in
   `~/.gbrain/cursor-skill-pins.json`.
2. Pins come from `gbrain skills pin add <id> --catalog <that catalog>` (setup
   prints the name). A pin the catalog does not hold is left out. With no pins
   there is no rule file.
3. The pins go in their own always-applied rule,
   `.cursor/rules/gbrain-pinned-skills.mdc`, with each skill's SKILL.md path.
   Your own rules and gbrain's brain-first rule are never touched, and a file
   at that path that gbrain did not write is left alone (setup exits 1).
4. Inside a git repository the rule's path goes in the repository's
   `info/exclude` (never `.gitignore`), so it is never committed.

`gbrain skills pin add|remove` rewrites the rule from any directory, and
Cursor applies it from its next request. `gbrain setup cursor --skill-loading
off` in the project removes the rule, its exclude line and the record; pins
stay in config.json. The pins sit beside the skills index that
`--skill-loading spring` writes into the brain-first rule: resolve leaves that
index alone, and spring leaves the pins alone.

## Pinned skills

Pins are the operator's always-on skills for one catalog. gbrain ships none,
and a catalog with no pins gets no pinned block. They differ from
`skills.resolver.pinned`: a pin is shown by gbrain on every turn, while a
`pinned` skill is one the harness already shows, so gbrain only leaves it out.

```bash
gbrain skills pin add deploy-example --catalog openclaw-main --line "Before any production deploy"
gbrain skills pin add house-rules-example --catalog openclaw-main --class owner,conversation
gbrain skills pin list --catalog openclaw-main
gbrain skills pin remove deploy-example --catalog openclaw-main
```

On OpenClaw a pin shows in the owner's own sessions unless `--class` says
otherwise: `--class conversation` for groups, channels and other people's DMs
only, `--class owner,conversation` for both ([session classes](#session-classes)).
Adding a pin again without `--class` (to change its `--line`) keeps its
classes; `--class owner` sets it back to the owner's sessions.
A pin OpenClaw hides from the agent, loads from another folder, or marks
`audience: owner` (in a conversation) is left out of the block, and setup
names it (`skill_resolver_pin_withheld`). After the catalog is rebuilt (a skill
edit, or `gbrain skills index build`), conversations get no pins until the
plugin's background refresh renders them from the new build; the turn log says
`pins_stale: true`, and a refresh that fails is tried again on a later turn.

A pin must name a skill in that catalog (`skill_resolver_pin_unknown`
otherwise), its line is at most 100 characters with no `<` or `>`, a catalog
holds at most 64 pins, and the rendered block is capped at 600 tokens (a pin
that doesn't fit is listed as cut, and the pins after it still render). A pinned skill is never also suggested, except on
Claude Code and Codex, whose pins arrive at session start. Pins live
in config.json under `skills.resolver.pins.<catalog>`, so turning the resolver
off keeps them; an OpenClaw agent uses a change from its next turn, and Claude
Code and Codex (`claude-code-user`, `codex-user`) from their next session
start, through the [hook lane](#hook-lane-claude-code-and-codex).

## Skill vectors

Word matching misses a skill when the message shares no word with it
("can we go live today?" against a skill described as "deploy the service to
production"). Skill vectors find it by meaning: each build turns every
skill's text into one vector with the brain's own embedding model, and each
turn embeds the message with the same model and compares the two.

- **When it is on.** Wherever the brain has an embedding model
  (`embedding_model` in `~/.gbrain/config.json`, the one `gbrain init` set
  for your pages) with its key, for catalogs built for Claude Code or Codex
  (or with no `--harness`) in user scope. There is no separate setting.
  OpenClaw, Pi, Hermes and project catalogs keep word matching only. A brain
  with `embedding_disabled`, or with no embedding model, builds no vectors.
- **What is sent, and to whom.** Each build sends every skill's name,
  description, when-to-use text, triggers and the start of its body (up to
  6,000 characters a skill) to the embedding provider once. Each turn sends
  the user's message. The provider is the one the brain already uses for its
  pages: Voyage, OpenAI or Google, over HTTPS with the brain's key
  (`VOYAGE_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or
  `GEMINI_API_KEY`, or the matching key in `config.json`);
  `OPENAI_BASE_URL` and `GOOGLE_GENERATIVE_AI_BASE_URL` point it at a proxy.
  `gbrain setup claude-code --skill-loading resolve` (and `codex`) says so
  when vectors are on.
- **How it ranks.** The skills whose cosine with the message reaches the
  model's floor (below) join the word ranking, and the two lists are fused by
  rank (reciprocal rank fusion, k = 60, the same fusion the brain's own search
  uses). A skill found only by meaning shows with
  `match_strength: "vector"` and a reason like `meaning: cosine 0.412`, and
  `--explain-target <id>` adds the skill's `vector` cosine and floor.
- **The no-skill gate.** For a catalog with vectors, the floor replaces
  [`top_gate`](#top_gate-the-no-skill-gate-on-by-default): the block is
  empty (`weak_top_match`) unless some skill it would show reaches the floor.
  A skill named in the turn still bypasses it.
- **How long it waits.** At most 1 second for the message's vector with the
  picker off; with the picker on, the picker's own wait covers both, and when
  the picker answers the vector is not waited for. Either way the wait ends
  at least 100 ms before the caller's deadline, so a late timer on a busy
  machine still leaves the word matcher time to answer. With the picker off,
  Claude Code's hook waits at most 1.5 seconds in all and every other harness
  2 seconds; with it on, the picker's own wait sets the limit.
- **When it can't answer.** The turn is the word matcher's, byte for byte,
  and `vectors.fallback.code` in the `--json` output says why (the hook lane
  log has the same code). The codes: `missing_key`, `provider_error`,
  `timeout`, `bad_reply` (a reply of the wrong shape, or an all-zero
  vector), `stale_vectors` (the brain's embedding model or
  width changed since the build), and `not_needed`
  (the picker answered). The build receipt's `vectors` field is either
  `{model, dims, count}` or `{skipped: <code>}`, where the codes add
  `no_embedder`, `embedding_disabled`, `unsupported_provider`,
  `not_this_harness`, `project_scope`, `too_many_skills` (the vectors file,
  header included, would pass 64 MB; checked before any request when
  `embedding_dimensions` is set, else after the first reply) and
  `unmeasured_model`; `not_needed` there means the catalog has no
  skills. A build sends at most 60,000 characters per request.
- **Keeping them current.** A turn marks the catalog stale (`meta.index_stale`)
  when its vectors no longer match the brain: the embedding model or width
  changed, an embedding model or key was added since the build, or the build's
  embedding failed (`provider_error`, `timeout`, `bad_reply`) more than 10
  minutes ago, for at most 3 failed builds in a row (the receipt counts them
  in `vectors.attempts`), since a failed embed may still be billed. With
  auto-rebuild on, the hook lane then rebuilds it, at most
  once a minute. The skills are embedded before the build takes the catalog's
  lock, so a slow provider never holds up another build or `setup`.

**The floors.** A floor is a cosine below which a skill is not shown on
meaning alone. It is set per model, since each model spreads cosines
differently, and a model with no measured floor gets no vectors
(`unmeasured_model`), so it can never make the no-skill rate worse than words
alone. The floors were chosen on the development half of a private routing
benchmark (590 requests that need a skill, 414 that need none; Claude Code
catalog, top 5, `top_gate` 0.6 for words); its held-out half was not read. The
rule: the most requests whose right skill is in the block, among floors that
give no more no-skill requests a block than words alone.

| Embedding model | Floor | Right skill in the block (of 590) | No-skill requests that get a block (of 414) |
|---|---|---|---|
| words only (no vectors) | | 283 (48.0%) | 184 (44.4%) |
| `voyage:voyage-4` | 0.26 | 310 (52.5%) | 165 (39.9%) |
| `voyage:voyage-4-large` | 0.22 | 309 (52.4%) | 148 (35.7%) |
| `voyage:voyage-4-lite` | 0.26 | 311 (52.7%) | 147 (35.5%) |
| `voyage:voyage-3.5` | 0.34 | 287 (48.6%) | 154 (37.2%) |
| `openai:text-embedding-3-large` | 0.26 | 333 (56.4%) | 184 (44.4%) |
| `openai:text-embedding-3-small` | 0.28 | 314 (53.2%) | 182 (44.0%) |
| `google:gemini-embedding-001` | 0.60 | 350 (59.3%) | 75 (18.1%) |
| `google:gemini-embedding-2` | 0.62 | 346 (58.6%) | 120 (29.0%) |

Each floor was measured at the width that benchmark used; a different
`embedding_dimensions` shifts cosines and has not been measured. Requests
written as task lists stayed hard for every method (about 1 in 10 found).

## Model picker (opt-in)

The word matcher finds a skill when the message uses the skill's own words
("look up", "tell me about") and misses when the user just says what they
want. The model picker fixes that: a small, fast model reads your skill list
(each skill's id and description) and picks the skills the message needs, or
none. It is off by default, and nothing changes until you turn it on:

```bash
gbrain config set skills.resolver.router true
```

`gbrain setup claude-code --skill-loading resolve` (and `codex`) prints this
line when a model key is configured.

What it does on each turn:

- **Where it runs.** Only `gbrain skills resolve` and the Claude Code and Codex
  hook lanes can call it. The OpenClaw plugin, the Pi extension and Hermes never
  do, whatever the config says; a library caller does only when it passes
  `router: true`.
- **What it reads.** Every skill while the catalogs hold up to 150, else the top
  40 of the word ranking; when no skill shares a word with the message there,
  it makes no call and the word matcher answers, with no fallback code.
  Descriptions come from `picker.json`, which each build writes beside the
  index (cut at 400 characters). A project catalog's skills are sent by id
  only, as their hints are never shown.
- **What it shows.** Its picks, best first, with `match_strength: "picked"`,
  under the same rules as any suggestion: `exclude`, the `min_match_strength`
  floor, the session's no-repeat rule, pacing and the token budget. `top_gate`
  does not apply to them. When it says the message needs no skill, the block is
  empty (`no_skill_reason: "no_match"`), except for a skill the turn names.
- **When it can't answer.** The turn is the word matcher's, byte for byte, and
  `router.fallback.code` says why (the codes are below). `gbrain doctor` shows
  the last 24 hours of picker turns, fallbacks by code and today's spend.

| Setting | Default | |
|---|---|---|
| `skills.resolver.router` | `false` | turns the picker on |
| `skills.resolver.router_model` | Claude Haiku 5.5 with an Anthropic key, else `openai:gpt-6-luna`, else `google:gemini-3.5-flash-lite` | an `anthropic:`, `openai:` or `google:` model id, or `compat:` (below) |
| `skills.resolver.router_timeout_ms` | 1500 in Claude Code, 2000 elsewhere | the longest a turn waits (200-2500); Claude Code waits at most 2000, inside its 3-second hook limit |
| `skills.resolver.router_max_usd_per_day` | 0.50 | the daily spend cap in USD (0-100; 0 stops every call) |

A larger model picks better but slower. Claude Opus 5.5 and Fable 5.x
can't turn thinking off, so they pick with adaptive thinking at low effort,
and GPT-6.1 Sol and later and the GPT-6.x Astra models reason at low effort:
Opus took about 1.2 seconds at the median, close to Claude Code's 1.5-second
wait, and Fable 5.2 took about 3 seconds in one check, past it. The picker only calls a model
it has a price for (the daily cap needs one); others report `no_pricing`.
For a model OpenAI hosts, use its `openai:` id rather than `compat:`.

**Your own model.** Any model behind an OpenAI-compatible Chat Completions
endpoint can be the picker, a self-hosted or fine-tuned one included: set
`router_model` to `compat:<model id>` and three more settings.

| Setting | |
|---|---|
| `skills.resolver.router_base_url` | the endpoint's base URL up to `/v1`, like `https://models.example.com/v1` (https, or http to localhost only); required |
| `skills.resolver.router_api_key_env` | the name of the environment variable holding its key, like `MY_MODEL_API_KEY`; unset sends no key |
| `skills.resolver.router_usd_per_mtok` | `[input, output]` or `[input, output, cached input]` in USD per million tokens, so the daily cap holds; required (`0,0` for a free one). Without the third value, cached input is charged at the input rate |
| `skills.resolver.router_extra_body` | optional: a JSON object of at most 4,096 bytes added to each request body, like `{"reasoning_effort": "none"}` for a model that should answer without reasoning. It may set only sampling and reasoning controls (`temperature`, `top_p`, `top_k`, `min_p`, `seed`, `presence_penalty`, `frequency_penalty`, `repetition_penalty`, `reasoning_effort`, `thinking`, `chat_template_kwargs`), so it can't add billable input such as tools or lift the output cap the daily spend cap counts on. Its bytes count toward each call's reservation, and it applies to `compat:` models only |
| `skills.resolver.router_prompt_version` | optional: for a model trained on the picker's request, the picker prompt version it was trained on (`prompt_version` in a catalog's `picker.json`). When gbrain moves to a new version the picker turns itself off with `config_invalid` instead of sending the model a request it was not trained on |

```bash
gbrain config set skills.resolver.router_model compat:acme/skill-picker-1
gbrain config set skills.resolver.router_base_url https://models.example.com/v1
gbrain config set skills.resolver.router_api_key_env MY_MODEL_API_KEY
gbrain config set skills.resolver.router_usd_per_mtok 0.1,0.5
gbrain config set skills.resolver.router_extra_body '{"reasoning_effort": "none"}'
```

**Cost and wait.** A turn sends the skill list and the message, about 9,000
tokens for 75 skills, and gets back under 40 tokens. With Haiku 5.5 that is
about $0.0001 a turn once the list is cached and $0.001 the first time; a
typical wait is under a second. Each call is charged to
`skill-index/router-spend.json` at its largest possible cost before it is
made and settled to its real cost after, so a call cut off mid-way still
counts, and a reply that reports no token counts stays at the largest cost.
The cap resets at 00:00 UTC.

**Privacy.** With the picker on, each message and your skills' ids and
descriptions go to the model's provider (Anthropic, OpenAI or Google), over
HTTPS, with your key (with a `compat:` model, to the endpoint you set). A
redirect from that address is refused, so the request goes nowhere else. Keys come from the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY`) or from
`anthropic_api_key`, `openai_api_key` or `google_api_key` in
`~/.gbrain/config.json`; `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and
`GOOGLE_GENERATIVE_AI_BASE_URL` point it at a proxy. The message is sent as
text to route: only skill ids from your catalog are kept from the reply. A
refused request (an HTTP 4xx) from the provider itself is not charged to the
daily cap; through a proxy or a `compat:` endpoint it is, since that endpoint
may bill it.

### router_fallback: timeout

The picker did not answer within `router_timeout_ms`. Occasional timeouts are
normal; many mean a slow provider or network. Raise the wait (at most 2500, or 2000 in Claude Code)
with `gbrain config set skills.resolver.router_timeout_ms 2000`, or pick a
faster model with `skills.resolver.router_model`.

### router_fallback: provider_error

The provider answered with an error, refused, or could not be reached. Check
the key and the provider's status; the turn used the word matcher.

### router_fallback: missing_key

No key for the picker's model. Set the provider's key (see Privacy above), or
set `skills.resolver.router_model` to a model whose key you have. For a
`compat:` model, the variable `router_api_key_env` names is unset.

### router_fallback: daily_cap

Today's spend (UTC) reached `router_max_usd_per_day`; the word matcher answers
until 00:00 UTC. `gbrain doctor` shows the spend and the cap. To raise it:
`gbrain config set skills.resolver.router_max_usd_per_day 1`. A cap below one
call's largest cost refuses every call, even with nothing spent; raising the
cap is the fix.

### router_fallback: parse_failed

The reply was not the JSON the picker asks for. One-off failures are harmless;
if it repeats, the model may not suit the prompt: try the default model.

### router_fallback: no_known_ids

The reply named no skill in your catalog. One-off failures are harmless; if it
repeats, rebuild the catalog (`gbrain skills index build`) so the picker sees
current ids.

### router_fallback: config_invalid

A `skills.resolver.router_*` value is out of range, or
`router_prompt_version` names a version other than the one this gbrain sends.
The turn is not refused: the picker stays off until the value is fixed or unset
(`gbrain config unset skills.resolver.router_timeout_ms`).

### router_fallback: no_pricing

gbrain has no price for `router_model`, so the daily cap could not be
enforced and no call was made. Use a model gbrain prices (the defaults are),
or for a `compat:` model set `skills.resolver.router_usd_per_mtok`.

### router_fallback: ledger_unavailable

The spend ledger (`skill-index/router-spend.json`) could not be locked or
written, so no call was made. Check that the directory is writable; a lock
left by a crashed process clears itself after 2 seconds.

## The contract (schema_version 1)

The JSON Schemas are checked in under `docs/schemas/`:

- `skill-resolver.v1.turn-input.json`: `{message, previous_user_message?,
  session_id?, harness?, top_k (1-8, default 5), exclude? (up to 1,024 ids),
  min_match_strength?, top_gate?, shadow?, expected_catalog_hash?, reset_session?}` for
  `--input-json -` or the library.
- `skill-resolver.v1.turn-output.json`: the `--json` result. Everything outside
  `meta` is byte-identical for the same index, input and session state, except
  on a turn the model picker answered or was asked, which also carries `router`,
  and on a turn whose catalog has [skill vectors](#skill-vectors), which also
  carries `vectors`.
- `skill-resolver.v1.build-input.json`: the `--from-json` catalog,
  `[{id, name, description?, when_to_use?, triggers?, routing?, body?, path?,
  eligible?, disable_model_invocation?, deprecated?, replaced_by?, audience?}]`. With the
  same fields a SKILL.md folder has (`when_to_use`, `disable-model-invocation`,
  `deprecated`, `replaced_by`, `audience`), a JSON build gives
  the same `catalog_hash` and `index_hash` as the folder build.
- `skill-resolver.v1.build-receipt.json`: the build receipt, also saved as
  `receipt.json` beside the index.

Within v1, changes are additive only.

`no_skill` is true only for an acknowledgement from a small multilingual list
(`no_skill_reason: "ack"`) or when no word of the turn is in the catalog
(`"no_match"`; with skill vectors, only when no skill reaches the cosine
floor either). The ranker has no score threshold of its own; `top_gate`
(below) empties the block when the best match is weak. Each suggestion's `match_strength` says how it matched
(`named` in the turn, `picked` by the model picker, else the first of `name`,
`triggers`, `routing`, `description`, then `vector` for a skill found by
meaning alone, then `body`). `min_match_strength` (`--min-match`) filters
candidates: weaker matches are dropped before the cut to `top_k` and the
stronger ones still fill the block, so `description` drops body-only matches.
It is not a gate: in a large catalog some skill almost always matches a
message on its name somewhere in the ranking, so even `name` rarely empties
the block and instead swaps good description hits for weaker name hits. A
skill named in
the turn (`$name`, `@name`, a leading `/name`, "the name skill", or its full
id) ranks first. When the message matches no catalog word (a follow-up such
as "do it again"), `previous_user_message` (`--previous`) is ranked instead.

### top_gate: the no-skill gate, on by default

`top_gate` (`--top-gate`, `skills.resolver.top_gate`) empties the block
when the best skill the block would show (after `exclude`, pinned skills,
`min_match_strength`, session dedupe and pacing) has a score that, divided by its catalog's maximum
idf, `ln(1 + (n - 0.5) / 1.5)` for a catalog of `n` skills, is below the
threshold (0 to 100). With merged catalogs it takes the
highest of those candidates. A skill named in the turn bypasses it. The
division keeps the number comparable across catalog sizes; it does not undo
message length, so long messages still score higher. A catalog with
[skill vectors](#skill-vectors) uses its cosine floor instead.

The default is 0.6; `0` turns the gate off. Without it, a large catalog
almost always has some skill that shares a word with the message, so every
turn got a block, including turns that need no skill. On harness-evals'
public set P (289 labelled requests, the 351-skill public catalog, Codex
index, top 5), each request ranked once with no session:

| Gate | No-skill requests that get a block | Skill requests whose acceptable skill is in the block |
|---|---|---|
| off (before) | 61 of 61 (100%) | 176 of 228 (77.2%) |
| 0.5 | 14 of 61 (23.0%) | 175 of 228 (76.8%) |
| **0.6 (default)** | **7 of 61 (11.5%)** | **174 of 228 (76.3%)** |
| 0.7 | 3 of 61 (4.9%) | 166 of 228 (72.8%) |

0.6 is the lowest setting that keeps the no-skill rate at or under 25% on
the set's dev half (5 of 31, against 8 of 31 at 0.55); on the held-out test
half it gives 2 of 30 no-skill blocks and loses 1 of 113 skill requests.
A threshold that fits one catalog and one kind of turn is not known to fit
another. The [gbrain-evals gate probe](https://github.com/garrytan/gbrain-evals/tree/main/docs/benchmarks/2026-11-07-skill-ranker-offline),
on turns written to break length-based gates (terse skill requests, long
no-skill messages), found no threshold that removed false suggestions there
without hiding many right ones. In ordinary use, one-word requests that match only a skill's body, and catalogs
where many skills share the request's words, score lower and are the first
to lose their block. Set `skills.resolver.top_gate` (or
`per_harness.<harness>.top_gate`) to tune it, or to `0` to turn it off.
`gbrain skills resolve` reads only those two keys, and only when neither
`--top-gate` nor the input's `top_gate` is given. A bad value there exits 1
with `skill_resolver_config_invalid`; under `--fail-open` it prints a warning
on stderr and keeps the default.

An empty block carries `block_reason`: `ack`, `no_match`, `filtered` (every
match was excluded or below `min_match_strength`), `weak_top_match` (the best
skill scored below `top_gate`, or with skill vectors no skill reached the
floor), `deduped` (every match was
already suggested in the session), `paced` (past half the budget and the top
match is not on a name, trigger or routing row), `budget_exhausted`, `shadow`
(the live output of a `--shadow` turn) or `error`. It is null when the block
has a suggestion.

### Exit codes and fail-open

| Result | Exit | stdout |
|---|---|---|
| Suggestions, or `no_skill` | 0 | the block (or the JSON with `--json`) |
| Runtime error (index missing, incompatible, locked, catalog mismatch, timeout) | 1 | nothing, or the JSON with `error` set under `--json`; the code and fix go to stderr |
| Runtime error with `--fail-open` | 0 | empty block, `error` set under `--json` |
| Usage error (no input, bad JSON, unknown flag, bad catalog name) | 2 | nothing; the agent-protocol refusal on stderr |

Hooks pass `--fail-open` so a turn is never blocked. The library throws a
typed `ResolverError`, or returns the same empty result with
`failOpen: true` when called with `{ failOpen: true }`.

## Sessions and the token budget

With `--session <id>` the resolver remembers which skills it suggested:

- a skill already suggested in the session is not suggested again, so later
  turns only add new skills; once more when it later ranks first on a name,
  trigger or routing match at least 10 turns after it was last suggested;
  whenever the turn names it;
- the session's blocks share a budget, `skills.resolver.session_token_budget`
  in `config.json` (default 8,000 tokens; 0 silences the resolver, otherwise
  100-50,000). k drops to 3 once half is spent and to 1 at 80%; after half,
  only a turn whose top result matched on name, triggers or routing spends
  any. When it is spent, `budget_exhausted` is true on every turn (an
  acknowledgement included) and the block is empty,
  except for a skill the turn names, which still gets its line (and its
  tokens still count);
- state is committed only after the block was delivered: the CLI commits
  after writing stdout, the library through `result.commit()`;
- `--reset-session` (`reset_session: true`) on the first turn after a
  compaction starts the session again;
- `--shadow` computes the block without injecting it and keeps its own
  state, so a shadow run records exactly what the live arm would have shown
  (`--shadow-log <file>` appends it).

The key is `sha256(on|shadow, harness, session id)`: the same id under two
harnesses is two sessions, and merged catalogs share one. Session files idle
for 7 days are deleted: after a commit (at most once every 10 minutes per
home, at most 1,000 files a pass, with async I/O after the commit settles;
the hook lane awaits a 64-file pass before it exits), and on each build and
status.

Measured block size at k=5 over the Step 1 test turns on gbrain's own skills:
median 267 tokens (Claude Code), 268 (Hermes), 270 (qm), 334 (Codex) and 339
(OpenClaw, both with paths); the largest was 366. The hard cap is 400.

## Freshness and rebuilds

`resolve` never rebuilds. When the source changed it still answers from the
existing index with `meta.index_stale: true` and writes `stale.stamp` once (a
later stale turn leaves it alone; a `--from-json -` catalog, which only its
adapter rebuilds, never gets one); the rebuild runs from
`gbrain skills index build` (which prints the exact command in
`skills index status`). For a `--dir` or `--claude-plugins` catalog the turn
checks file sizes and mtimes, at most 1,024 per turn and a full sweep at most
once a minute;
`skills index status` re-reads the source and re-hashes the index. A bundled
catalog is stale after a gbrain upgrade; a `--from-json` catalog is never
rebuilt by gbrain: the adapter passes `expected_catalog_hash` and rebuilds
on `skill_catalog_mismatch`. Set `GBRAIN_SKILLS_NO_AUTOREBUILD=1` (or
`skills.resolver.auto_rebuild: false`) to stop stale stamps being written.

Builds take a lease file with an expiry; a crashed build's lease is reclaimed
when it expires, never because its pid looks dead. A remove during a build
wins: nothing is published.

## Privacy and data flow

With no embedding model and the model picker off, nothing leaves the
machine; see [Skill vectors](#skill-vectors) and
[Model picker](#model-picker-opt-in) for what each sends. Everything lives under `$GBRAIN_HOME/.gbrain/skill-index/`
(`~/.gbrain/skill-index/` by default):

| Path | Holds |
|---|---|
| `<catalog>/index.bin`, `receipt.json` | the index and its receipt (receipt written last) |
| `<catalog>/source.json` | the `--from-json` snapshot |
| `<catalog>/vectors.bin` | one vector per skill from the brain's embedding model, with the model and width it was made with; written only when skill vectors are on |
| `<catalog>/picker.json` | each skill's id and description (up to 400 characters), read only by the model picker |
| `router-spend.json`, `router-spend.json.lock` | the model picker's spend today (UTC), in USD; no turn text |
| `<catalog>/fingerprint.json`, `stat-check`, `stale.stamp`, `lock`, `build.log` | freshness, lease and the last build error |
| `sessions/<key>.json` | skill ids and turn counters; never turn text |
| `logs/lane-<date>.jsonl`, `logs/resolver-<date>.log` | one line per lane turn, and scrubbed stack traces of unexpected failures; never turn text; one file per day, kept 14 days |
| `logs/session-gc.stamp` | empty; its mtime is the last session GC |

The block never echoes the user's text. Summaries (each skill's description
cut at 120 characters, the `summary` field) are catalog text, so they are
JSON-quoted inside a block that labels them data, with `<`, `>` and `&`
escaped.

## Turning it off

Stop calling `gbrain skills resolve` from the harness, or set
`skills.resolver.session_token_budget` to 0. For the hook lane,
`gbrain setup <harness> --skill-loading off` (or `setup --remove`) removes the
hook, the config keys, that harness's catalogs and, once no harness is left,
the session state and the lane log. `gbrain skills index remove --catalog <name>`
deletes a catalog; deleting `skill-index/` removes everything.

## Latency

Preregistered bars: a cold turn (index opened again, ranked, one freshness
slice) at p95 10 ms with 1,000 skills and 40 ms with 7,500 skills on 2 vCPUs.
`bun scripts/bench-skill-resolver.ts` runs one discarded warm-up round, then
nine rounds of 100 turns, and judges the median round's p95, so one burst of host stalls on a shared
runner does not decide it; the `Skill resolver bench` workflow enforces it on
pull requests that touch the resolver.

With [skill vectors](#skill-vectors) on, a turn also waits for the
message's vector, so the provider's round trip dominates. Measured through
real hook processes (gbrain's own 76 skills, 60 turns each, one cloud
machine, November 2026):

| Embedding model | Hook p50 | Hook p95 |
|---|---|---|
| none (words only) | 123 ms | 139 ms |
| `voyage:voyage-4`, Claude Code | 284 ms | 328 ms |
| `voyage:voyage-4`, Codex | 286 ms | 345 ms |
| `google:gemini-embedding-001` | 337 ms | 380 ms |
| `openai:text-embedding-3-large` | 795 ms | 904 ms |

A slower provider costs at most the 1-second vector wait before the turn
falls back to words.

## Library

`import { buildSkillIndex, resolveSkills } from 'gbrain/skill-resolver'` for
Bun. Node adapters load one dependency-free ES module built from the same
source as the CLI:

- `gbrain skills library --json` writes it from the installed gbrain to
  `GBRAIN_HOME/lib/gbrain-skill-resolver.mjs` (`--out <file.mjs>` for another
  path) and prints `{path, sha256, bytes, gbrain_version}`. Run it again
  after each upgrade; the module exports `GBRAIN_VERSION` so an adapter can
  see a skew. A compiled binary has no source to build from and refuses with
  `skill_source_unreadable`.
- Each release attaches `gbrain-skill-resolver.mjs` and
  `gbrain-skill-resolver.mjs.sha256` (`sha256sum -c` format), smoke-tested
  under Node before publishing.

The CLI JSON contract stays the primary interface.

```ts
const r = await resolveSkills({ message, session_id, harness: 'codex', min_match_strength: 'description' }, { catalogs: ['codex-user'], failOpen: true });
inject(r.output.block);
await r.commit();
```

`RESOLVER_FEATURES` lists what this build supports beyond the first v1
release (for example `min_match_strength`), so an adapter can check before
it sends a field an older gbrain would refuse.

On an event loop that must not block, commit with async I/O instead:
`if (r.pending) await commitSessionAsync(home, r.pending.key, r.pending.delta)`
(same file, lease and rules as `commit()`).

A host that stays up across turns (`open_catalog` in `RESOLVER_FEATURES`)
opens a warm handle once instead of reopening the index every turn:

```ts
const h = openCatalog(['codex-user'], { failOpen: true });
const r = await h.resolve({ message, session_id, harness: 'codex' });
inject(r.output.block);
await r.commit();
h.close(); // on shutdown
```

The handle keeps each catalog's receipt, term dictionary and settings in
memory and checks once per turn (a stat of `receipt.json`, `index.bin` and
`config.json`) whether a rebuild or a config edit replaced them, reloading
only that catalog. Its results are the same as `resolveSkills` for the same
input, apart from `meta.timing_ms`; a removed catalog refuses the same way.
`h.resolve(input, { explainTarget, now, ... })` takes per-turn options.
At 1,000 skills it took a turn's p50 from 0.39 ms to 0.14 ms when the
freshness sweep had nothing to do.

`await buildSkillIndexOffThread(input, { home })` (`build_off_thread`) runs
`buildSkillIndex` on a worker thread so a build of 100 ms or more doesn't
block the host's event loop. It returns the same receipt and rethrows a
`ResolverError` with its code and fix. It works from Bun and from the Node
bundle, whose own file is the worker's entry, so nothing else ships.

Commits already collect idle session files every 10 minutes; a host that
wants its own schedule calls `await gcSkillSessions({ home })` (`gc_sessions`),
one bounded pass that returns how many files it deleted.

## Error codes

### skill_index_missing

The catalog was never built (or was removed). Build it with
`gbrain skills index build --catalog <name> ...`; `--fail-open` turns proceed
without a block meanwhile.

### skill_index_incompatible

The index or receipt was written by an incompatible gbrain or is corrupt. The
fix is the build command recorded in the receipt; a `--from-json -` catalog
is rebuilt by its adapter.

### skill_catalog_mismatch

`expected_catalog_hash` (`--expect-catalog`) differs from the index: the catalog
was built from another skill list. Nothing was suggested or committed; the
output's `catalog_hash` is the index's own hash. Rebuild from the current list.

### skill_index_locked

Another build holds the catalog's lease. Retry after it finishes; a crashed
holder is reclaimed when its lease expires.

### skill_resolve_timeout

The turn ran past the caller's deadline. Nothing was committed. Check the
catalog size with `gbrain skills index status`.

### skill_index_removed

The catalog was removed while a build ran, or removed and made again under
the same name, so the build published nothing and left the new catalog alone.

### skill_catalog_too_large

A source is over the bounds (10,000 skills, 100,000 directories). Split it into
several catalogs and pass them together.

### skill_source_unreadable

A `--dir` or `--routing` path does not exist or cannot be read, or
`gbrain skills library` ran from a compiled binary, which carries no source to
build the Node library from: download the release's `gbrain-skill-resolver.mjs`
and its `.sha256` instead.

### skill_source_invalid

The `--from-json` catalog or routing file is malformed or over its size bound
(see `docs/schemas/skill-resolver.v1.build-input.json`). Exit 2.

### skill_resolver_config_invalid

`skills.resolver.session_token_budget` is not 0 or 100-50,000, a lane turn
setting (`top_k`, `min_match`, `top_gate`, `pinned`, `per_harness`, including a
`dirs` list that is not absolute paths, or a `session_start` text that is
empty, over 600 tokens or holds control characters, or either key on a
harness other than `claude-code` or `codex`) is out of range, or
GBRAIN_HOME is not an absolute path.

### skill_resolver_config_unreadable

`~/.gbrain/config.json` exists but is not a JSON object gbrain can read (or is
over 1 MB). Setup refuses and writes nothing, the hook lane prints nothing,
and `gbrain config set skills.resolver.*` refuses; gbrain never rewrites the
file. Fix or move it, then run `gbrain setup <harness> --skill-loading resolve`.

### skill_resolver_setup_incomplete

`gbrain setup <harness> --skill-loading resolve` found no model-invocable
skill in the directories it scanned (named in the message), the catalog build
failed, or no absolute gbrain binary was found for the hook. Nothing was
written (an empty catalog is removed). Add a skill there, or pass
`--gbrain-bin`, and run setup again; `--dry-run` shows what it would scan.

### skill_resolver_internal

An unexpected failure; a scrubbed trace was written to
`skill-index/logs/resolver-<UTC date>.log`. Run `gbrain skills index status` and report it
if it repeats.

### skill_catalog_unknown

The catalog name is invalid, or several catalogs exist and none was named.
`gbrain skills index status` lists them. Exit 2.

### skill_resolve_no_input

No message: stdin was a terminal or empty, or neither `--text` nor
`--input-json -` was passed. Exit 2.

### skill_resolve_invalid_input

The turn input is not a valid JSON object for the turn-input schema (an
unknown field, `top_k` outside 1-8, a bad session id). Exit 2.

### skill_resolver_plugin_not_installed

`gbrain setup openclaw` wrote the plugin and its state, but OpenClaw has not
loaded it: no `openclaw` on PATH, an `openclaw` command failed (named in the
message), or `plugins inspect` does not show it loaded. Exit 3. Run the
commands the message lists on the OpenClaw host, restart the gateway, then
`gbrain doctor --only skill_resolver`.

### skill_resolver_host_not_local

The plugin runs inside the gateway and needs this gbrain home, library and
binary on the same machine, but this machine has neither `openclaw` nor an
OpenClaw state directory. Run setup on the OpenClaw host.

### skill_resolver_selftest_failed

The plugin is installed, but one turn through it under Node did not resolve.
The message carries the library or worker code; fix that and run setup again.

### skill_resolver_pin_unknown

A pin names a skill that is not in its catalog. `pin add` refuses and writes
nothing; an existing pin whose skill disappeared is left out of the block.
Check the id with `gbrain skills pin list --catalog <c>`.

### skill_resolver_pin_withheld

A pinned skill is in the catalog, but OpenClaw hides it from the agent's model,
loads a different copy of it, or it is marked `audience: owner` and the pin is
for conversations. It is left out of that block. Fix the skill (or the agent's
skill filter), or remove the pin.

### skill_resolver_library_missing

No `~/.gbrain/lib/<sha256>.mjs` for the sha256 the plugin state names, so
turns proceed without suggestions. Run `gbrain setup openclaw --skills-index-only`.

### skill_resolver_library_mismatch

The library file is outside `~/.gbrain/lib`, not owned by the gateway's user,
writable by group or others, or does not hash to the recorded sha256, so the
plugin refused it. Run `gbrain setup openclaw --skills-index-only` and check
what else writes the gbrain home.

### skill_resolver_library_skew

The installed gbrain is a different version from the library the plugin runs
and a refresh did not fix it; the plugin keeps the last good library and stops
retrying for a day. Run `gbrain setup openclaw --skills-index-only` and read
its error.

### skill_resolver_worker_crash

The plugin's worker thread could not start or crashed. Turns proceed without
suggestions and it restarts with backoff. Report it if it repeats.

### skill_resolver_worker_stuck

The worker missed the deadline three turns in a row and was restarted. A
loaded host misses more often; `gbrain doctor --only skill_resolver` shows the
miss rate.

### skill_resolver_worker_unavailable

The worker is restarting after a crash or a stall, so this turn got no
suggestions. Nothing to do when it is rare.

### skill_resolver_state_missing

The plugin state has no entry for this agent, so the self-test had nothing to
run. Run `gbrain setup openclaw --skill-loading resolve --agent <id>`.

### skill_resolver_host_load_cut

OpenClaw does not list some of the skills in the agent's skill directories (it
caps each root with `skills.limits.maxCandidatesPerRoot` and each source with
`skills.limits.maxSkillsLoadedPerSource`), so `skills_read` could not open
them. An agent with the skill listing off whose `read` may open any path is
not warned: the block names each path. Setup leaves those skills out of the agent's suggestions and names them;
doctor warns when the plugin still suggests one (the limits changed since
setup ran). To get them back, raise those limits in `openclaw.json` or split
the root, then run setup again. gbrain never edits these limits itself.

### skill_resolver_host_hidden

Doctor found skills the plugin still suggests that OpenClaw now hides from the
agent's model (not eligible on this host, outside the agent's skill filter, or
model invocation off). Run `gbrain setup openclaw --skills-index-only` (doctor
prints it): it re-reads OpenClaw's list and stops suggesting them, installing
nothing.
