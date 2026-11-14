# Skillpacks as scaffolding, not amber

`gbrain skillpack` is a scaffold + reference library, not a package
manager. This guide explains the model and the workflow.

## Why it works this way

A package-manager model (an `install` that copies skills into your
workspace AND writes a managed-block fence into your `RESOLVER.md` /
`AGENTS.md`, hash-checks every file on the next install, and refuses to
overwrite local edits) treats personal-AI skills like vendor packages.
You can't cleanly fork a skill without the next install fighting you, and
every release re-litigates the same managed block.

Skills aren't vendor packages. They're first-class code in your agent
repo. You scaffold once, you own them, you fork and edit freely. When
gbrain ships a new version, you ask "what changed?" — the agent reads
the diff and decides what (if anything) to integrate.

## The core workflow commands

The five commands below are the scaffold-and-own workflow. The full
`gbrain skillpack` surface is larger (`list`, `diff`, `check`, `search`,
`info`, `registry`, `doctor`, `init`, `pack`, `endorse`, …) — run
`gbrain skillpack --help` for the always-current list. One worth calling
out here: **`gbrain skillpack init-brain-pack <name>`** scaffolds a
*brain-resident* pack inside a brain/source repo (`brain_resident: true`
plus a machine-parseable README) that connecting harnesses discover on
`gbrain sources add`.

### `gbrain skillpack scaffold <name> [--workspace PATH]`

One-time, additive copy of a bundled skill into your repo. Refuses to
overwrite any file that exists. Routing comes from each skill's
frontmatter `triggers:` array — gbrain does NOT touch your `RESOLVER.md`
or `AGENTS.md` (see "How agents discover scaffolded skills" below).

```bash
cd ~/git/your-agent-repo
gbrain skillpack scaffold book-mirror
# files in skills/book-mirror/ + (if the skill declares paired source)
# src/commands/book-mirror.ts land in your workspace
```

`scaffold --all` copies every bundled skill that's missing. Never
prunes.

If a skill's frontmatter declares paired source files (`sources: [...]`
in the SKILL.md YAML head), scaffold copies them too. The partial-state
policy handles "skill shipped earlier, gained a paired source later" —
scaffold copies the new paired file even when the skill dir already
exists.

### `gbrain skillpack reference <name> [--workspace PATH] [--apply-clean-hunks] [--json]`

Read-only update lens. Diffs gbrain's bundle against your local copy
and emits per-file status (`identical` / `differs` / `missing`) plus
unified diffs for any `differs` entries.

```bash
gbrain skillpack reference book-mirror
# These files live at <gbrain-path> as reference. Read them and
# decide what (if anything) to integrate into your local skills/.
# Your local edits are intentional — do not blindly overwrite.
#
# reference: identical:14 differs:1 missing:0
#
#   differs   /your/workspace/skills/book-mirror/SKILL.md
#   --- a/skills/book-mirror/SKILL.md
#   +++ b/skills/book-mirror/SKILL.md
#   @@ -10,3 +10,5 @@
#   ... unified diff ...
```

`reference --all` sweeps the whole bundle (one-line-per-skill summary).

`reference <name> --apply-clean-hunks` is the auto-apply path. It
parses the diff between gbrain's bundle and your local copy, applies
every hunk whose pre-change context matches uniquely. **It is a
destructive two-way apply**: it compares only your copy and gbrain's
current bundle, so it cannot tell "gbrain changed X" from "you changed
X," and applied hunks align everything to gbrain. Preview with
`--dry-run` first, or run plain `reference` and merge by hand. For
skills you never edited, `--update-untouched` (below) is the safe path.

### Updating installed skills

`gbrain skillpack reference <name>|--all --update-untouched [--dry-run] [--json] [--no-diff] [--accept-historical] [--fail-on-skipped]`
replaces whole skills you never edited with gbrain's current version.
It never prompts; `--dry-run` is the preview.

- **Base.** `scaffold` (including `--harness` installs, `sync` and the
  openclaw lane) and every update record the sha256 of each skill file
  gbrain installed in `~/.gbrain/skillpack-state.json`, per skills root and
  skill. That recorded base always wins.
