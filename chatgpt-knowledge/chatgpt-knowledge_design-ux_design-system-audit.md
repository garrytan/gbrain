---
title: "Design System Audit"
type: guide
created: 2026-05-06
updated: 2026-05-06
source: chatgpt-export
topic: design-ux
message_count: 11
tags: [chatgpt, knowledge, design-ux]
---
# Design System Audit

> **Source:** ChatGPT conversation
> **Date:** 2026-05-06T23:55:05Z
> **Messages:** 11
> **Topic:** design-ux

## Question

this is what claude design built us for our design system as we try to move forward with a more modern and polished design. its probably missing thingss that are new v1 shell in code has but dont exist here and vise versa. audit our app for the gaps and our current design language and help us get them aligned. We have one source of truth, so we want to figure out:
- what in here is covered, what's missing
- what in the new design in code is covered, what's missing
- looking at the actual app with production design of what's already been shipped, what is here and what's missing
- looking at everything that's in flight and what might be stale or abandoned
- looking generally at inconsistencies across it and hardening it
- looking at all the design systems and seeing if things should be consolidated or something
- if there's good ethos in the design md file that already exists that should be applied to this, or vice versa
- if there's anything that should be flagged
Let's have a back-and-

## Answer

Initial audit from the uploaded design system package:

## What this package already does well

The strongest thing here is that it already has a coherent philosophy.

It is not “just components.” It already defines:

- surface taxonomy (`marketing`, `app shell`, `public profile`)
- typography hierarchy
- motion philosophy
- interaction philosophy
- anti-patterns
- semantic naming vocabulary
- tone constraints
- component naming conventions
- token-first architecture

That is the correct foundation.

A lot of startups skip this and end up with “Tailwind soup.” You are much further ahead than most YC-stage teams.

The “Apple meets Rekordbox + Linear density” framing is also unusually coherent. It creates a useful constraint system.

---

# Immediate red flags / likely drift areas

Even without seeing the live repo yet, I can already infer a few probable problems.

## 1. There are currently too many “sources of truth”

Right now you likely have:

| Source | Risk |
|---|---|
| `DESIGN.md` | philosophy drift |
| Claude-generated design system zip | snapshot drift |
| actual shipped app | reality drift |
| `/exp/shell-v1` | experimental drift |
| marketing homepage | separate visual language |
| in-flight agent branches | component divergence |
| Tailwind utility usage | token bypassing |

You need:
- ONE philosophy source
- ONE token source
- ONE component source
- ONE motion source
- ONE layout grid source

Everything else becomes downstream artifacts.

---

# Biggest conceptual issue I already see

This line is extremely important:

> “No decorative brand color”

But later:

> `--app-accent: #7170FF`

This is probably already causing drift.

You likely currently have:
- some places using accent as semantic focus
- some places using it as CTA
- some places using white pills
- some places using gradient purple glow
- some places using “Linear purple”
- some places using status colors too aggressively

This usually spirals over time.

I want to lock this down carefully.

---

# Strong things I think should remain canonical

These are good and should probably survive long-term:

## Canonical principles

### 1. Dark-first
Correct for:
- DJs
- nightlife
- artwork
- cinematic presentation
- album-art-centric UI
- OLED/mobile feel

I would strongly resist introducing a true first-class light mode right now.

Keep “light mode exists technically” separate from “light mode is canonical.”

---

### 2. Pill-first interaction language

This is good.

It creates:
- recognizability
- softness
- premium feel
- modernity
- consistency

You should standardize:
- all heights
- all padding
- all icon spacing
- all hover states
- all focus rings

Right now I guarantee those vary.

---

### 3. Minimal motion system

Very good.

The industry is overusing:
- springs
- blur explosions
- floating cards
- Framer-motion bloat

Your restraint is an advantage.

---

### 4. Mobile-canonical profile philosophy

Very correct.

Most music traffic is mobile.
Profiles should feel desi

*(Answer truncated — 6516 chars total)*

## Question

