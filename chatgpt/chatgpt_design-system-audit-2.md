---
conversation_id: 69fbd4d8-920c-83e8-aa41-7b828467fc0a
created: 2026-05-06
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 11
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Design System Audit
type: essay
updated: 2026-05-07
---

# Design System Audit

**Related:** [[design_ux]]

> Conversation ID: 69fbd4d8-920c-83e8-aa41-7b828467fc0a
> Created: 2026-05-06T23:55:05Z
> Updated: 2026-05-07T00:56:54Z
> Messages: 11

---

## User

this is what claude design built us for our design system as we try to move forward with a more modern and polished design. its probably missing thingss that are new v1 shell in code has but dont exist here and vise versa. audit our app for the gaps and our current design language and help us get them aligned. We have one source of truth, so we want to figure out:
- what in here is covered, what's missing
- what in the new design in code is covered, what's missing
- looking at the actual app with production design of what's already been shipped, what is here and what's missing
- looking at everything that's in flight and what might be stale or abandoned
- looking generally at inconsistencies across it and hardening it
- looking at all the design systems and seeing if things should be consolidated or something
- if there's good ethos in the design md file that already exists that should be applied to this, or vice versa
- if there's anything that should be flagged
Let's have a back-and-forth conversation where you interview me about all the findings and all of the goals and stuff. We continue to work back and forth on this until we lock in a central source of truth for the design system. From there, we can develop a plan for what work actually needs to be handed off to an agent.

---

## Assistant

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
Profiles should feel designed vertically first.

---

# Things I strongly suspect are missing

Based on the files included, I suspect the design system is missing:

## Data density rules

You are building:
- artist CRM
- releases
- fan audiences
- ingestion systems
- ops tooling
- AI orchestration

That means eventually you become:
- partially Linear
- partially Airtable
- partially Superhuman
- partially Stripe Dashboard

I do not yet see evidence of:
- row density systems
- table interaction philosophy
- keyboard UX
- bulk selection patterns
- command surfaces
- split pane patterns
- inspector panel rules
- empty/loading/error states
- streaming AI states
- optimistic state rules
- notification/toast system spec
- AI conversation shell spec
- timeline/event feed spec

Those become critical very soon.

---

# I suspect `/exp/shell-v1` is ahead of the design system

Usually the code evolves faster than the docs.

I suspect:
- newer spacing conventions
- newer sidebar behaviors
- improved shell hierarchy
- better hover states
- better card density
- newer AI/chat primitives
- newer HUD concepts

exist in code but are not represented in this zip.

That means your design system risks becoming archival instead of canonical.

Very dangerous.

---

# Biggest strategic design risk for Jovie

You are currently blending 3 products:

| Product Type | Design Pressure |
|---|---|
| cinematic music brand | emotionally rich |
| operational dashboard | dense + fast |
| AI copilot | conversational |

Those naturally fight each other.

Most startups fail here by:
- over-cinematizing ops
- over-productifying artist identity
- over-chatifying workflows

You need a strict separation system.

My instinct:
- cinematic only at transition boundaries
- operational surfaces should become calmer over time
- AI should feel infrastructural, not “assistant-themed”

Meaning:
- less “AI cards”
- more “the system already handled it”

Very Apple.

---

# What I want to inspect next

I need visibility into 4 things:

## 1. Current production app screenshots
Especially:
- dashboard
- releases table
- audience table
- artist profile
- sidebar shell
- onboarding
- any AI/chat surface

---

## 2. `/exp/shell-v1`
I want to know:
- what improved
- what regressed
- what became abandoned
- what components only exist there

---

## 3. Current `DESIGN.md`
This is probably your real philosophy document.

I want to compare:
- philosophy
- tokens
- spacing
- motion
- hierarchy
- interaction constraints

against this Claude-generated package.

---

## 4. Your intended future product direction

This matters massively.

Right now the design system feels optimized for:
- release management
- profiles
- links
- artist surfaces

But your actual company trajectory is shifting toward:
- AI release ops
- agent orchestration
- growth automation
- audience intelligence
- operational infrastructure

That changes:
- density
- navigation
- interaction model
- layout philosophy
- AI surfaces

dramatically.

---

First questions:

1. Is `/exp/shell-v1` currently considered “better” internally than production?
2. Are you trying to converge marketing + app visually, or intentionally keep them distinct?
3. Do you want Jovie to eventually feel more like:
   - Apple Music for artists
   - Linear for music ops
   - AI operating system
   - artist CRM
   - autonomous release machine
