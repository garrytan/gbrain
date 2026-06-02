---
conversation_id: 6a0a0b28-92b0-83e8-8cba-8fa234fc2734
created: 2026-05-17
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 3
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Pitch Deck Integration Plan
type: guide
updated: 2026-05-17
---

# Pitch Deck Integration Plan

**Related:** [[business_startup]]

> Conversation ID: 6a0a0b28-92b0-83e8-8cba-8fa234fc2734
> Created: 2026-05-17T18:38:33Z
> Updated: 2026-05-17T18:42:42Z
> Messages: 3

---

## User

this is our current putch deck
i ran out of claude code usage for the week and need to finish the deck. They're notoriously stingy with it because it's a research-only product right now. There's not really an option to get additional usage. But basically im gonna have claude code keep building it but I also want to take this opportunity to have it integrated where the deck on the investor site displays from this. We have, in the design studio that we already have, a preview of it where I can cleanly see it and then spin up a hot reloading, working locally, to iterate on it. SO just give me the prompt. The key thing is I want it to adopt our design system and still look solid and reuse what it can as possible. It'd still look like a deck and be able to export a PDF that looks correct. I'd also love for us to be able to build it in a way where, when you view it on the investor site, you get interactive versions of it. On the product page or something, we could use an actual chat interface and then just animate through showing how it works. Might be a cool move. Might also be a bad move. I don't know, but either way it would still have a download of a static PDF.

Let me know what you think about that plan and then generally give me the handoff prompt for Claude. 



Fetch this design file, read its readme, and implement the relevant aspects of the design. https://api.anthropic.com/v1/design/h/XjqZCr74VPF-lrVGzJoBfg?open_file=Jovie+Pitch+Deck.html
Implement: Jovie Pitch Deck.html



---

## Assistant

Mr. White, I’ll assess the deck integration plan, check whether the design link is accessible, and produce a Claude-ready handoff prompt with clear acceptance criteria for design-system reuse, local iteration, investor-site embedding, interactivity, and reliable PDF export.

---

## Assistant

Mr. White, the plan is solid with one caveat: keep **one canonical deck source**, then render it in multiple modes.

Best structure:

1. **Deck source of truth**
   - Slide content lives in structured data/components.
   - Same source renders:
     - design-studio preview
     - investor-site interactive deck
     - static PDF export

2. **Design-system adoption**
   - Convert the current HTML deck into your existing Jovie visual language.
   - Reuse tokens, typography, spacing, buttons, cards, badges, chat components, layout primitives.
   - Avoid creating a second one-off deck design system.

3. **Interactive investor-site version**
   - Good idea, especially for product/demo slides.
   - The investor site can show enhanced interactive slides: chat UI, animated product flows, staged typing, before/after states.
   - PDF export should freeze those moments into polished static slides.
   - Keep the PDF as the investor-safe artifact. The interactive version is upside, not the dependency.

4. **PDF export**
   - Use Playwright or the existing site tooling to render the deck route in print mode.
   - Disable animations in print mode.
   - Ensure exact 16:9 sizing, correct fonts, image loading, page breaks, and static fallbacks for interactive states.

I tried to inspect the Anthropic design URL directly, but it was not accessible from here. The prompt below assumes Claude Code has access or can fetch it inside your environment.

---

## Handoff prompt for Claude Code

