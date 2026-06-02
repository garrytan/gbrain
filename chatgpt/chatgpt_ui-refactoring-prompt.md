---
title: "UI Refactoring Prompt"
type: guide
created: 2026-02-10
updated: 2026-02-10
source: chatgpt-export
conversation_id: 698badee-3244-8326-be4b-ed846a3da4ed
message_count: 2
tags: [chatgpt, import, code]
---
# UI Refactoring Prompt

> Conversation ID: 698badee-3244-8326-be4b-ed846a3da4ed
> Created: 2026-02-10T22:16:19Z
> Updated: 2026-02-10T22:16:46Z
> Messages: 2

---

## User

I’m interested in situations where we have say a sidebar right drawer on 5 different dashboard pages but 2 use one actions buttons and 2 use another and then one just has inline buttons but they effectively are the same thing. The issue is that they might not be identical styles but they SHohe. But because they’re two or three styles ai refactoring doesn’t conform them it’s just creates multiple props for a shared component or something. 

What’s a good prompt to identify things that SHOULD look identical and SHOULD function identical but don’t and get them refactored to one and have the ai use context and thinking to pick the better style that fits our design system. It may even need to tweak that style once done.

---

## Assistant

Mr. White — here are a few “copy/paste-ready” prompt patterns that work well for this exact problem (UI variants that *should* be the same but drifted), and that push the model to (1) detect equivalence, (2) choose a canonical pattern from your design system, and (3) refactor without inventing a million props.

## Prompt template (best all-around)

**Use this when you can give the AI your design-system rules + the 5 pages (or repo paths).**

```text
You are a senior design-systems engineer + staff frontend engineer.

Goal:
Find UI patterns that SHOULD be visually identical and functionally identical across pages, but currently aren’t. Then refactor to ONE canonical implementation that conforms to our design system.

Context you must use:
- Design system tokens/components: <paste docs or summary here>
- “Canonical” components we already have: <list them>
- Accessibility + keyboard + focus requirements: <paste>
- Routing/state conventions: <paste>
- 5 target pages / components:
  1) <path or code>
  2) <path or code>
  3) <path or code>
  4) <path or code>
  5) <path or code>

What to do:
1) Inventory: Identify all instances of the “sidebar right drawer” and its action areas across these pages. Include screenshots descriptions only if necessary; otherwise be code-specific.
2) Equivalence detection: Group instances by “intent” (same user goal), NOT by current implementation. Explain why they should be the same.
3) Pick a canonical pattern:
   - Prefer existing design-system components and tokens.
   - If multiple patterns exist, choose the one that best fits the design system and is most maintainable.
   - If none are correct, propose the smallest design-system-aligned tweak to create the canonical one.
4) Refactor plan:
   - Create/adjust a single shared component (or composition) that eliminates divergence.
   - Do NOT solve by adding lots of boolean props to satisfy every variation.
   - Prefer composition (slots/children), small subcomponents, or a config object with strict typing over many props.
5) Implementation:
   - Provide the final component API.
   - Show code diffs for each of the 5 pages migrating to the canonical component.
   - Remove dead styles and redundant components.
6) Quality gates:
   - Ensure identical behavior: click handlers, loading/disabled states, validation, analytics events, keyboard nav, focus trap (if drawer), and escape-to-close behavior.
   - Ensure identical visuals: spacing, typography, icon usage, button hierarchy, and alignment per tokens.
   - Call out any behavior differences that must remain and justify them explicitly.

Output format:
- “Findings” (groups + evidence)
- “Canonical decision” (why this pattern)
- “New component API”
- “Migration diffs”
- “Checklist of parity tests”
```

## A stricter variant that prevents “prop explosion”

```text
Same task as above, but with a hard constraint:
You are not allowed to add more than 6 props to the shared component. If you need variability, you MUST use composition:
- children slots (Header, Body, Footer)
- render props for action groups
- or a typed config object with at most 6 top-level keys.
Explain how your solution avoids divergence long-term.
```

## “Choose the better style” selector prompt (forces design-system-first)

```text
When multiple existing styles compete, pick the canonical one using this rubric in order:
1) Closest match to design system components/tokens
2) Strongest accessibility + interaction states
3) Most consistent with other dashboards
4) Lowest maintenance cost
5) Minimal visual change to users

State the winner and why. Then refactor everything to match it.
If the winner still violates the design system, propose the smallest token/component change needed and apply it consistently.
```

## What you should provide to make this work *really* well
- A short “design system excerpt” (tokens, button hierarchy rules, drawer layout rules, spacing scale).
- The 5 component files (or paths + relevant code).
- Any “don’t change” constraints (e.g., analytics event names, API contracts).

If you paste your design-system button hierarchy rules (even just: primary/secondary/tertiary + when to use), I can tighten the prompt further so the model reliably picks the right canonical action layout and doesn’t invent variants.