So agreed on the decision to not create a light mode. The shell V1 is definitely better. It's way better. It looks way more expensive and clean and modern and distinct to us. We're trying to convert marketing in an app generally and have made recent moves towards that, especially some of the inflate PRs or recent merges. We are still keeping the landing pages as a slightly different thing. They're a different language, but they're on the same foundation, so they'll use the same pill buttons and stuff. It's more like frame.io-inspired marketing pages with more generous spacing and whatnot, but still on the same language. The code has started to apply some of that on the home page and stuff. The zip package that I gave you has a lot of it, but yeah, they generally would probably get close unless there's a specific reason that they should be distinct in any one spot.
1. Numbers 3, kind of like linear for music ops AI operating system type thing with a stable or CRM as the audience. Everyt

## Answer

I’ll treat Shell V1 as the winner, dark mode as canonical, and the Claude package as an input snapshot rather than the source of truth. I’m going to compare the uploaded package against repo reality and then come back with gaps plus the next interview questions.

## Answer

The package is broader than I initially assumed: it includes tokens, shell components, marketing/profile UI kits, previews, and screenshots. First concrete finding: it still includes light-mode preview artifacts, which conflicts with the decision to make dark canonical.

## Answer

I found the likely active repo candidates. I’m going to inspect the main app repo for design docs, Shell V1, tokens, and recent design PRs rather than guessing from the exported package alone.

## Answer

Mr. White, agreed. I’d lock the direction this way:

# Current decision stack

## Canonical taste target

**Linear for music ops + AI operating system.**

That means:

- dense, calm, operational
- music-native, but not “music app cosplay”
- understated hierarchy
- one obvious primary action per region
- deep context available through hover, popover, drawer, inspector, or expansion
- icons and pills compress information
- rows must survive sparse, normal, and dense data states without breaking alignment

This should become the master lens for every design-system decision.

---

# What I found so far

## 1. The repo already says the right things

The root `DESIGN.md` is strong and mostly aligned with your stated taste. It already defines Jovie as:

> “Linear.app March 2026 UI refresh, evolved with Jovie’s own identity,” with an “Apple meets Rekordbox” dark-first aesthetic. fileciteturn9file0

It also already contains the most important design principle:

> “The restraint is the brand.” fileciteturn9file0

That should survive.

## 2. The token doc already claims one source of truth

`docs/DESIGN_TOKENS.md` says the single source of truth is:

`apps/web/styles/design-system.css` fileciteturn10file0

That is the correct architecture.

But in practice, the repo also has:

- `DESIGN.md`
- `docs/DESIGN_TOKENS.md`
- `docs/DESIGN_V1_ROLLOUT_MATRIX.md`
- `docs/design-system/deprecation-map.md`
- `docs/design-system/public-surface-consolidation.md`
- `apps/web/styles/design-system.css`
- `apps/web/styles/theme.css`
- `apps/web/styles/linear-tokens.css`
- Claude/GStack design skills
- the uploaded Claude design-system package

That is too many “truth-adjacent” places.

## 3. Design V1 is already treated as an experimental rollout

The rollout matrix confirms Shell V1 and surface-specific flags are intentionally staged: `SHELL_CHAT_V1`, `DESIGN_V1_RELEASES`, `DESIGN_V1_TASKS`, `DESIGN_V1_CHAT_ENTITIES`, `DESIGN_V1_LIBRARY`, etc. fileciteturn11file0

That matches your point: Shell V1 is better, but not necessarily fully promoted into the canonical docs/codepaths everywhere yet.

## 4. The repo already has a deprecation map

Good sign. It explicitly tracks stale public wrappers, CTA duplication, auth duplication, route-local shell chrome, and token drift. fileciteturn12file0

This means the system is not starting from chaos. It needs consolidation and enforcement.

## 5. Public/marketing width is inconsistent

This is a real conflict.

`DESIGN.md` says canonical marketing/public width is **1298px**. fileciteturn9file0