- **Per skill, all or nothing.** A skill's closure is its `SKILL.md`,
  references, scripts and any shared dependency it lacks. It updates only
  when every closure file is unchanged, absent, or still equal to its base,
  and the skill is not pinned. A file that differs from its base is
  `local_edits` even when it equals a past release.
- **Installs from before bases were recorded.** A file with no base that
  equals a released version (listed in `skills/skills.lock.history.json`)
  is shown separately and needs `--accept-historical`.
- **Skip reasons:** `local_edits`, `pinned` (`gbrain skillpack pin <skill>`,
  undo with `unpin`), `no_history`, `historical_only`,
  `history_unverified` (the history file failed its hash in
  `skills.lock.json`, so no whole-file update runs) and `unsafe_target` (a
  symlink or a path outside the skills root). A skipped skill prints its
  diff: your copy against gbrain's, at most 200 lines per file, with
  secret-looking values redacted.
- **Commit protocol.** The closure is staged and checked first, a journal
  of intent and a backup of each replaced file go to
  `~/.gbrain/skillpack-backups/<id>/`, each file is rehashed right before
  its rename, and conformance, the trigger check and the resolver check run
  on the updated skill. A late change, a crash or a failed check rolls back
  only the files that still hold the update's bytes. A crash shows up as
  `skillpack_update_incomplete` in `gbrain doctor` and on the next run.
- **Restore.** `gbrain skillpack restore <id>` puts back what an update
  replaced and removes what it added. It refuses a file you changed since
  the update unless you name it with `--skip <file>`, and running it again
  is a no-op. `restore --list` lists backups; they are kept 30 days or the
  newest 10.
- **Exit codes:** 0 when nothing failed (skips are in the summary and
  JSON), 1 only with `--fail-on-skipped` when something was skipped, 2 when
  a skill failed (the files touched and the restore command are printed).
- **Locks.** The command takes the workspace writer lock
  (`.gbrain-skillpack.lock` beside the skills dir), then the shared lock on
  the state file, in that order.
- **No repository needed.** The state file and backups are files under
  `GBRAIN_HOME`, so this works the same on a repo-less brain.
- **Upgrades only announce.** `gbrain upgrade` writes no skill files; its
  behavior notice names the preview command.
- **Not covered:** paired source files outside the skills root (reported,
  never written), shared dependencies you already have (only missing ones
  are added), harness destination installs (`reference --harness <h>`
  stays the lens there), and skills shared through a brain. Those update by
  publishing a revision with `put_skill`; skillpack file-copy commands are
  not a way around publication. See
  [shared brain skills](shared-brain-skills.md#update-a-shared-skill).

| You want to | Run |
|---|---|
| Read what changed upstream | `gbrain skillpack reference <name>` (or `--all`) |
| Take upstream on skills you never edited | `gbrain skillpack reference --all --update-untouched --dry-run`, then without `--dry-run` |
| Keep an edited or deliberately old skill as it is | `gbrain skillpack pin <name>` |
| Update a skill you edited | read `gbrain skillpack reference <name>` and merge by hand; `--apply-clean-hunks` is a destructive two-way apply (preview with `--dry-run`) |
| Find which skills need work | `gbrain skillpack health` |
| Improve a skill's quality against a benchmark | `gbrain skillopt <name>` |
| Undo an update | `gbrain skillpack restore <id>` (`--list` to find it) |

### `gbrain skillpack health [<skill>] [--skills-dir PATH] [--json] [--strict]`

Read-only. For the active skills folder (the harness or workspace skills
dir, else the bundled skills) it reports each skill's bytes against its
budget, growth past 10% over its last diet, description size, missing
frontmatter triggers, and every `gbrain` command, flag or tool the skill
shows that this gbrain does not have. Each finding carries what was
observed, what was expected, the edit or command that fixes it (for an
unedited copy of a bundled skill, `gbrain skillpack reference <skill>`
first) and a verify command. A folder with no skills manifest or
`skills.lock.json` is checked only for copies of gbrain's bundled skills,
so other agents' skills are never reported. It reads files only, so it
works the same on a brain with no git repository.

`gbrain doctor` runs it as `skill_health` (it warns only on drift),
`gbrain maintain` and `gbrain skillpack-check` print its one-line summary.

### `gbrain skillpack migrate-fence [--workspace PATH] [--dry-run]`

One-shot conversion for workspaces still on the legacy managed-block
model. Strips the `<!-- gbrain:skillpack:begin -->` / `end -->`
markers and the manifest receipt comment from your resolver file.

**Preserves every row inside the fence verbatim.** Those rows become
user-owned routing the agent can still see during the transition to
frontmatter-based discovery.

```bash
cd ~/git/your-agent-repo
gbrain skillpack migrate-fence
# migrate-fence: fence_stripped
#   resolver: /your/workspace/skills/RESOLVER.md
#   fenced slugs: alpha, beta, gamma
#   already present: alpha, beta
#   skills copied: gamma   (additive — beta and alpha kept their local edits)
```

Idempotent. Re-running after migration finds no fence and exits 0.

### `gbrain skillpack scrub-legacy-fence-rows [--workspace PATH] [--dry-run]`

Opt-in cleanup. Once you've confirmed your agent walks frontmatter
`triggers:` for routing, this command removes the legacy rows that
`migrate-fence` left behind.

**Two-condition gate** (both must hold for a row to be removed):

1. `skills/<slug>/` exists on host (it was a real scaffold).
2. That skill's frontmatter declares non-empty `triggers:` (proof
   that frontmatter discovery covers this skill).