4. What parts of the current shipped UI do you personally hate the most right now?
5. What parts already feel “correct” and emotionally aligned with the future brand?

---

## User

So agreed on the decision to not create a light mode. The shell V1 is definitely better. It's way better. It looks way more expensive and clean and modern and distinct to us. We're trying to convert marketing in an app generally and have made recent moves towards that, especially some of the inflate PRs or recent merges. We are still keeping the landing pages as a slightly different thing. They're a different language, but they're on the same foundation, so they'll use the same pill buttons and stuff. It's more like frame.io-inspired marketing pages with more generous spacing and whatnot, but still on the same language. The code has started to apply some of that on the home page and stuff. The zip package that I gave you has a lot of it, but yeah, they generally would probably get close unless there's a specific reason that they should be distinct in any one spot.
1. Numbers 3, kind of like linear for music ops AI operating system type thing with a stable or CRM as the audience. Everything should be minimal and understated on every screen. We have basically a hierarchy where it's pretty clear what the most important action is at any moment, but then there's depth and stuff to it. Using popovers on a contact to give them more context without having to flood a row with data, using icons over text when possible, batching things intelligently, pillow-shaped badges and stuff that stack and collapse and then expand on hover. Linear does a lot of that very well. Frame.io does interesting things on flyout menus where you hover over a link and it dims all the other links on the page and stuff. Some of those interactions are cool, some are a little gimmicky.
2. We have two sets of motion we're moving towards. One is our interaction-only motion that's like 150 ms or less and used very sparingly, and then one is our cinematic motion, which is used even more sparingly, which is only like sidebar opens or revealing a more. We have a music player reveal that comes out simply, and then there's a more complex version when you enable waveform that gives you more details and stuff. That's the whole ethos of it: very simple playback controls, but then you have the ability to go deeper.
3. I think the most stuff that kind of sucks is just disjointed right rails that generally need to be cleaned up and stuff. The density and rows and stuff needs to be done better. Many years are really good at this where they put a bunch of information side by side, but they still fit on a grid even in all states and stuff. That's a huge problem I see: things looking good in some states, within empty states or in data-heavy states, all of a sudden things don't line up and stuff.

---

## Assistant

I’ll treat Shell V1 as the winner, dark mode as canonical, and the Claude package as an input snapshot rather than the source of truth. I’m going to compare the uploaded package against repo reality and then come back with gaps plus the next interview questions.

---

## Assistant

The package is broader than I initially assumed: it includes tokens, shell components, marketing/profile UI kits, previews, and screenshots. First concrete finding: it still includes light-mode preview artifacts, which conflicts with the decision to make dark canonical.

---

## Assistant

I found the likely active repo candidates. I’m going to inspect the main app repo for design docs, Shell V1, tokens, and recent design PRs rather than guessing from the exported package alone.

---

## Assistant

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

## 6. Motion is close, but still slightly split

Your stated direction is:

- interaction motion: ≤150ms
- cinematic motion: sparse reveal-class motion

The repo already says the canonical taxonomy is:

- `subtle`: 150ms
- `cinematic`: 420ms fileciteturn9file0

The uploaded package still talks about one curve and raw 50/100/150/200/250/300ms durations.

Recommendation: keep the repo’s two-intent taxonomy and treat the uploaded package’s raw duration scale as legacy/supporting only.

---

# Main alignment decisions I’d lock now

## 1. Dark-only product mode

Decision:

**Dark is canonical. Light-mode code may exist only as noncanonical fallback/test debt.**

Action:

- remove light preview artifacts from design docs/package
- stop documenting light mode as equal
- annotate light tokens as “noncanonical / compatibility only”
- prevent agents from designing new light surfaces

## 2. Shell V1 becomes the app foundation

Decision:

**Shell V1 is the canonical app shell. Legacy shell becomes deprecated.**

Action:

- promote Shell V1 language into `DESIGN.md`
- update rollout matrix from “experimental V1” to “canonical app shell migration”
- identify every legacy shell/codepath still shipping
- map each flagged surface to “keep, migrate, delete, stale”

## 3. One source of truth hierarchy

I’d make this the hierarchy:

