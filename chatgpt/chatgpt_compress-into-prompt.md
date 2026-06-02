---
title: "Compress into prompt"
type: guide
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69ff686b-8a58-83e8-92d9-77ac446a4e65
message_count: 2
tags: [chatgpt, import, code]
---
# Compress into prompt

> Conversation ID: 69ff686b-8a58-83e8-92d9-77ac446a4e65
> Created: 2026-05-09T17:01:32Z
> Updated: 2026-05-09T17:06:18Z
> Messages: 2

---

## User

compress this into a prompt

---

## Assistant

Mr. White, here’s the compressed prompt: fileciteturn0file0

```text
You are helping Jovie systematize founder-level design taste so AI agents can produce better product and marketing design with fewer regressions.

Context:
Jovie is building for DJs, music operators, and technical creative users. The product should be dark-mode first, cinematic, calm, powerful, and high-taste. Design is a company differentiator. The goal is to pull the founder out of repetitive design-review loops by turning his preferences into reusable rules, prompts, checklists, and workflows for agents.

Core references:
- Apple marketing pages: concise, outcome-oriented, well-written copy.
- Frame.io: dark, cinematic, premium marketing-page feel.
- Linear-like product quality: powerful, calm, efficient, restrained.
- Jovie users are technical, night-oriented, studio/DJ/music people who value tools that look cool without feeling noisy.

Design principles:
1. Dark mode first.
   The world is DJs, studios, clubs, and night work. The UI should feel native to that environment.

2. Calm by default, powerful on demand.
   Screens should feel simple and unintimidating at first glance. Power users should be able to access deeper information and advanced actions with very little effort.

3. Obvious primary action.
   Every screen should make the number one action obvious. Every row/card/module should make its main object or action obvious.

4. Use less screen real estate to communicate more.
   Prefer icons, compact metadata, popovers, tooltips, and progressive disclosure over large text blocks and oversized cards.

5. Cinematic motion only where it matters.
   Major surfaces like sidebar reveal, right rail, playback, karaoke/lyrics mode, and large layout transitions can use beautiful cinematic motion.
   Small interactions should be fast and subtle: roughly 100–150ms. Avoid exaggerated hover animations, popping cards, or cheap-feeling motion.

6. Marketing copy should be concise and visually balanced.
   Copy should be outcome-oriented and elegant. Avoid awkward line breaks, especially orphan words. When manually breaking lines, preserve meaning: a partial line should create incomplete information, not misleading information.

7. Design should feel premium, not generic.
   Do not copy generic SaaS, ChatGPT-style layouts, or mass-market navigation patterns unless they fit Jovie’s audience. Jovie is for cool, technical, music-adjacent users.

8. Use popovers intelligently.
   A compact row can show simple icons/metadata, while hover/click reveals detail. Example: show DSP count/status as an icon; reveal detailed DSP statuses in a popover.

9. Localize human-facing time.
   Show dates/times in the user’s local timezone. Avoid exposing UTC unless explicitly needed. Use compact date visuals where possible, with exact timestamps in tooltip/popover.

10. Status should be visual and scannable.
   Running, success, warning, failed, deterministic, CI, route, source, cost, etc. should use compact visual language, icons, sentence case, and subtle accent colors. Avoid raw machine labels unless the audience needs them.

11. Avoid duplicate hierarchy.
   If the app shell already has a page title/header slot, do not repeat the same page title inside the content area. Header actions belong in the header action area.

12. Avoid oversized low-value cards.
   Do not create large standalone cards for tiny facts like “default alive status.” Condense low-value state into a header, badge, icon row, tooltip, or compact metadata cluster.

Recent failure examples to avoid:
- Popovers that dump raw metadata like “source CI route deterministic updated May 8 10:45 PM UTC cost zero.”
- Lowercase machine labels like “deterministic.”
- UTC timestamps shown to a Los Angeles user.
- Status rows with no color or visual hierarchy.
- Repeated “Ops” header inside both app shell and page body.
- Text buttons like “TV View” placed in content when they should be compact header actions.
- Large cards for minor status information.
- Deploy success/status sections that are oversized relative to importance.
- Dense cards that fail to use real estate efficiently.

Task:
Given the attached design-system zip, homepage zip, current repo, and recent Linear design issues, produce an actionable plan to make Jovie’s agents better at design iteration.

Analyze:
- The current generated design system and homepage.
- The existing product shell and UI patterns in the repo.
- Recent Linear issues/changes related to design.
- Recurring founder feedback patterns.
- Places where agents are likely to regress or overgeneralize.

Deliver:
1. A concise “Jovie Design Taste Bible” with reusable principles.
2. A system prompt for design agents.
3. A checklist agents must run before submitting UI/design work.
4. A review rubric for evaluating designs.
5. Concrete UI rules for layout, hierarchy, motion, metadata, popovers, copy, status, and dark-mode styling.
6. Examples of bad vs. good transformations using the failure cases above.
7. A workflow for continuously extracting founder taste:
   - whether to interview the founder,
   - whether to rate 50–100 reference designs,
   - whether to mine past feedback,
   - whether to research external design principles,
   - and how to convert all of that into rules agents can follow.
8. A practical implementation plan that saves founder time over the next few weeks/months, reduces repeated feedback, and avoids design regressions.

Optimize for:
- High leverage.
- Minimal repeated work.
- Clear agent instructions.
- Design consistency.
- Founder taste codification.
- Practical next actions, not generic theory.
```


## See Also
- [[chatgpt/chatgpt_admin-dashboard-prompt]]
- [[chatgpt/chatgpt_agent-mode-prompt]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part3]]
