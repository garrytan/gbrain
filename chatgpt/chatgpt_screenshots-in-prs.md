---
title: "Screenshots in PRs"
type: note
created: 2026-01-09
updated: 2026-01-09
source: chatgpt-export
conversation_id: 6960827a-4304-8331-a490-b4b48b9d8584
message_count: 2
tags: [chatgpt, import]
---
# Screenshots in PRs

> Conversation ID: 6960827a-4304-8331-a490-b4b48b9d8584
> Created: 2026-01-09T04:22:18Z
> Updated: 2026-01-09T04:22:33Z
> Messages: 2

---

## User

should we habe screenshots on our PRs?

---

## Assistant

Mr. White — **yes, usually.** Screenshots on PRs dramatically cut review time when there’s any UI/UX impact.

When to include screenshots (recommended)
- **Any visual change**: UI layout, styling, spacing, typography, colors, icons
- **Behavioral UX changes**: new flows, empty/loading/error states, responsive changes
- **Bug fixes** where the symptom was visible
- **New feature flags / experiments** (show both states if possible)

When screenshots aren’t necessary
- **Pure backend / infra / refactor** with no user-facing effect
- **Docs-only** changes (unless you’re changing rendered docs pages)
- **Tiny changes** where a screenshot adds no clarity

What “good” looks like
- **Before/After** (side-by-side or two images) for modifications
- Include key states: **default + edge cases** (empty, error, loading)
- If responsive: **desktop + mobile** (or note “no responsive impact”)
- Short caption per image: what reviewer should notice

Fast policy you can adopt
- PR template checkbox: **“UI change? Add before/after screenshots (or screen recording for interactions).”**
- If not included: require a note **“No UI impact.”**

If you tell me your stack (web/mobile) and what kinds of PRs you ship most, I can draft a tight PR template section and a simple rule reviewers can enforce.


## See Also
- [[chatgpt/chatgpt_hide-screenshots-in-photos]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_100-mbps-upload-options]]
