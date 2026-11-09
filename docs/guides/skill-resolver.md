# Skill resolver: the few skills that fit this turn

A harness with hundreds of skills cannot show the model every name and
description on every turn: native listings truncate, and the model then picks
from whatever survived. The skill resolver ranks a catalog of skills against
the user's message and prints a short `<relevant_skills>` block (at most
five suggestions, at most 400 tokens) for the harness to put in front of the
model.

- **Off by default.** Nothing changes until you build a catalog and wire a
  harness to call `gbrain skills resolve`, or turn on the hook lane with
  `gbrain setup <claude-code|codex> --skill-loading resolve`. Setup writes
  nothing for it otherwise.
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
| Codex | `gbrain skills index build --catalog codex-user --dir ~/.codex/skills --harness codex` | Suggestion lines carry the SKILL.md path; Codex opens it. |
| Hermes, qm | `--dir <skills dir> --harness hermes` (or `qm`) | The id is the name the loader takes. |
| OpenClaw and other adapters | `gbrain skills index build --catalog openclaw-main --from-json - --harness openclaw` | The adapter pipes its skill list (schema below) and owns rebuilds. |
| gbrain's own skills | `gbrain skills index build --catalog gbrain --bundled` | Rebuilt when the gbrain version changes. |

- `--dir` is repeatable; earlier directories win duplicate ids (the loser is
  listed in the receipt as `duplicate_id`). Symlinks that leave the root,
  skills with `disable-model-invocation: true` and JSON entries with
  `eligible: false` are never indexed.
- `--routing <file>` adds the rows of one RESOLVER-style routing table to
  the skills they name.
- `--scope project` marks a cloned repository's skills: their blocks show ids
  and names only, never their summaries, because the text came from someone else.
- Bounds: 10,000 skills per catalog, 64 KB per SKILL.md, 8 MB of JSON.
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

1. It builds the user catalog `claude-code-user` from `~/.claude/skills`
   (Codex: `codex-user` from `~/.agents/skills` and `$CODEX_HOME/skills`).
   With no skill found it stops with `skill_resolver_setup_incomplete` and
   writes nothing else.
2. It sets `skills.resolver.enabled` and `skills.resolver.harnesses` in
   `~/.gbrain/config.json`. A brainless install stays brainless: the file
   holds no engine, so nothing reads it as a brain.
3. It adds the lane's own hook: Claude Code gets UserPromptSubmit and
   SessionStart entries marked `skill-resolver-v1` in `~/.claude/settings.json`;
   Codex gets a UserPromptSubmit group in `hooks.json` (`--harness codex`),
   trusted in `config.toml`. Both run through the existing hook launcher.
4. It prints a sample block and `skill resolver: on; N skills; fresh`.

`--dry-run` lists every write, and re-running changes nothing. A bare
`gbrain setup <harness>` refreshes a lane that is on.

The lane runs the resolver in the hook process (never through `gbrain serve`),
so it works with serve down and with no brain. Each block names the skill ids
and gives the harness's own load line; Codex lines also carry the SKILL.md path.
The lane always exits 0 and prints nothing when it cannot deliver:

- **Deadline:** 50 ms from lane start. Ranking runs in a worker thread; at the
  deadline the process prints nothing, exits and commits no session state.
- **Payload:** at most `skills.resolver.lane_payload_chars` characters of hook
  output (default 4000, 500 to 10,000); a larger block is dropped whole and
  counted as `payload_dropped`.
- **One owner:** when several settings files wire the lane, only the first
  entry whose home has the lane on delivers.
- **Project skills (Claude Code):** a project's `.claude/skills` gets its own
  catalog, `claude-code-project-<hash of the root>`, built in the background
  the first time the project is seen and merged by name only. Stale catalogs
  rebuild the same way, at most once a minute;
  `skills.resolver.auto_rebuild false` or `GBRAIN_SKILLS_NO_AUTOREBUILD=1`
  stops both.
- **Compaction:** a SessionStart with `source: compact` resets the session, so
  skills can be offered again.