`docs/design-system/public-surface-consolidation.md` says current canonical widths are:

- landing: **1280px**
- page: **1120px**
- prose: **680px** fileciteturn13file0

The uploaded package README says **1200px**.

That needs one final decision.

My recommendation: **1298px for premium marketing/product storytelling, 680px for prose, no 1200/1280/1120 drift except explicitly named legacy aliases.**

## 6. Motion is close, but

*(Answer truncated — 10088 chars total)*

## Question

1 yes, staoshi everywhere could be cool. closed until needed drawer
linear issues. album art can always show in a popover on hover with more details if its useful.

## Answer

Locked: 1298px canonical width, Satoshi is worth exploring beyond marketing, drawers are closed until needed, and rows should bias toward Linear issue density rather than music-library artwork rows. I’ll check the repo’s font and row/drawer patterns next so the recommendation maps to actual files.

## Answer

Satoshi is already globally loaded next to Inter in `app/layout.tsx`, while the body still defaults to `font-sans`/Inter. That makes a Satoshi-first experiment cheap: mostly token/class policy, not font infrastructure.

## Answer

Locked.

# Updated canonical decisions

## 1. Width

**1298px is canonical.**

Use:

- `--ds-public-content-max: 1298px`
- prose exception: `680px`
- route/page exceptions only when explicitly documented

Deprecate:

- 1200px from uploaded package
- 1280px from older public-surface docs
- 1120px as a default public width

The current repo already says 1298px in `DESIGN.md`, so this is mostly cleanup and enforcement. fileciteturn9file0

---

## 2. Typography

**Explore Satoshi everywhere.**

Important repo finding: Satoshi is already globally loaded in `apps/web/app/layout.tsx` alongside Inter. The body currently still uses `font-sans`, so this is probably a policy/token change, not infra work. fileciteturn17file0

My recommendation:

| Surface | Font |
|---|---|
| App shell | Satoshi |
| Tables / rows | Satoshi |
| Buttons / pills / badges | Satoshi |
| Marketing | Satoshi |
| Long-form prose | maybe Inter or DM Sans if Satoshi hurts readability |
| Code / IDs / technical metadata | mono where needed |

This could make Jovie feel more ownable. Inter is clean, but it makes the app feel more like every other Linear-inspired SaaS. Satoshi everywhere may give it more editorial premium character without getting goofy.

Risk: Satoshi at 12–13px can feel slightly less utilitarian than Inter. Test it on dense rows before fully committing.

---

## 3. Right rail / drawer

**Closed-until-needed drawer is canonical.**

Default behavior:

- no persistent right rail
- selected row opens drawer only when user asks for depth
- hover/popover gives lightweight context
- drawer gives full context/actions
- no route-local right rail chrome

This fits your “minimal until deeper” product ethos.

Canonical drawer types:

| Type | Trigger | Purpose |
|---|---|---|
| Preview popover | hover/focus | fast context, album art, metadata, status |
| Detail drawer | click row / detail affordance | entity details and actions |
| Workflow drawer | explicit action | edit, schedule, configure, approve |
| Cinematic drawer | rare reveal | music player / waveform / major mode expansion |

---

## 4. Rows

**Linear issues are the baseline. Album art should not be a permanent column.**

Canonical row philosophy:

- rows are text-first and grid-aligned
- artwork is available through hover preview/popover
- icons compress status and entity type
- badges are pill-shaped, small, collapsible
- hover reveals actions
- click opens detail drawer
- dense states keep the same column grid
- empty/sparse states still align to the same rhythm

For music-specific rows, album art becomes:

- small optional icon/thumb only where absolutely necessary
- hover preview by default
- drawer hero artwork when opened
- never the thing that forces every row to become a music-library row

This is the correct call for “Linear for music ops.”

---

# Revised source-of-truth structure

I’d tell agents to converge around this:

| Purpose | Canonical file |
|---|---|
| Taste / philosophy | `DESIGN.md` |
| Tok

*(Answer truncated — 6148 chars total)*
