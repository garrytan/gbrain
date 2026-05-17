# Skillpacks as scaffolding, not amber

GBrain v0.33 reshapes `gbrain skillpack` from a package manager into a
scaffold + reference library. This guide explains the model and the
workflow.

## Why we changed it

Pre-v0.33 (the "amber" model):

- `gbrain skillpack install <name>` copied bundled skills into your
  workspace AND wrote a managed-block fence into your `RESOLVER.md` /
  `AGENTS.md` with a `cumulative-slugs="..."` receipt.
- Subsequent installs hash-checked every file and refused to overwrite
  local edits unless you passed `--overwrite-local`.
- `gbrain skillpack uninstall` had its own data-loss safeguards (D8
  receipt gate + D11 content-hash pre-scan) and rebuilt the fence.

It worked, but it treated personal-AI skills like vendor packages.
Users couldn't cleanly fork a skill without the next install fighting
them. Every release re-litigated the same managed block. The test
surface alone for the managed block was ~1000 lines.

Skills aren't vendor packages. They're first-class code in your agent
repo. You scaffold once, you own them, you fork and edit freely. When
gbrain ships a new version, you ask "what changed?" — the agent reads
the diff and decides what (if anything) to integrate.

## The five commands

### `gbrain skillpack scaffold <name> [--workspace PATH]`

One-time, additive copy of a bundled skill into your repo. Refuses to
overwrite any file that exists. Routing comes from each skill's
frontmatter `triggers:` array — gbrain does NOT touch your `RESOLVER.md`
or `AGENTS.md` (see "How agents discover scaffolded skills" below).

```bash
cd ~/git/wintermute
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
every hunk whose pre-change context matches uniquely. **Two-way merge
limitation**: without scaffold-time base tracking (intentionally
out-of-scope for v0.33), this cannot distinguish "gbrain changed X"
from "you changed X." Applied hunks align everything to gbrain. Use
`--dry-run` first to preview, or run plain `reference` to inspect the
diff before letting auto-apply touch anything.

### `gbrain skillpack migrate-fence [--workspace PATH] [--dry-run]`

One-shot conversion for workspaces on the pre-v0.33 managed-block
model. Strips the `<!-- gbrain:skillpack:begin -->` / `end -->`
markers and the manifest receipt comment from your resolver file.

**Preserves every row inside the fence verbatim.** Those rows become
user-owned routing the agent can still see during the transition to
frontmatter-based discovery.

```bash
cd ~/git/wintermute
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
  (`\bWintermute\b`, common email regex, Slack channel pattern). Any
  match → rollback (delete the harvested files) and exit non-zero.
- `openclaw.plugin.json` updated with the new slug, sorted.
- `--no-lint` bypasses the linter (after a manual editorial scrub).

Use the `skillpack-harvest` skill (its companion editorial workflow)
to walk the genericization checklist before running the CLI.

## How agents discover scaffolded skills

Routing under the new model lives entirely in each skill's frontmatter:

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

This replaces the v0.32 model where `gbrain skillpack install` wrote
table rows into your `RESOLVER.md`. Rows are gone (or, for users
migrating from the old model, preserved transitionally by
`migrate-fence` until they run `scrub-legacy-fence-rows`).

If you're a downstream agent author updating to this model:

1. On startup, scan `skills/*/SKILL.md` for frontmatter.
2. Build an in-memory routing table from each skill's `triggers:`
   array.
3. On every user message, match against this table — either by
   substring containment, semantic similarity, or whatever your
   downstream agent already does for intent classification.

## Removing a scaffolded skill

There's no `gbrain skillpack uninstall` command in v0.33. The files
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

## When to use which command (quick decision tree)

- **New host repo, want a gbrain skill** → `scaffold`
- **gbrain shipped a new version, want to see what's changed**
  → `reference` (read-only) or `reference --apply-clean-hunks` (auto)
- **Upgrading from v0.32 or earlier** → `migrate-fence` (one-shot)
- **Cleanup after `migrate-fence`** → `scrub-legacy-fence-rows`
- **Lift your fork's skill back into gbrain** → `harvest` + the
  `skillpack-harvest` editorial skill

## What about `install` and `uninstall`?

Both are removed in v0.33. Running either prints an error pointing at
the replacement command. No deprecated alias — this is a clean break.
If you have existing scripts referencing the old names, update them
once and move on.