Each turn appends one line (outcome, error code, duration; never turn text)
to `skill-index/logs/lane.jsonl`. `gbrain doctor` (`skill_resolver`, and
`harness_wiring`'s details) reports the hook, each catalog's freshness and
the recent error codes; it says nothing while the resolver is off.

Compiled binaries carry the lane's worker as a second entrypoint
(`bun build --compile src/cli.ts src/core/skills/resolver/hook-worker.ts`); a
binary built without it delivers nothing and logs `skill_resolver_internal`.

## The contract (schema_version 1)

The JSON Schemas are checked in under `docs/schemas/`:

- `skill-resolver.v1.turn-input.json`: `{message, previous_user_message?,
  session_id?, harness?, top_k (1-8, default 5), exclude?, shadow?,
  expected_catalog_hash?, reset_session?}` for `--input-json -` or the library.
- `skill-resolver.v1.turn-output.json`: the `--json` result. Everything outside
  `meta` is byte-identical for the same index, input and session state.
- `skill-resolver.v1.build-input.json`: the `--from-json` catalog,
  `[{id, name, description?, triggers?, routing?, body?, path?, eligible?}]`.
- `skill-resolver.v1.build-receipt.json`: the build receipt, also saved as
  `receipt.json` beside the index.

Within v1, changes are additive only.

`no_skill` is true only for an acknowledgement from a small multilingual list
(`no_skill_reason: "ack"`) or when no word of the turn is in the catalog
(`"no_match"`). There is no score threshold: a weak match is still
suggested, and each suggestion's `match_strength` says how it matched
(`named` in the turn, else the first of `name`, `triggers`, `routing`,
`description`, `body`) so an adapter can set its own floor, for example
dropping body-only matches. A skill named in the turn (`$name`, `@name`, a leading `/name`,
"the name skill", or its full id) ranks first.

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
  any. When it is spent, `budget_exhausted` is true and the block is empty;
- state is committed only after the block was delivered: the CLI commits
  after writing stdout, the library through `result.commit()`;
- `--reset-session` (`reset_session: true`) on the first turn after a
  compaction starts the session again;
- `--shadow` computes the block without injecting it and keeps its own
  state, so a shadow run records exactly what the live arm would have shown
  (`--shadow-log <file>` appends it).

The key is `sha256(on|shadow, harness, session id)`: the same id under two
harnesses is two sessions, and merged catalogs share one. Session files idle
for 7 days are deleted.

Measured block size at k=5 over the Step 1 test turns on gbrain's own skills:
median 267 tokens (Claude Code), 268 (Hermes), 270 (qm), 334 (Codex) and 339
(OpenClaw, both with paths); the largest was 366. The hard cap is 400.

## Freshness and rebuilds

`resolve` never rebuilds. When the source changed it still answers from the
existing index with `meta.index_stale: true` and touches `stale.stamp`; the
rebuild runs from `gbrain skills index build` (which prints the exact command
in `skills index status`). For a `--dir` catalog the turn checks file sizes and
mtimes, at most 1,024 per turn and a full sweep at most once a minute;
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
| `logs/resolver.log` | scrubbed stack traces of unexpected failures; never turn text |

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
`bun scripts/bench-skill-resolver.ts` measures it in three rounds of 300 turns
and judges the median round's p95, so one burst of host stalls on a shared
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
const r = await resolveSkills({ message, session_id, harness: 'codex' }, { catalogs: ['codex-user'], failOpen: true });
inject(r.output.suggestions.filter(s => s.match_strength !== 'body').length ? r.output.block : '');
await r.commit();
```

On an event loop that must not block, commit with async I/O instead:
`if (r.pending) await commitSessionAsync(home, r.pending.key, r.pending.delta)`
(same file, lease and rules as `commit()`).

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
was built from another skill list. Nothing was suggested or committed. Rebuild
from the current list.

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

`skills.resolver.session_token_budget` is not 0 or 100-50,000, or GBRAIN_HOME
is not an absolute path.

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
`skill-index/logs/resolver.log`. Run `gbrain skills index status` and report it
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