Rows whose slug fails either gate are preserved — user-owned routing
the migration shouldn't touch.

### `gbrain skillpack harvest <slug> --from <host-repo-root> [--no-lint] [--dry-run]`

Inverse of scaffold: lifts a proven skill from your host repo back
into gbrain so other clients can scaffold it. Default behavior:

- Symlinks in the host skill dir are rejected (canonical-path
  confinement).
- Privacy linter scans the harvested files against
  `~/.gbrain/harvest-private-patterns.txt` plus built-in defaults
  (canonical private fork name, common email regex, Slack channel pattern). Any
  match → rollback (delete the harvested files) and exit non-zero.
- `openclaw.plugin.json` updated with the new slug, sorted. Harvest must preserve
  the top-level OpenClaw-native plugin fields (`id`, `configSchema`, `contracts`)
  because OpenClaw validates those before it can install the package.
- `--no-lint` bypasses the linter (after a manual editorial scrub).

Use the `skillpack-harvest` skill (its companion editorial workflow)
to walk the genericization checklist before running the CLI.

## How agents discover scaffolded skills

Routing lives entirely in each skill's frontmatter:

```yaml
---
name: book-mirror
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
---
```

Your agent's job at runtime is to walk `skills/*/SKILL.md`, parse the
frontmatter, and match the user's intent against every skill's
`triggers:` array. When a match scores high enough, invoke that skill.

gbrain writes no routing rows into your `RESOLVER.md`. A workspace that
still carries a managed-block fence keeps its rows through `migrate-fence`
until it runs `scrub-legacy-fence-rows`.

If you're a downstream agent author adopting this model:

1. On startup, scan `skills/*/SKILL.md` for frontmatter.
2. Build an in-memory routing table from each skill's `triggers:`
   array.
3. On every user message, match against this table — either by
   substring containment, semantic similarity, or whatever your
   downstream agent already does for intent classification.

## Removing a scaffolded skill

There's no `gbrain skillpack uninstall` command. The files
in your `skills/<slug>/` are first-class members of your repo —
delete them like any other code:

```bash
rm -rf skills/book-mirror
# if the skill declared paired source files:
rm src/commands/book-mirror.ts
# (consult the skill's frontmatter `sources:` array for the full list)

# if no other scaffolded skill needs them, you can also remove the
# shared deps that scaffold drops in:
rm skills/_brain-filing-rules.md
rm -rf skills/conventions/
rm skills/_output-rules.md
```

You own the files. There's no manifest to update, no fence to rebuild.

## The harness bridge: `scaffold --harness`

Workspace scaffolds serve agent repos. The HARNESS lane installs a
persona-curated set of bundled skills into a coding harness's **native
skill-discovery location** instead:

```bash
gbrain skillpack scaffold --harness claude-code            # coding-agent persona → the user-scope skills dir
gbrain skillpack scaffold --harness claude-code --persona daily-driver
gbrain skillpack scaffold --harness claude-code --skill query --skill ingest
gbrain skillpack scaffold --harness openclaw               # workspace delegation, brain-first core (--all: full bundle)
gbrain skillpack reference --harness claude-code           # stub-aware three-way diff lens
gbrain skillpack remove --harness claude-code --skill query
```

