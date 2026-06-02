---
title: "Best practices for AI code"
type: note
created: 2025-11-20
updated: 2025-11-20
source: chatgpt-export
conversation_id: 691eb67e-4fd8-8331-bdf2-02cce2d7779e
message_count: 4
tags: [chatgpt, import]
---
# Best practices for AI code

> Conversation ID: 691eb67e-4fd8-8331-bdf2-02cce2d7779e
> Created: 2025-11-20T06:36:24Z
> Updated: 2025-11-20T19:23:58Z
> Messages: 4

---

## User

We've ended up in our iOS app with our main dashbaord view being 2000+ lines of code. It was entirely built by AI.  Should we impose a rule to split it up when it hits X lines? Or should we make a rule based on other principles? Or is it better to build and then refactor later? Considering it's being done by AI and therefore there is zero overhead for complex component abstention . Whats the best practice here?

---

## Assistant

Short answer, Mr. White: a 2,000-line dashboard view is a code smell.  
Don’t make a religion out of line counts, but also don’t just “let AI cook” and hope to fix it someday.

---

### 1. Why a giant view is a problem *even with AI*

AI removes the typing cost of abstraction, but not these costs:

- **Debugging**: “Why is this button broken?” means hunting through 2k lines with intertwined state.
- **Onboarding humans**: A dev needs to hold the whole file in their head to make a safe change.
- **Merges & reviews**: Every PR touches the same monster file → conflicts and shallow reviews.
- **Reusability**: Common patterns get re-generated slightly differently instead of being reused.
- **UI framework issues**:
  - SwiftUI: huge `body` trees = harder to reason about `@State`, `@Binding`, `onAppear`, etc.
  - UIKit: view controller god-objects that mix layout, networking, navigation, etc.

So: the issue isn’t “2,000 lines”, it’s “20 responsibilities in one place”.

---

### 2. Better rules than “max X lines”

Use **principle-based rules**, with line count as a rough guardrail.

#### Split a view when:

- **Multiple clear sections**  
  Dashboard with header, KPI row, chart area, list, filters → those are separate views:
  - `DashboardHeaderView`
  - `DashboardKPIGrid`
  - `DashboardChartSection`
  - `DashboardRecentItemsList`
  - `DashboardFiltersBar`

- **State/logic is specific to a subsection**  
  If you have a bunch of state/logic only used by one part of the UI, that part wants its own component / view model.

- **It’s hard to name it in one sentence**  
  If the class/struct description becomes “handles dashboard, filters, navigation, error states, empty states, and analytics,” it’s doing too much.

- **You’re repeating patterns**  
  Same card layout, row type, button style, or “section with title + content” showing up 3+ times → extract.

- **Testing / previewing is painful**  
  If you can’t easily preview a section (SwiftUI `PreviewProvider` or UIKit demo VC) without the whole dashboard, that section is too entangled.

---

### 3. Reasonable heuristics (line counts as backup)

You *can* have simple numeric rules, just treat them as alerts, not laws:

- **Per view / controller**: Aim for ~300–500 lines max as a soft limit.
- **Per function**: 30–50 lines max. If a function is longer, split it into helpers.
- **Per file**: 800–1000 lines should trigger “should this be multiple files / modules?”

When you cross those thresholds, the rule is:  
> Ask “what are the logical chunks here?” and extract them.

---

### 4. How to use AI effectively here

Given there’s *zero overhead* for abstraction, your process can be:

1. **Let AI draft the big thing.**  
   “Generate a complete dashboard screen with sections A, B, C…”

2. **Immediately refactor with explicit constraints.**  
   Follow up with prompts like:
   - “Refactor this dashboard into smaller components: header, KPI grid, chart area, list, filters.”
   - “No view struct over 200 lines, no function over 40 lines.”
   - “Move non-UI logic into a `DashboardViewModel` and keep the view mostly declarative.”

3. **Lock in the structure.**  
   Once you like the decomposition, keep using those components in subsequent prompts instead of regenerating everything from scratch.

4. **Bake rules into your prompts & PR reviews.**  
   Teach the AI in your prompts:
   > “When generating UI, always factor repeated patterns into reusable components and keep views < 200 lines where possible.”

   And in human review, you can mandate:
   - “No new 500+ line view controllers or view structs.”
   - “Dashboard changes should mostly touch subviews/view models, not the root dashboard file.”

---

### 5. Build then refactor, or design up front?

For AI-generated UI, the sweet spot is:

- **Prototype fast, then refactor *immediately*** while the behavior is still fresh in your head (and in the AI context).
- Don’t let the 2,000-line file become “the stable thing we build on”.  
  The longer you wait, the more other code starts depending on that mess.

So:

- **Yes**: Build quickly with AI.
- **But also yes**: Enforce early refactor passes driven by:
  - Single-responsibility
  - Reuse
  - Testability/previewability
  - Human readability

---

### Concrete takeaway

If you want a simple rule set to adopt **today** for that 2,000-line dashboard:

1. **Refactor it now** into 5–10 subviews / view controllers + a view model.
2. From now on:
   - No view/controller over **500 lines** without an explicit reason.
   - No function over **40 lines**.
   - Any repeated UI pattern or section → its own component.

If you’d like, paste a (redacted) slice of that dashboard and I can show you exactly how I’d carve it up into components and what the AI prompts should look like going forward.

---

## User

Write that into a concise ai prompt rule I can add to our agents.md file

---

## Assistant

Mr. White, here’s a concise rule you can drop into `agents.md`:

> **UI Decomposition Rule (iOS):**  
> When generating or editing screens, keep each view/controller focused on a single responsibility. If a screen contains multiple distinct sections, repeated patterns, or section-specific state/logic, split it into subviews/components and move non-UI logic into a ViewModel. Use line counts only as guardrails: aim for ≤500 lines per view/controller and ≤40 lines per function; if exceeded, refactor into named components. Always reuse existing components instead of re-implementing similar UI.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_branch-cleanup-best-practices]]
- [[chatgpt/chatgpt_oauth-authentication-best-practices]]
- [[chatgpt/chatgpt_redwoodjs-best-practices]]
- [[chatgpt/chatgpt_tailwind-v4-best-practices]]
- [[chatgpt/chatgpt_vue-improvements-best-practices]]
