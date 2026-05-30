# Scaling skills past 300 without drowning the context window

When an agent grows past 100 skills, a wall starts forming. Sessions take
longer to start. The model gets a little dumber about which skill to pick.
Tokens that should be powering reasoning are powering a skill catalog the
model reads on every turn whether it needs to or not.

This guide is the recipe for breaking through that wall without deleting
capabilities. Three tiers, one resolver, one safety net. Production-tested
on a 306-skill agent (Garry's OpenClaw, the agent behind Y Combinator's
president). The pattern works whether you run OpenClaw, Hermes, Claude Code,
Cursor, or your own MCP-aware agent.

## The problem

OpenClaw scans every skill file on disk at session start and injects them
into the system prompt as `<available_skills>` entries. The model sees a
name, description, and file path for each one. When a request matches, the
model reads the full SKILL.md and follows it.

This is great architecture at 50 skills. At 100, it's fine. At 200, it
starts to drag. At 300, the system prompt eats more than 25,000 tokens on
skill descriptions alone. Tokens that aren't going to reasoning, context,
or actual work.

The symptoms compound:

- Sessions take noticeably longer to start.
- The model has less room for conversation history.
- Skill routing gets fuzzier. With 300 descriptions competing for attention,
  the model occasionally picks the wrong one.
- Cost goes up because every turn carries the full skill manifest.

The naive fix is to delete skills you don't use often. Don't do this. The
whole point of skills is that capabilities compound. A gift pipeline that
fires twice a month saves 30 minutes each time it does. A flight tracker
fires once per trip and prevents a missed Uber. Deleting low-frequency
skills optimizes for prompt size at the cost of capability. You wouldn't
delete apps from your phone because the home screen is too crowded. You'd
organize them.

## The three tiers

Not all skills need to be visible to the model at all times. Some are core.
Some are specialized. Some are dormant.

### Tier A: always loaded (~35 skills)

The skills the model needs on every single turn. Brain search, email triage,
calendar, meeting ingestion, content creation, the executive assistant.
They stay in the system prompt's `<available_skills>` manifest. The model
sees them natively and routes to them without any lookup.

### Tier B: resolver-routed (~85 skills)

Real, active skills that fire regularly but don't need to pollute every
turn. Gift pipeline, flight tracker, investor update ingestion, adversary
tracking, book mirror, civic intelligence. They live on disk. They have
full SKILL.md files. But OpenClaw doesn't inject them into the prompt.

Instead, a compact RESOLVER.md handles routing. One line per skill with
trigger phrases:

```markdown
- **gift-advisor**: gift idea | what should I bring | birthday gift | housewarming
- **flight-tracker**: track my flight | flight status | when does my flight land
- **investor-update-ingest**: investor update | portfolio update | company metrics
```

When the model sees "what should I bring to Jessica's dinner," it checks
the resolver, finds `gift-advisor`, reads the SKILL.md, and executes. Same
result. Zero wasted tokens on the other 84 turns where gifts aren't relevant.

### Tier C: dormant (~180 skills)

Built-in OpenClaw skills that aren't in active rotation (1Password, Discord,
Notion, Trello, integrations you haven't wired up yet) plus specialized
skills that almost never fire. They're explicitly disabled in the config
with `enabled: false`. They exist on disk as documentation and potential.
Flip one boolean to wake them up. Zero tokens contributed to every prompt
until then.

### The numbers

Before tiering, on Garry's 306-skill OpenClaw:

| Metric | Before |
|---|---|
| Skills in system prompt | 306 |
| Skill-description tokens per turn | ~25,000 |
| Skill routing accuracy | degrading |
| Session startup | slow |

After tiering:

| Metric | After |
|---|---|
| Skills in system prompt (Tier A) | 35 |
| Skill-description tokens per turn | ~4,000 |
| Skills still accessible (A + B + C) | 301 |
| Capability loss | zero |
| **Tokens freed per turn** | **~21,000** |