```text
You are working in the Jovie codebase. I need you to finish and integrate the current pitch deck into our existing product/design system and investor-site workflow.

Design file to fetch:
https://api.anthropic.com/v1/design/h/XjqZCr74VPF-lrVGzJoBfg?open_file=Jovie+Pitch+Deck.html

Implement:
Jovie Pitch Deck.html

Primary goal:
Turn the provided “Jovie Pitch Deck.html” into a first-class deck experience inside our repo. It should look like a polished investor deck, adopt our existing Jovie design system, be previewable/hot-reloadable in the existing design studio, render on the investor site, and export a static PDF that looks correct.

Important context:
- We already have a design studio / preview environment.
- We want to be able to iterate locally with hot reloading.
- The deck should reuse as much existing UI/design-system code as possible.
- The investor site should be able to display the deck.
- The static PDF download must remain high-quality and investor-safe.
- Website-only interactivity is welcome where it adds value, especially on product/demo slides.
- Interactive slides should degrade cleanly into static PDF slides.

Process:
1. Inspect the repo structure first.
   - Find the existing design system.
   - Find design tokens, typography, color, spacing, layout primitives, card components, buttons, badges, chat/product UI components, and existing investor-site pages.
   - Find the design studio / preview routes and the local dev/hot-reload setup.
   - Find any existing PDF export, print, or Playwright/Puppeteer tooling.

2. Fetch and read the design file.
   - Fetch the provided Anthropic design file.
   - Read any README or design instructions included with it.
   - Open and inspect `Jovie Pitch Deck.html`.
   - Identify the slide count, structure, content, layout intent, visual motifs, assets, typography, and any embedded styling.
   - Preserve the substantive deck content unless there is an obvious typo or rendering issue.

3. Implement the deck using our codebase conventions.
   - Do not leave the pitch deck as a standalone raw HTML file if the app is React/Next/etc.
   - Convert it into reusable app components that fit the repo.
   - Prefer a data-driven slide model where practical.
   - Use the existing Jovie design system instead of introducing a parallel CSS/design system.
   - Reuse existing components for:
     - typography
     - buttons
     - cards
     - badges/pills
     - device/product mockups
     - chat UI
     - gradients/backgrounds
     - navigation/header/footer where applicable
   - Add only the minimum custom styling needed for deck-specific composition.

4. Build a canonical deck source.
   - The same source should support:
     - design-studio preview
     - investor-site web rendering
     - PDF export
   - Avoid duplicating slide content across multiple files.
   - If needed, create a structure similar to:
     - `src/deck/joviePitchDeck/slides.ts`
     - `src/deck/joviePitchDeck/JoviePitchDeck.tsx`
     - `src/deck/joviePitchDeck/components/*`
     - `src/deck/joviePitchDeck/export/*`
   - Adapt paths to match the actual repo conventions.

5. Add design-studio preview.
   - Add a route/page/view inside the existing design studio for the pitch deck.
   - It should hot reload during local development.
   - Include a clean preview mode where I can:
     - see slides one at a time
     - navigate previous/next
     - optionally see slide thumbnails or slide numbers
     - view full-screen-ish 16:9 slides
   - Preserve the deck aspect ratio.
   - The design studio preview should be useful for iteration.

6. Add investor-site integration.
   - Find the investor site/page/route.
   - Add a deck section or deck route using the same deck source.
   - It should support:
     - embedded interactive deck viewing
     - clean navigation
     - a static PDF download CTA
   - Do not break existing investor-site styling.
   - Match the Jovie design language.

7. Add interactive web-only enhancements where appropriate.
   - Product/demo slides may use live-feeling interactive components.
   - Use scripted deterministic animations, not real LLM calls.
   - Good candidates:
     - chat interface showing how Jovie works
     - animated message sequence
     - search/match flow
     - profile/contact enrichment flow
     - talent/customer workflow
     - before/after product state
   - Keep these subtle, polished, and optional.
   - Use `prefers-reduced-motion` and provide non-animated fallback.
   - In PDF/print mode, render a stable static state instead of animations.
   - Do not let interactivity make the core deck harder to read.

8. Add PDF export.
   - Implement or wire up a PDF export flow.
   - Prefer Playwright if no existing tool exists.
   - Render the same deck in a dedicated print/export mode.
   - Requirements:
     - exact 16:9 slide pages
     - correct fonts
     - correct colors/backgrounds
     - images loaded before export
     - no clipped content
     - no accidental browser chrome
     - no interactive controls in the PDF
     - animations disabled/frozen
     - each slide starts on its own PDF page
   - Add print CSS or export-specific styles as needed.
   - Output should be something like:
     - `public/Jovie-Pitch-Deck.pdf`
     - or the repo’s existing static asset location
   - Add an npm/pnpm script if appropriate, for example:
     - `pnpm deck:pdf`
     - `pnpm export:pitch-deck`
   - Wire the investor-site download button to the generated PDF path.

9. Make the deck visually strong.
   - It should still feel like a pitch deck, not a generic website page.
   - Use strong slide hierarchy:
     - clear headlines
     - concise supporting copy
     - large numbers/metrics where present
     - deliberate whitespace
     - consistent slide grid
     - Jovie brand styling
   - Keep slides readable at presentation distance.
   - Avoid tiny text.
   - Avoid over-animating.
   - Ensure dark/light surfaces, gradients, and cards match the rest of Jovie.

10. Preserve content but improve implementation quality.
   - Do not rewrite the business story unless necessary.
   - Fix obvious spelling/formatting issues.
   - Normalize punctuation, capitalization, spacing, and alignment.
   - Make slide titles consistent.
   - Keep any confidential/investor content intact.
   - If the HTML design file contains assets, import them properly into the repo.

11. Testing and validation.
   - Run the relevant commands:
     - install/build if needed
     - typecheck
     - lint
     - test, if available
   - Validate the local design-studio deck route.
   - Validate the investor-site deck route.
   - Generate the PDF.
   - Check the generated PDF visually for:
     - page sizing
     - text clipping
     - missing images
     - bad page breaks
     - incorrect colors
     - missing static states for interactive slides
   - If the repo supports screenshots/visual regression, add or update screenshots for the deck.

12. Deliverables.
   - Integrated deck components.
   - Design-studio preview route.
   - Investor-site deck integration.
   - Static PDF export script.
   - Generated static PDF asset if appropriate for this repo.
   - Any necessary documentation in the README or relevant docs.

Implementation preferences:
- Prefer existing components and tokens over custom CSS.
- Keep the deck maintainable.
- Use semantic component names.
- Keep slide content easy to edit.
- Avoid global CSS leakage.
- Avoid hardcoded magic numbers where existing tokens work.
- Add comments only where they clarify non-obvious export/print behavior.
- Do not introduce heavy dependencies unless necessary.
- If adding a dependency for PDF export, justify it and prefer a standard lightweight approach already compatible with the repo.

Suggested architecture:
- `JoviePitchDeck` component with modes:
  - `mode="studio"`
  - `mode="investor"`
  - `mode="print"`
- Shared slide registry:
  - slide id
  - title
  - component
  - optional PDF/static state
  - optional interactive web state
- Deck shell:
  - 16:9 slide viewport
  - consistent slide padding/grid
  - print-safe page wrapper
- PDF route:
  - dedicated route that renders all slides stacked as pages
  - no controls
  - no animations
  - print/export CSS
- Interactive route:
  - slide-by-slide navigation
  - optional animated product demo components
- Design studio route:
  - easy local iteration
  - navigation and preview controls

Acceptance criteria:
- The deck is implemented from `Jovie Pitch Deck.html`.
- The README/design instructions from the fetched design file have been read and followed where relevant.
- The deck visually matches Jovie’s design system.
- The deck is available in the design studio with hot reloading.
- The investor site can display the deck.
- The investor site has a working static PDF download.
- The PDF export is clean, 16:9, correctly paginated, and visually accurate.
- Interactive website-only elements have static PDF fallbacks.
- The implementation reuses existing components/tokens wherever practical.
- Lint/typecheck/build pass, or any failures are documented with clear reasons.

Before making large changes:
- Briefly summarize the repo findings:
  - where the design system lives
  - where the design studio lives
  - where the investor site lives
  - how the deck will be integrated
Then implement.

After implementation:
- Summarize exactly what changed.
- List the new routes/scripts/files.
- Include how to run locally.
- Include how to generate the PDF.
- Include any remaining caveats.
```

I’d use that prompt as-is. The key strategic constraint is: **same deck source, multiple render modes**. That keeps this from turning into three separate implementations that drift apart.


**Topic:** [[chatgpt-clusters/business_startup]]
