---
name: ask-user
version: 1.0.0
description: |
  Reusable pattern for presenting the user with explicit choices and gating
  execution until they respond. Used by other skills when a decision point
  requires human input before proceeding. Platform-agnostic — works on
  Telegram (inline buttons), Discord, CLI, or any agent with a message tool.
triggers:
  - "present options"
  - "ask before proceeding"
  - "choice gate"
  - "user decision"
priority: 50
---

# Ask User — Choice Gate Pattern

## What This Is

A **formalized pattern** for presenting users with 2-4 options and **stopping
execution** until they respond. This is the canonical way to gate on user input
in any GBrain-powered agent.

This is NOT a traditional async/await. In an LLM agent, "gating" means:
1. Present the choices (buttons or numbered options)
2. Explicitly stop the current turn (do not proceed)
3. The user's response triggers the next turn
4. Read the response and branch accordingly

## When To Use

- Ambiguous requests with multiple valid interpretations
- Destructive operations (bulk deletes, overwrites)
- Filing/routing decisions ("where should this go?")
- Priority triage ("which should I do first?")
- Cold-start phase gates ("ready for the next import source?")
- Any fork where the wrong default wastes significant work

## When NOT To Use

- Clear, unambiguous instructions → just do it
- Low-stakes decisions → pick the best option and mention it
- Time-critical operations where delay costs more than a wrong choice
- When the user has already expressed a preference

## How To Present Choices

### Platform-agnostic format (works everywhere)

Present choices as a clear question with numbered or labeled options:

```
🔀 **How should I handle this?**

[context about the decision — 1-3 lines max]

1. **Option A** — short description
2. **Option B** — short description
3. **Option C** — short description
4. **Skip** — do nothing for now
```

### With inline buttons (Telegram, Discord, Slack)

If the platform supports interactive buttons, use them:

```json
{
  "message": "🔀 **How should I handle this?**\n\n<context>",
  "buttons": [
    { "label": "Option A — description", "value": "option_a" },
    { "label": "Option B — description", "value": "option_b" },
    { "label": "Skip", "value": "skip" }
  ]
}
```

### With the `clarify` tool (Hermes Agent)

Hermes agents have a built-in `clarify` tool that presents choices natively:

```
clarify(
  question: "How should I handle this?",
  choices: [
    "Option A — description",
    "Option B — description",
    "Option C — description",
    "Skip for now"
  ]
)
```

## Constraints

- **2-4 options max.** More than 4 creates decision paralysis.
- **Labels must be self-explanatory.** The user shouldn't need to re-read context.
- **Always include an escape hatch.** At minimum: "Skip" or "Cancel" as the last option.
- **One question per message.** Never stack multiple choice gates.

## How To Gate (CRITICAL)

After presenting choices, **you MUST stop your turn.** Do not:
- ❌ Continue with "while you decide, I'll start on..."
- ❌ Pick a default and proceed
- ❌ Send follow-up messages before the user responds
- ❌ Make assumptions about which option they'll pick

Instead:
- ✅ End your message with a brief note that you're waiting
- ✅ Stop. Full stop. No more tool calls.

## How To Handle The Response

When the user responds:

1. **Read the response** — button click, number, or text
2. **Acknowledge briefly** — "Got it, going with Option A."
3. **Branch and execute** the chosen path
4. If unclear, ask again

### Handling text responses

Users sometimes type instead of clicking. Handle gracefully:
- "the first one" / "A" / "1" → map to first option
- "merge" → fuzzy match against option labels/values
- "actually, none of those" → present alternatives or ask what they want
- Unrelated message → the user moved on; drop the gate

## Formatting Guidelines

### Question line emoji prefix

Signal the decision type:
- 🔀 Routing/filing decisions
- ⚠️ Destructive/risky operations
- 🎯 Priority/triage decisions
- 💡 Creative/strategic forks
- 📋 Workflow/process choices
- 🔐 Credential/security decisions

### Context block

1-3 lines maximum. The user should understand the decision in under 5 seconds.

### Button/option labels

Format: `Action verb — brief qualifier`
- ✅ "Merge — combine with existing page"
- ✅ "Create new — separate meeting page"
- ❌ "Option 1"
- ❌ "Click here to merge the content into the existing brain page"

## Examples

### Cold-start phase gate
```
📋 **Phase 2: Google Contacts**

I can import your Google Contacts to seed the people/ directory.
This creates a brain page for each real contact (~200 pages).

1. **Import via ClawVisor** — secure credential gateway
2. **Import via direct OAuth** — simpler, agent holds tokens
3. **Import from Google Takeout export** — offline, from file
4. **Skip** — move to the next phase
```

### Filing decision
```
🔀 **Where should this go?**

Meeting notes from call with Jane Smith. She already has a page at
people/jane-smith.md and there's a deal page at deals/acme-corp.md.

1. **Merge into Jane's page** — add to her timeline
2. **Add to Acme deal page** — this was primarily a deal discussion
3. **New meeting page** — standalone at meetings/2026-01-15-jane-acme.md
4. **Skip** — don't file this
```

### Destructive operation
```
⚠️ **About to delete 847 stale cache files (2.3 GB)**

These haven't been accessed in 90+ days. They can be re-fetched
but that takes ~4 hours.

1. **Delete them** — free up space now
2. **Archive first** — upload to cloud storage, then delete
3. **Keep them** — no changes
4. **Show me the list** — let me review before deciding
```

## Integration With Other Skills

This pattern is used by:
- **cold-start** — phase gates for each import source
- **ingest** — routing decisions for ambiguous content
- **enrich** — merge vs create decisions for entity pages
- **brain-ops** — filing location decisions
- **meeting-ingestion** — where to file meeting notes
- **archive-crawler** — scan vs full ingestion gate

When building a new skill that needs user input at a decision point,
reference this pattern rather than inventing a new one.