21K tokens per turn is not a small optimization. It's the difference between
the model having room to think and the model being squeezed. It's the
difference between carrying 3 pages of conversation history and carrying 15.

## What the resolver actually does

The resolver is cheaper than the manifest. That's the load-bearing insight.

OpenClaw's native skill manifest puts ~80 tokens per skill into the system
prompt (name + description + location). At 300 skills that's 24,000 tokens
spent every turn whether the model needs the catalog or not.

The resolver puts ~15 tokens per skill into a compact markdown list. At
300 skills that's 4,500 tokens. But it only fires when the model checks
it, which is only when the request doesn't match a Tier A skill. Most
turns, the resolver costs zero tokens because the Tier A match handles it.

This is the routing-table pattern but applied to the skill manifest itself.
The resolver routes to skills, but it also routes around skills, keeping
them out of the context window until they're needed.

GBrain ships with a [bundled `skills/RESOLVER.md`](../../skills/RESOLVER.md)
you can use as a reference shape. The skillpack story for distributing
your own resolvers across machines is covered in
[skillpacks as scaffolding](skillpacks-as-scaffolding.md).

## The compact list format (v0.41.7.0)

GBrain's resolver parser used to require markdown tables:

```markdown
| Trigger | Skill |
|---------|-------|
| "gift idea" | `skills/gift-advisor/SKILL.md` |
```

That's fine when you have 20 entries. It gets unwieldy at 200, and at 300
it's unreadable. OpenClaw deployments quietly evolved a compact list
format that scales better:

```markdown
- **gift-advisor**: gift idea | what should I bring | birthday gift
- **flight-tracker**: track my flight | flight status | when does my flight land
```

Before v0.41.7.0, `gbrain doctor` only spoke the table dialect. On a
306-skill compact-format resolver, the doctor reported every skill as
unreachable: **238 FAIL errors on every doctor run**. The parser was
silently treating the compact dialect as zero skills.

v0.41.7.0 ships dual-format support. The same `parseResolverEntries`
function reads both table rows and list rows in the same file, with the
v0.31.7 multi-resolver merge (skillpack `skills/RESOLVER.md` + workspace
`../AGENTS.md`) folding everything into one unified view. Run `gbrain doctor`
and the 238 FAILs collapse to 0.

### The list-format contract

A few rules to keep the parser unambiguous:

- **Skill names must be kebab-lowercase.** `gift-advisor`, `flight-tracker`,
  `email-triage`. Names that start with an uppercase letter (`MyTool`,
  `Note`, `Convention`) are deliberately ignored. This is what stops prose
  bullets like `- **Note**: see [link]` from being mis-parsed as skill
  rows in real-world AGENTS.md files.
