# Agent onboarding — what to do with the files in this directory

You (the agent) are running on a host that scaffolded gbrain skills here. This
file is the operating contract. Read it on every cold start. It is short on
purpose.

## What lives in this directory

```
skills/
  _AGENT_README.md          ← you are here
  _brain-filing-rules.md    ← where to file brain pages (read on every write)
  _output-rules.md          ← output quality standards (no LLM slop, exact phrasing)
  _friction-protocol.md     ← log friction the user hits to ~/.gstack/friction/
  conventions/              ← cross-cutting rules every skill defers to
  <skill-name>/
    SKILL.md                ← the skill's contract + workflow
    routing-eval.jsonl      ← (optional) test fixtures for routing-eval
    script.ts               ← (optional) deterministic code, if any
```

Other files in the host repo's `src/`, `docs/`, `recipes/` etc. are owned by the
host, not by gbrain. Don't treat them as gbrain artifacts.

## Routing — your first job

Discover skills at runtime by walking every `skills/<slug>/SKILL.md` here and
parsing the YAML frontmatter. Each skill declares one or more `triggers:`
strings; they are the user-facing phrases that route to that skill.

```yaml
---
name: book-mirror
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
---
```

On every user message, match the message against every skill's `triggers:`
array. Substring match is the baseline. Semantic similarity (embedding or
keyword expansion) is fine on top. When a trigger matches strongly, invoke the
skill — read its SKILL.md body in full and follow the workflow described there.

**Do NOT** look for a managed-block table inside `RESOLVER.md` or `AGENTS.md`.
That pattern was retired in gbrain v0.36. Routing lives in frontmatter now.

## When the user invokes a skill

Read the entire `skills/<slug>/SKILL.md` file. Follow its `## Phases`,
`## Workflow`, or equivalent step-by-step section. If the skill has a
`mutating: true` frontmatter and declares `writes_pages:` / `writes_to:`,
those are the brain-side write surfaces — consult `_brain-filing-rules.md`
to confirm the file path is sanctioned.

If the SKILL.md frontmatter declares `sources:` (paired source files), those
live at their mirror path in the host repo (e.g. `src/commands/<slug>.ts`).
They are reference code that the gbrain CLI calls. You do not run them
directly unless the SKILL.md tells you to.

## Updates — when gbrain ships a new version

The user runs `gbrain upgrade`. Skill files DO NOT change automatically.
gbrain becomes a reference library you compare against.

On every cold start, or any time the user mentions an upgrade, run:

```bash
gbrain skillpack reference --all
```

That sweeps every bundled skill and reports per-skill `identical / differs /
missing` counts. For each `differs`:

```bash
gbrain skillpack reference <slug>
```

This prints a unified diff between gbrain's bundle and the local file. Read
it, then decide per file:

- **Local edit was intentional.** Keep your version. gbrain is reference, not
  law.
- **Local edit was accidental drift** (e.g. you wrote stale content into the
  skill body). Either patch by hand, or run
  `gbrain skillpack reference <slug> --apply-clean-hunks` (read the WARNING
  about two-way merge below first).
- **Genuinely new gbrain change in a section you don't care about.** Skip or
  apply per your judgment.

For `missing` files (gbrain added a new bundled skill since you scaffolded),
run `gbrain skillpack scaffold <new-slug>` to bring it in.

### `reference --apply-clean-hunks` — two-way merge warning

This command does a two-way diff against gbrain's current bundle. It does
NOT have access to the version you originally scaffolded. Consequence: if
the user's local file differs from gbrain in ANY section (including
intentional user edits), those sections WILL be aligned to gbrain.

Always run plain `gbrain skillpack reference <slug>` first to inspect.
Use `--apply-clean-hunks` only when you're confident the local edits were
accidental or you want to fully reset to gbrain's current bundle.

## Removing a scaffolded skill

There is no `uninstall` command in v0.36. The files are yours.

```bash
rm -rf skills/<slug>
# if the skill declared paired source files:
rm src/commands/<slug>.ts
```

Consult the skill's frontmatter `sources:` array for the full paired-file
list before deleting.

## When in doubt

The single source of truth for the model is
`docs/guides/skillpacks-as-scaffolding.md` in the gbrain repo. The skill
files you scaffolded are the source of truth for individual skill behavior.
This file (`_AGENT_README.md`) is the routing contract — keep it short.
