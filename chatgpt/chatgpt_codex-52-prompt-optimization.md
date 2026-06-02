---
title: "Codex 5.2 Prompt Optimization"
type: guide
created: 2026-01-16
updated: 2026-01-16
source: chatgpt-export
conversation_id: 696a81e6-a9ac-8333-8dc4-2fec91f66084
message_count: 2
tags: [chatgpt, import, code]
---
# Codex 5.2 Prompt Optimization

> Conversation ID: 696a81e6-a9ac-8333-8dc4-2fec91f66084
> Created: 2026-01-16T18:23:34Z
> Updated: 2026-01-16T18:24:19Z
> Messages: 2

---

## User

Improve this prompt and optimize it for codex 5.2

go to linear.app
find Plan the present. Build the future.

copy that footer CTA section and scan all its styles and match our footer cta section to that exactly.

use puppeteer mcp to compare them. once done go back and compare them and tweak until they are identical. verify you work at the end and make sure it passes lint and typecheck

Ask all clarifying questions up front and run as long as needed to get this accomplished. When done go back and simplify your code and ensure proper coding standards, minimal code duplication and proper atomic design and organization.

---

## Assistant

Mr. White — here’s a tighter, Codex 5.2–optimized prompt that’s explicit about goals, constraints, and a reliable workflow, while keeping your “ask clarifiers first” instruction.

```text
You are Codex 5.2 operating in a repo with TypeScript + React (or Next.js). Your job is to make our site’s Footer CTA visually match the Footer CTA on linear.app that contains the text: “Plan the present. Build the future.”

Goal
- Recreate Linear’s footer CTA section in our codebase so that, when rendered at common breakpoints (mobile, tablet, desktop), it is visually indistinguishable from Linear’s version.

Rules
1) Ask ALL clarifying questions up front, then proceed without further questions unless blocked by missing info.
2) Use Puppeteer (MCP) to:
   - Navigate to linear.app and locate the footer CTA that includes “Plan the present. Build the future.”
   - Capture computed styles and DOM structure relevant to that section.
   - Capture screenshots at multiple viewport sizes.
   - Do the same for our Footer CTA.
   - Produce a comparison report (screenshots + key computed-style diffs).
3) Implement changes in our Footer CTA to match Linear exactly:
   - Typography (font family, weight, size, line height, letter spacing)
   - Spacing (padding/margins/gaps)
   - Colors/gradients/backgrounds/borders/shadows
   - Layout (grid/flex settings, alignment, max-widths)
   - Button styling + hover/focus/active states
   - Responsive behavior across breakpoints
4) Iterate: run the Puppeteer comparison, tweak, rerun until the diffs are effectively zero (pixel-level where feasible).
5) Do NOT copy/paste Linear’s HTML/CSS verbatim. Recreate the look using our components/tokens/utilities.
6) When finished:
   - Run lint and typecheck and ensure they pass.
   - Refactor/simplify: minimize duplication, follow our coding standards, and keep atomic design organization (atoms/molecules/organisms) where applicable.
   - Provide a short final verification summary: what changed, commands run, and evidence (paths to screenshots + diff report).

Deliverables
- Updated Footer CTA component(s) in our codebase.
- Puppeteer MCP script(s) used for style extraction + screenshot diffing.
- A final “before vs after” screenshot set at the agreed viewports.
- Confirmation that lint and typecheck pass.

Before you start: Clarifying questions (ask now)
- What is the exact path/component name for our Footer CTA?
- What styling system do we use (Tailwind, CSS Modules, styled-components, vanilla-extract, etc.)?
- Do we have a design token system (colors/spacing/typography), and should you prefer it over raw values?
- What viewports/breakpoints should we validate (suggest: 375x812, 768x1024, 1440x900)?
- What command(s) should you use for lint and typecheck in this repo?
- Are there any constraints on adding new dependencies or using Playwright instead of Puppeteer?
```

If you want it even more “hands-off,” tell Codex the repo stack (Next.js/Tailwind/etc.) and your lint/typecheck commands, and it can skip the uncertainty and move faster.