- **The path always resolves to `skills/<name>/SKILL.md`.** An optional
  `→ \`skills/path\`` (or ASCII `->`) suffix is allowed for readability,
  but the parser strips it. For non-conventional paths (skills under
  nested directories, references into `conventions/`, anything that
  isn't `skills/<name>/SKILL.md`), use the table format.
- **Triggers separate with `|`.** Empty pieces and the literal `...`
  placeholder are dropped. Each trigger becomes its own resolver entry,
  all pointing at the same skill.
- **Bold or plain.** `- **name**: triggers` is preferred. `- name: triggers`
  works as a fallback.

You can mix table and list rows in the same file. Useful when a brain
inherits a table-format `RESOLVER.md` from gbrain and a list-format
`../AGENTS.md` from OpenClaw.

## The doctor safety net

The danger with tiering is invisible skill loss. You disable a skill from
native scanning, forget to add it to the resolver, and now the agent can't
do something it used to do. You won't notice until the moment you need it.

`gbrain doctor` walks every skill on disk and verifies it's reachable,
either through native scanning (Tier A) or through the resolver (Tier B
and C). On Garry's setup, the first run after tiering found 63 unreachable
skills. Sixty-three capabilities that existed on disk but had no routing
path. Fixed in an hour by adding resolver entries.

Run it after every skill change:

```bash
gbrain doctor
```

For CI gates, use the JSON-emitting variant:

```bash
gbrain check-resolvable --json
gbrain check-resolvable --strict  # warnings fail too
```

If a skill is unreachable, the output tells you which one and suggests
the fix. The resolver is a document. Documents are cheap to fix.

## Implementation walkthrough

Three changes. Total time about 45 minutes once you've decided which
skills go in which tier.

### 1. Audit and tier your skills

Walk through every skill. Ask: does this need to fire on every turn?

- If yes → Tier A.
- If it fires weekly or less but is real → Tier B.
- If you don't use it → Tier C.

### 2. Disable Tier B and C in your agent's config

For OpenClaw, the file is `openclaw.json`. Add an entry per disabled skill:

```json
{
  "skills": {
    "entries": {
      "gift-advisor": { "enabled": false },
      "flight-tracker": { "enabled": false },
      "1password": { "enabled": false }
    }
  }
}
```

The exact config shape depends on which agent runtime you use. The point
is the same in all of them: tell the runtime not to inject this skill into
the system prompt. The file stays on disk; only the prompt injection stops.

### 3. Write the resolver

One line per Tier B and Tier C skill. Trigger phrases that match how you
actually ask for things:

```markdown
- **gift-advisor**: gift idea | what should I bring | birthday gift
- **flight-tracker**: track my flight | flight status | when do I land
- **investor-update-ingest**: investor update | portfolio update | company metrics
```

That's it. The model handles the rest. When a request doesn't match Tier A,
it checks the resolver, reads the matching SKILL.md, and executes.

### 4. Run `gbrain doctor` and fix any unreachable skills

The doctor sweep tells you which skills don't have a routing path. Add a
resolver entry for each one, re-run, repeat until the count is zero.

## A lesson from the first version

I initially converted my resolver from a clean list format to a table
format because the validator only spoke tables. That was wrong. When a
tool fails against valid data, the right move is to fix the tool, not
reshape the data. The list format was correct, compact, readable, easy
to maintain. The parser needed to support both shapes. v0.41.7.0 is
that fix.

The same principle applies everywhere in agent systems. Your SKILL.md is
the source of truth. Your AGENTS.md is the source of truth. Your resolver
is the source of truth. When tooling disagrees with your configuration,
the tooling is wrong. Fix the tooling.

## The scaling curve

At 50 skills, you don't need any of this. Just load everything.

At 100, you start feeling the drag but can push through.

At 200, routing accuracy drops and sessions get noticeably slower. This
is where most people stop adding skills, which means their agent stops
getting more capable. Bad trade.

At 300+, tiering is mandatory. But with tiering, there's no ceiling.
1,000 skills with 35 in the hot path and 965 in the resolver is the same
per-turn cost as 35 skills with no resolver. The cost stays flat.
Capabilities compound.

The architecture that gets you from 50 to 300 is different from the
architecture that gets you from 10 to 50. That's normal. Systems that
scale change shape. The important thing is that each tier preserves full
capability. You're organizing, not deleting.

## Related

- [Skill development cycle](skill-development.md) — the 5-step loop for
  turning a repeated task into a real skill.
- [Skillpacks as scaffolding](skillpacks-as-scaffolding.md) — how to
  distribute a coherent set of skills across machines and agents.
- [Sub-agent routing](sub-agent-routing.md) — when to delegate to a
  sub-agent vs handle in-line, and the model routing table for each path.

GBrain: [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain).
The `parseResolverEntries` parser lives at
[`src/core/check-resolvable.ts`](../../src/core/check-resolvable.ts);
the bundled resolver lives at [`skills/RESOLVER.md`](../../skills/RESOLVER.md).
