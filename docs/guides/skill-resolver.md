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
- **Local and deterministic.** Word matching (BM25F) over the catalog's names,
  descriptions, triggers, routing rows and the first 4 KB of each body. No
  network, no model, no clock, no randomness on the turn path.
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
  listed in the receipt as `duplicate_id`). Symlinks that leave the root,
  skills with `disable-model-invocation: true` and JSON entries with
  `eligible: false` are never indexed. Dot-entries (harness-owned state such
  as Codex's `.system/` or Hermes's `.usage.json`) and `node_modules` are
  never read, so a harness writing them does not make the index stale.
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

- **Deadline:** 50 ms from lane start. Ranking runs in a worker thread; at the
  deadline the process prints nothing, exits and commits no session state.
- **Turn settings:** `skills.resolver.top_k` (1-8, default 5),
  `skills.resolver.min_match` (the weakest `match_strength` to suggest;
  default every match), `skills.resolver.top_gate` (off unless set; see
  [the gate](#top_gate-an-experimental-gate-off-by-default)) and
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
  0.165 and later) resets the session, so skills can be offered again. A Codex
  install from before gets the SessionStart group on its next setup run.
  Hermes sends no compaction event; the lane resets a session when its history shrinks or on a first turn.

Each turn appends one line (outcome, error code, duration, catalogs; never
turn text) to `skill-index/logs/lane-<UTC date>.jsonl`, one file per day,
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

1. It builds one catalog per agent, `openclaw-<agent>`, from the skill
   directories OpenClaw loads for that agent, and writes the Node library to
   `~/.gbrain/lib/<sha256>.mjs`.
2. It writes the plugin to `<openclaw state dir>/gbrain/gbrain-skill-resolver`
   and its state to `~/.gbrain/openclaw-skill-resolver.json` (mode 0600: per
   agent the mode, catalog, top_k, floor, pinned block and rollout knobs).
3. It runs `openclaw plugins install --link`, `plugins enable` and
   `config set ...hooks.allowConversationAccess true`, then
   `plugins inspect` and one self-test turn under Node. Anything short of a
   loaded plugin exits 3 with `skill_resolver_plugin_not_installed` and the
   commands still to run; it never reports a partial install as done.

Setup also asks OpenClaw which skills each agent's model can use
(`openclaw skills list --json --agent <id>`, its `modelVisible` field). A
skill in the agent's directories that OpenClaw hides from it (not eligible on
this host, outside the agent's skill filter, model invocation off) or does not
list at all (cut at load, see `skill_resolver_host_load_cut`) goes into that
agent's `exclude_ids` and is never suggested, and setup names it. If the
command fails, or lists none of the catalog's skills (usually a different
workspace), nothing is filtered and setup says so. Run setup again after you
change which skills an agent can use.

The plugin never adds to or edits OpenClaw's own skill list. On each real user
turn (`before_prompt_build`; inter-session and other internal turns are
skipped) it puts up to 3 suggestions with at least a description match in
`appendContext`, and the pinned block in `appendSystemContext`. Ranking runs
in a worker thread with a 50 ms deadline: a miss injects nothing, commits
nothing and is logged as `timeout`; three misses in a row restart the worker.
A retried turn (same message id) gets the same block and commits once. It
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
- `--pins-route system|first_turn`: pins every turn in the system context
  (default), or in the turn context on a session's first turn and after
  compaction.
- `--owner-sender <id>` (repeatable): only turns from these senders get
  suggestions; others get the pins only.
- `--skill-loading off`: uninstalls the plugin and removes its files and
  state. Pins stay in config.json.

`skills.resolver.per_harness.openclaw.{top_k,min_match}` overrides the
defaults (3 and `description`); the global `skills.resolver.top_k` and
`min_match` apply when it is unset, and `skills.resolver.pinned` lists skills
OpenClaw already loads, which are never suggested. The plugin reads these the
way every lane does, so a bad value makes setup refuse with
`skill_resolver_config_invalid` and write nothing; a change takes effect at
the next `gbrain setup openclaw`.

