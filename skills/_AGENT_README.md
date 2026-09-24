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

## Shared-brain skills are a different ownership model

The local scaffolding rules below apply to independent copied skills. When
connected to a shared brain, canonical skills live beside knowledge in that
brain's source repository; installed files are managed artifacts, not a second
authority. The original parent follows the same revisions as other members.
Preserve unrelated identity and instructions.

Use the recorded absolute launcher or named MCP connection. Discover with
`list_skills` and `schema_version: 2`; match descriptions/triggers, then fetch
the relevant qualified identity and exact revision with `get_skill`. Fetch
only declared, approved dependencies through `get_skill_asset` at that revision.
Do not choose an ambiguous same-name skill or treat ordinary knowledge as
published instructions. A failed catalog read is not an empty catalog.

Follow only under the approved source policy and explicit `skills_member_self`
grant. Membership does not confer `skill_editor`, `skill_publisher`, tools,
script execution, spending, or capture. New connection grants default to follow
with `--skills memory-only` as the opt-out; old grants require explicit regrant.
Different installations need independent principals, including the parent.

Inspect `shared_skills` receipts and pending actions. Router installation for
Claude Code, Codex, and opencode can require restart and is native-unverified;
manual adapters remain pending. Router instructions are advisory, not an
enforced invocation hook. Check the current authorized view before selection,
and do not activate stale cached skills if that check fails. Verify actual
new-conversation use separately from protocol access and installed files.

Never run scaffold/reference mutation or `rm` instructions below against a
managed canonical skill or cache. Preserve edited copies as conflicts; request
authorized publication or managed leave/removal instead. Leaving removes only
unchanged owned artifacts and does not revoke credentials or erase history.
The guide in the GBrain distribution is
`docs/guides/shared-brain-skills.md`; existing installations follow
`skills/migrations/v0.53.0.0.md` without changing unrelated consent.

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

**The routing contract:** frontmatter `triggers:` are authoritative.
`skills/RESOLVER.md` is the human-readable dispatch map of the same routing —
useful for scanning every skill and its trigger phrases in one place, and it
carries the disambiguation rules for overlapping matches. If the two disagree,
frontmatter wins. (There is no machine-managed block inside `RESOLVER.md` or
`AGENTS.md`; that pattern was retired.)

## The memory loop

Preserve the existing agent's identity, native memory, and unrelated instructions.
Start with keyless recall and explicit remembering:

1. Read relevant entity/project context before answering.
2. Save facts the user explicitly asks to remember, with provenance and the
   intended brain/source. Automatic capture is off until the user opts in.
3. Read the stored record before correcting it, retire the old fact, and save
   the correction. `forget` withdraws active memory; history and backups may remain.
4. Verify with `recall`, `entity`, or `get_page` before claiming the change landed.

Choose verification that can read the intended visibility: trusted local CLI
can recall private facts; MCP (including stdio) and a thin CLI connected to MCP
currently recall and withdraw world-visible facts only. Preserve the user's intended privacy.
A committed remote private-write receipt confirms storage, not private recall; explain
when trusted local readback is unavailable rather than claiming verification or
widening access. Use only harmless synthetic world-visible facts for an
authorized MCP connection test, then withdraw them.

After explicit automatic-capture opt-in, apply the bundled `signal-detector`
contract to substantive messages. Delegation and paid enrichment require their
own authority. Reading context, installing skills, or possessing an API key does
not authorize capture. A chat-only request suppresses writes for that message.
Native skill activation and recall in a new conversation need actual harness
evidence; generating files alone establishes neither.

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

For independent scaffolded copies, the user runs `gbrain upgrade`. Those skill
files DO NOT change automatically.
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

There is no `uninstall` command (`gbrain skillpack uninstall` exits with an
error pointing here). The files are yours.

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

## Frontmatter contract notes

- **`upstream: <donor-skill>@<short-sha>`** — the provenance pin: which
  donor skill (by slug) and which commit of it this skill was ported from.
  Multi-source ports pin every donor, either as a YAML list or plus-joined
  (`upstream: skill-a@abc1234 + skill-b@def5678`). To resolve a drift or
  behavior question, diff the current SKILL.md against the pinned source
  commit — the pin is what makes that diff possible.
- **Optional keys are omitted, not zeroed.** Omit `writes_to` entirely when
  the skill writes no pages (an empty list implies "writes pages, nowhere",
  which is a contradiction). `brain_first: exempt` is allowed only with an
  adjacent comment justifying WHY the skill is exempt from the brain-first
  lookup chain — an unexplained exemption is a conformance failure.
- **`priority:` is NOT part of the routing contract.** Nothing in the routing
  path consumes it — matching is substring-over-`triggers:` (see "Routing"
  above), with `RESOLVER.md` disambiguation for overlaps. A `priority:` key is
  inert; don't add one expecting it to reorder matches. Encode precedence in
  trigger specificity and the resolver's disambiguation rules instead.
