---
title: "Design Improvement Prompt"
type: note
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
conversation_id: 69ebbf02-9928-83e8-8a5a-b4d643f8d97a
message_count: 2
tags: [chatgpt, import]
---
# Design Improvement Prompt

> Conversation ID: 69ebbf02-9928-83e8-8a5a-b4d643f8d97a
> Created: 2026-04-24T19:06:18Z
> Updated: 2026-04-24T19:35:07Z
> Messages: 2

---

## User

this page has design that is half there. some sections look amaing most look half baked. inspect it thoroughly section by seciton and then give me a prompt for claude code to improve it

---

## Assistant

Mr. White, here’s a Claude Code prompt you can paste directly:

:::writing{id="92847" variant="standard"}
You are improving the Jovie artist profiles landing page at `/artist-profiles`.

Goal: keep the strong black/white premium music-tech aesthetic, but make every section feel as polished as the best parts of the page. The current page has a few excellent sections, but many areas feel half-baked, inconsistent, or too generic.

Audit and improve the page section by section:

1. Hero
- Make the above-the-fold section feel more premium, focused, and conversion-driven.
- Improve spacing, hierarchy, CTA treatment, and visual rhythm.
- The handle claim input should feel like the primary action, with strong affordance and polish.
- Add subtle depth/motion only where it helps conversion.

2. “One profile. Adapts to every fan.”
- This section has potential but needs clearer visual storytelling.
- Make the mode buttons feel intentional, interactive, and connected to the preview.
- Improve the profile mockup so it looks like a real high-converting artist product, not a generic card.

3. Trust logos
- Make the label and logos feel premium and compact.
- Avoid looking like placeholder text.
- Normalize logo sizing, spacing, opacity, and alignment.

4. “Artist Profiles. Built to convert.”
- This section should be one of the strongest.
- Tighten the layout and make the pay/tour/fan-capture examples feel like product moments.
- Improve card hierarchy, background treatment, and section transitions.
- Make the mock UI elements feel coherent with the rest of Jovie’s design system.

5. Fan capture / notification activity
- The repeated activity feed currently feels noisy and unfinished.
- Redesign it into a polished motion/notification system that shows anonymous visitors becoming reachable fans.
- Use better grouping, shadows, rhythm, and readable microcopy.

6. Automated notifications
- This is conceptually strong but visually flat.
- Make the trigger/audience/message/destination workflow feel like a beautiful automation card.
- Improve the examples: release alert, city alert, post-payment follow-up.
- Make it feel like a music-native CRM without saying “CRM.”

7. “Get paid. Again and again.”
- This section should feel more emotional and concrete.
- Make the payment examples feel native, fast, and artist-specific.
- Improve the monetization cards carousel so it looks intentional, not like a rough feature dump.
- Add polish to the phone/payment drawer visuals.

8. “Details that matter.”
- This grid currently feels like a generic feature section.
- Redesign cards with consistent visual grammar, stronger icon/preview treatments, tighter copy, and better spacing.
- Each feature should feel music-specific and conversion-related:
  - Rich Analytics
  - Geo Insights
  - Always in Sync
  - Activate Creators
  - Press-Ready Assets
  - UTM Builder
  - Blazing Fast

9. “Live in 60 seconds.”
- This is strong conceptually but needs better visual flow.
- Make the 3-step claim/import/share sequence feel polished and believable.
- Improve step cards, progress state, provider matching, share controls, and QR/deep-link buttons.
- The section should communicate speed and ease at a glance.

10. “Real Artists. Real Workflows.”
- The cards look good; preserve and refine this style.
- Improve spacing, image treatment, card hover states, and mobile behavior.
- Ensure the section feels like social proof, not filler.

11. Founder quote
- The quote card visible near the bottom is one of the strongest visual moments.
- Keep this direction.
- Refine typography, spacing, max-width, border radius, and responsive behavior.
- Make sure it feels deliberately placed, not floating in empty black space.

12. FAQ
- Currently too plain compared to the rest of the page.
- Redesign accordion styling to match the premium visual system.
- Improve spacing, borders, disclosure icons, hover states, and open-state transitions.

13. Final CTA / footer
- Make the closing CTA feel like a strong conversion moment.
- Improve visual connection to the hero.
- Footer should be minimal, clean, and aligned with the brand.

Global design requirements:
- Use a consistent design system: radius, spacing scale, card surfaces, border opacity, shadows, typography sizes.
- Maintain the black premium background with white high-contrast cards where appropriate.
- Avoid generic SaaS gradients unless very subtle.
- Use music-specific UI details: releases, tour dates, tickets, pay, QR, fan capture, notifications, streaming destinations.
- Make the page feel like a real product built by music marketers, not a template.
- Prioritize responsive design. Mobile must feel as intentional as desktop.
- Use tasteful animation: hover states, marquee/feed motion, card reveals, active mode transitions. No gimmicks.
- Keep copy concise and conversion-oriented.
- Do not add heavy dependencies unless already used in the project.
- Preserve existing routes, auth links, signup flow, and core content.
- Improve implementation quality: component structure, reusable cards, data arrays for repeated content, clean Tailwind/classes, and accessibility.

Deliverables:
- Update the page implementation directly.
- Refactor repeated sections into clean reusable components where appropriate.
- Ensure no layout regressions on desktop, tablet, or mobile.
- After changes, run lint/typecheck/build if available and fix issues.
- Briefly summarize what changed section by section.
:::

One key direction: have Claude Code preserve the quote card and artist cards as the visual benchmark, then pull the weaker sections up to that level.


**Topic:** [[chatgpt-clusters/design_ux]]