Each turn appends one line (agent, outcome, duration, error code, arm,
suggested ids; never turn text) to
`skill-index/logs/openclaw-<date>.jsonl`, and a `read` line when the model
opens a skill, marked with whether it was suggested. `gbrain doctor --only
skill_resolver` reports the plugin, the library, each agent's catalog and pins
and, over the last 24 hours, the turns, outcomes, how many reads were of
suggested skills and the deadline-miss rate. Above 5% over at least 20 turns
it warns with `skill_resolve_timeout`; keep a rollout in shadow until the rate
is under that on the real host.

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
gbrain skills pin list --catalog openclaw-main
gbrain skills pin remove deploy-example --catalog openclaw-main
```

A pin must name a skill in that catalog (`skill_resolver_pin_unknown`
otherwise), its line is at most 100 characters with no `<` or `>`, a catalog
holds at most 64 pins, and the rendered block is capped at 600 tokens (pins
past it are listed as cut). A pinned skill is never also suggested. Pins live
in config.json under `skills.resolver.pins.<catalog>`, so turning the resolver
off keeps them; an OpenClaw agent uses a change from its next turn.

## The contract (schema_version 1)

The JSON Schemas are checked in under `docs/schemas/`:

- `skill-resolver.v1.turn-input.json`: `{message, previous_user_message?,
  session_id?, harness?, top_k (1-8, default 5), exclude? (up to 1,024 ids),
  min_match_strength?, top_gate?, shadow?, expected_catalog_hash?, reset_session?}` for
  `--input-json -` or the library.
- `skill-resolver.v1.turn-output.json`: the `--json` result. Everything outside
  `meta` is byte-identical for the same index, input and session state.
- `skill-resolver.v1.build-input.json`: the `--from-json` catalog,
  `[{id, name, description?, when_to_use?, triggers?, routing?, body?, path?,
  eligible?, disable_model_invocation?}]`. With the same fields a SKILL.md
  folder has (`when_to_use`, `disable-model-invocation`), a JSON build gives
  the same `catalog_hash` and `index_hash` as the folder build.
- `skill-resolver.v1.build-receipt.json`: the build receipt, also saved as
  `receipt.json` beside the index.

Within v1, changes are additive only.

`no_skill` is true only for an acknowledgement from a small multilingual list
(`no_skill_reason: "ack"`) or when no word of the turn is in the catalog
(`"no_match"`). There is no score threshold: a weak match is still
suggested, and each suggestion's `match_strength` says how it matched
(`named` in the turn, else the first of `name`, `triggers`, `routing`,
`description`, `body`). `min_match_strength` (`--min-match`) filters
candidates: weaker matches are dropped before the cut to `top_k` and the
stronger ones still fill the block, so `description` drops body-only matches.
It is not a gate: in a large catalog some skill almost always matches a
message on its name somewhere in the ranking, so even `name` rarely empties
the block and instead swaps good description hits for weaker name hits. A
skill named in
the turn (`$name`, `@name`, a leading `/name`, "the name skill", or its full
id) ranks first. When the message matches no catalog word (a follow-up such
as "do it again"), `previous_user_message` (`--previous`) is ranked instead.

### top_gate: an experimental gate, off by default

`top_gate` (`--top-gate`, `skills.resolver.top_gate`) empties the block
when the best skill the block would show (after `exclude`, pinned skills,
`min_match_strength`, session dedupe and pacing) has a score that, divided by its catalog's maximum
idf, `ln(1 + (n - 0.5) / 1.5)` for a catalog of `n` skills, is below the
threshold (0 to 100; unset or 0 is off). With merged catalogs it takes the
highest of those candidates. A skill named in the turn bypasses it. The
division keeps the number comparable across catalog sizes; it does not undo
message length, so long messages still score higher.

It stays off by default because no threshold has yet shown that it removes
suggestions on no-skill turns without hiding many right ones. Two offline
measurements disagree:

| Source | Turns | Gate fitted on | False suggestions on no-skill turns | hit@5 on skill turns, gated (ungated) |
|---|---|---|---|---|
| [gbrain-evals `2026-11-07-skill-ranker-offline`](https://github.com/garrytan/gbrain-evals/tree/main/docs/benchmarks/2026-11-07-skill-ranker-offline), gate probe | 320 test and gate-stress turns (terse skill requests, long no-skill messages), 250 / 750 / 1,500 skills | dev and stress-dev, at threshold 1.33 | 0.19 / 0.17 / 0.19 | 0.26 / 0.27 / 0.28 (0.515 / 0.555 / 0.611) |
| harness-evals set P dev half, HARN-52 (descriptive) | 146 turns, one 349-skill catalog | the same rows it is scored on, as a raw score of 4.16 (top_gate 0.76 on that catalog) | 0.03 | 0.71 (0.78) |

The first is a held-out score on turns written to break length-based gates;
the second is fitted and scored on the same rows. Treat `top_gate` as a
setting to measure, not one to turn on: the threshold that fits one catalog
and one kind of turn is not known to fit another.

An empty block carries `block_reason`: `ack`, `no_match`, `filtered` (every
match was excluded or below `min_match_strength`), `weak_top_match` (the best
skill scored below `top_gate`), `deduped` (every match was
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
  in `config.json` (default 2,000 tokens; 0 silences the resolver, otherwise
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

Nothing leaves the machine. Everything lives under `$GBRAIN_HOME/.gbrain/skill-index/`
(`~/.gbrain/skill-index/` by default):

| Path | Holds |
|---|---|
| `<catalog>/index.bin`, `receipt.json` | the index and its receipt (receipt written last) |
| `<catalog>/source.json` | the `--from-json` snapshot |
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

The catalog was removed while a build ran, so the build published nothing.

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
`dirs` list that is not absolute paths or names a harness other than
`claude-code` or `codex`) is out of range, or
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
caps each root with `skills.limits.maxCandidatesPerRoot`), so `skills_read`
could not open them. Setup leaves those skills out of the agent's suggestions
and names them. To get them back, raise that limit or split the root, then run
setup again.