| Layer | Canonical file |
|---|---|
| Philosophy / taste / rules | `DESIGN.md` |
| Tokens | `apps/web/styles/design-system.css` |
| Token explanation | `docs/DESIGN_TOKENS.md` |
| Component contracts | new `docs/design-system/COMPONENT_CONTRACTS.md` |
| Surface inventory | new `docs/design-system/SURFACE_INVENTORY.md` |
| Deprecations | `docs/design-system/deprecation-map.md` |
| Rollout | `docs/DESIGN_V1_ROLLOUT_MATRIX.md` until migration complete |

The Claude design-system zip should become a **reference artifact**, not a source of truth.

## 4. Rows/tables need their own design contract

This is the biggest missing piece.

You need a canonical **Operational Row System**.

It should define:

- row height: compact / default / expanded
- column rhythm
- icon column behavior
- artwork/thumb column
- primary text + secondary metadata rules
- badge stacking/collapse rules
- status position
- right-side primary action
- hover actions
- popover disclosure
- selected state
- loading skeleton state
- empty state
- dense-data overflow
- mobile collapse pattern
- keyboard navigation
- bulk selection

Right now the design system has pills, shell, audio bar, sidebar, etc. It does not yet have enough rules for the thing your product will live inside every day: dense operational lists.

## 5. Right rails need one canonical pattern

Your complaint about disjointed right rails is probably the highest-impact cleanup.

Decision:

**Every right rail becomes one of three types:**

| Type | Use |
|---|---|
| Inspector | stable metadata/details for selected entity |
| Action Rail | suggested next actions / AI recommendations |
| Drawer | temporary deeper workflow or reveal |

Rules:

- right rail lives inside the app content card
- never creates a separate visual universe
- no route-local rail chrome
- same width scale
- same header treatment
- same collapse behavior
- same empty state
- same loading state
- same card rhythm

The repo already references `EntitySidebarShell` and `DrawerSurfaceCard` in `DESIGN.md`, which is the right direction. fileciteturn9file0

---

# Specific conflicts to resolve

## Conflict A: canonical width

Options:

1. **1298px** — current `DESIGN.md`, Linear parity, best for premium desktop composition.
2. **1280px** — current public-surface production doc.
3. **1200px** — uploaded package.
4. **1120px** — useful for narrower standard pages.
5. **680px** — prose only.

My vote:

- `--ds-public-content-max: 1298px`
- `--ds-page-content-max: 1120px` only for document/simple pages
- `--ds-prose-max: 680px`
- deprecate 1200 and 1280 unless there is a real production constraint

## Conflict B: marketing system split

Current docs say selling/explaining = System A, operating/using = System B. fileciteturn9file0

Your update says marketing and app should converge more than before, with landing pages slightly more Frame.io/editorial.

I’d revise:

- **Foundation is one system**
- **Modes are different**
  - product mode: compact, operational, Inter
  - editorial mode: generous, cinematic, Satoshi/DM Sans where needed
  - public profile mode: mobile-canonical, artwork-forward, product-native

This avoids “two design systems.”

## Conflict C: motion

Lock:

- `subtle = 150ms`
- `cinematic = 420ms`
- no springs
- no hover movement
- no third class unless explicitly approved

## Conflict D: accent color

Accent `#7170FF` should remain:

- focus rings
- active states
- selected links
- rare system state

It should not become:

- brand color
- CTA color
- decorative glow
- “make this look designed” color

---

# What should be flagged

## High priority

1. **Light mode artifacts still exist in docs/package.**
2. **Canonical width conflict: 1298 vs 1280 vs 1200 vs 1120.**
3. **Shell V1 is better but still appears governed as experimental.**
4. **Rows/tables lack a complete design contract.**
5. **Right rails need one shared rail/drawer/inspector taxonomy.**
6. **Claude package includes substitute fonts and snapshot components; it should not be blindly copied back into repo.**
7. **Too many docs can instruct agents differently.**

## Medium priority

1. Button variants still marked TBD in `DESIGN_TOKENS.md`. fileciteturn10file0
2. Public surface docs mention old width values. fileciteturn13file0
3. Raw motion durations still appear in package language.
4. Marketing/public/profile/app boundaries need cleaner naming.
5. “System A/System B” might be reinforcing separation you are now trying to reduce.

---

# My proposed central doctrine

This is the cleaned-up version I’d move toward:

> Jovie is a dark-first operational system for music releases, audience growth, and AI-assisted artist operations. The product should feel calm, dense, expensive, and inevitable. Linear is the operational baseline; Apple is the restraint baseline; Rekordbox is the music-ops reference; Frame.io informs editorial marketing motion and spacing. The foundation is shared across all surfaces. Product surfaces are compact and utility-first. Marketing surfaces are more spacious and cinematic, while still using the same primitives, tokens, buttons, and interaction rules.