- **Personas** live in `skills/plugin-lanes.json#personas` (one recorded
  reason per skill, validated against the plugin lane — lane-excluded skills
  like `testing` are refused with their recorded reason). `--persona all`
  (shorthand `--all`) installs the full lane. The same personas power the
  `gbrain-coding` / `gbrain-daily` marketplace plugin variants.
- **Never overwrites**: existing files are skipped and counted; the diff
  lens (`reference --harness`) splits `differs` into **local_edit** (your
  change — keep it) vs **upstream_drift** (gbrain moved —
  `--apply-clean-hunks` aligns), using the install-time hash ledger at
  `~/.gbrain/skillpack-bridge-state.json`. A shared file with no
  install-time hash in the ledger reports **unknown** provenance and is
  never auto-applied — patch by hand, or remove and re-scaffold.
- **`remove --harness`** deletes ONLY files the bridge wrote (the ledger) —
  never your own files. Shared convention files stay on disk even after the
  last skill is removed; once no owned skill is left at that destination,
  the v0.53.0 shared-skills migration no longer counts them as legacy
  copies. Workspace scaffolds have no `uninstall` at all; they stay
  user-owned outright.
- **`--stub`** installs cold-pull pointer SKILL.md files whose body fetches
  the real instructions via the gbrain MCP `get_skill` op. Preflight-gated:
  it refuses unless `mcp.publish_skills` is on and every slug is servable
  from the skills dir the server would resolve. Stub mode targets
  full-surface local/HTTP MCP setups — the marketplace plugin lanes serve
  the starter surface, where `get_skill` is not exposed; stub bodies tell
  agents to ask the operator for a wider serve surface (`request_tools`
  self-widening never exceeds the operator's ceiling, and stdio servers
  cannot persist a per-client surface at all). Shared convention files AND
  sibling aux files ship even in stub mode — skill bodies reference both,
  and `get_skill` serves only the SKILL.md body itself.
- **Targets**: `claude-code` has a verified user-scope skills dir (project
  scope via `--scope project`); `openclaw` delegates to the workspace
  scaffold; `codex` / `opencode` require an explicit `--dest` until their
  native locations get observation runs (the plugin lane already serves
  both). `reference --harness` and `remove --harness` accept the same
  `--dest` / `--scope` / `--workspace` targeting as `scaffold --harness`.
- **Coexistence**: the same skill names may also load from the gbrain
  marketplace plugin snapshot — duplicate names coexist in one session;
  prefer one lane per machine.
- **Known limitation**: skill bodies that reference shared deps
  repo-relatively (`skills/conventions/...`) keep those literal paths in a
  copied layout — same limitation as the plugin tree; sibling-relative
  references (`../conventions/...`) work because shared deps land as
  siblings. Skill bodies are never rewritten.

## When to use which command (quick decision tree)

- **New host repo, want a gbrain skill** → `scaffold`
- **Give a coding harness the curated skill set (user-scope, no
  marketplace)** → `scaffold --harness <h>`
- **Shipping a pack from inside a brain/source repo** → `init-brain-pack`
- **gbrain shipped a new version, want to see what's changed**
  → `reference` (read-only), `reference --all --update-untouched` for
  skills you never edited, or a hand merge for edited ones (see
  [Updating installed skills](#updating-installed-skills));
  for harness installs → `reference --harness <h>`
- **Find skills that grew too big or show commands this gbrain doesn't
  have** → `health` (read-only)
- **Upgrading from the legacy managed-block model** → `migrate-fence` (one-shot)
- **Cleanup after `migrate-fence`** → `scrub-legacy-fence-rows`
- **Lift your fork's skill back into gbrain** → `harvest` + the
  `skillpack-harvest` editorial skill
- **Undo a harness install** → `remove --harness <h>` (ledger-owned files only)

## What about `install` and `uninstall`?

Neither exists. Running either prints an error pointing at the
replacement command; there is no alias. Scripts that reference those
names need `scaffold` (or plain file deletion) instead. (The harness lane's `remove --harness` is a different
contract: it deletes only machine-ledgered bridge files, never yours.)