---

# Next questions for you

1. For canonical content width, do you want to lock **1298px** as the master public/marketing width and demote 1280/1200/1120 to legacy/special cases?

2. For typography, should the app be **Inter everywhere**, with **Satoshi only for marketing/editorial/home hero**, or do you want Satoshi to enter more product surfaces?

3. For right rails, should the default app pattern be **persistent inspector rail** or **closed-until-needed drawer**?

4. For dense rows, do you prefer the primary row rhythm closer to **Linear issues** or closer to **music library/DSP catalog rows with artwork always visible**?

---

## User

1 yes, staoshi everywhere could be cool. closed until needed drawer
linear issues. album art can always show in a popover on hover with more details if its useful.

---

## Assistant

Locked: 1298px canonical width, Satoshi is worth exploring beyond marketing, drawers are closed until needed, and rows should bias toward Linear issue density rather than music-library artwork rows. I’ll check the repo’s font and row/drawer patterns next so the recommendation maps to actual files.

---

## Assistant

Satoshi is already globally loaded next to Inter in `app/layout.tsx`, while the body still defaults to `font-sans`/Inter. That makes a Satoshi-first experiment cheap: mostly token/class policy, not font infrastructure.

---

## Assistant

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
| Tokens | `apps/web/styles/design-system.css` |
| Token docs | `docs/DESIGN_TOKENS.md` |
| Migration state | `docs/DESIGN_V1_ROLLOUT_MATRIX.md` |
| Deprecations | `docs/design-system/deprecation-map.md` |
| Public/marketing consolidation | `docs/design-system/public-surface-consolidation.md` |

But the docs need cleanup because the repo still has conflicting width language: public-surface consolidation says current widths include 1280/1120/680, while `DESIGN.md` says 1298/680. fileciteturn13file0

---

# Agent handoff direction

Give this to the design-system agent:

```text
Audit and update the Jovie design system so Shell V1 becomes the canonical app foundation.

Locked decisions:
- Dark mode is canonical. Light mode is compatibility/fallback only and should not be presented as an equal design target.
- 1298px is the canonical public/marketing content width. 680px is the prose exception. Deprecate 1200/1280/1120 as default content widths unless explicitly documented as legacy or special-case.
- Explore Satoshi as the default product font across app shell, rows, buttons, pills, badges, marketing, and public surfaces. Inter may remain only where Satoshi harms dense readability.
- App pattern is closed-until-needed drawer, not persistent right rail.
- Rows should follow Linear issue density, not music-library rows. Album art should appear in hover previews/popovers or drawers, not as a default permanent column.
- Motion has two intents only: subtle 150ms and cinematic 420ms.
- Accent color is for focus, active, selected, and rare system state. It is not brand decoration or CTA color.

Tasks:
1. Update DESIGN.md to reflect these decisions clearly.
2. Update docs/DESIGN_TOKENS.md if token docs conflict with these decisions.
3. Update docs/design-system/public-surface-consolidation.md to remove width drift and mark old widths as deprecated/special-case.
4. Update docs/design-system/deprecation-map.md with legacy widths, legacy right rails, persistent rails, route-local drawers, artwork-first rows, and light-mode design artifacts.
5. Create a new docs/design-system/OPERATIONAL_ROWS.md defining canonical row density, grid, metadata, badges, hover actions, popover previews, selected states, empty/loading states, mobile collapse, and drawer behavior.
6. Create or update a drawer/inspector contract doc defining preview popover, detail drawer, workflow drawer, and cinematic drawer.
7. Search for route-local right rails, persistent inspector panels, duplicated drawer chrome, route-local widths, raw motion durations, and direct font overrides.
8. Produce a migration checklist sorted by highest visual leverage first: shell, drawers/right rails, rows/tables, typography, public/marketing width, motion cleanup.
9. Do not blindly import the uploaded Claude package. Treat it as a reference snapshot only. Repo tokens and Shell V1 reality win.
```

# Next thing to lock

Satoshi everywhere is the only decision that needs visual validation.

I’d run one fast design spike:

- app shell
- releases table
- audience/contact table
- drawer
- homepage hero
- public profile

Same screenshots, Inter vs Satoshi. Then pick.


**Topic:** [[chatgpt-clusters/design_ux]]
