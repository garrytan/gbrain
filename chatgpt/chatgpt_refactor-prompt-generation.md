---
title: "Refactor prompt generation"
type: note
created: 2025-12-16
updated: 2025-12-16
source: chatgpt-export
conversation_id: 6941cbcb-422c-832b-80b9-8eb008f6f69f
message_count: 2
tags: [chatgpt, import]
---
# Refactor prompt generation

> Conversation ID: 6941cbcb-422c-832b-80b9-8eb008f6f69f
> Created: 2025-12-16T21:14:52Z
> Updated: 2025-12-16T21:15:35Z
> Messages: 2

---

## User

Write a prompt to recursively go through our code base and find components that need refactor, then top open a linear issue for each with a comprehensive set of evals and clear definition of done and instructions to open a pr when complete. 

The results should be the ai agent searches every component in our codebase then opens a seven of linear issues that can run in parelalll fixing them.


It should check light and dark mode, accessibility, keyboard acsiessibiltity, light and dark mode, and perfoamcne/ui blocking.

Our agents have access to our codebase so no instructions on stack or anything are neeeded

---

## Assistant

Here’s a copy-paste prompt you can give an AI agent to scan the repo, pick **7** high-impact refactors, and open **one Linear issue per refactor** with evals + clear DoD + “open a PR when done” instructions.

---

## Prompt: Repo-wide Refactor Sweep → 7 Parallel Linear Issues

You are an autonomous engineering agent with full read/write access to this repository and access to Linear (permission to create issues, add labels, assign, and link PRs).

### Goal
Recursively scan the entire codebase to identify **components that need refactor** (prioritize user-facing UI and shared building blocks). Select the **7 highest-impact** refactor opportunities that can be executed **in parallel** with minimal overlap. For each, create a **separate Linear issue** with:
- a clear problem statement
- a proposed approach
- a comprehensive evaluation checklist
- a clear Definition of Done (DoD)
- instructions to open a PR and link it to the Linear issue

### Repo Scan Instructions
1. **Recursively traverse** the repository.
2. Build an inventory of UI components and shared modules, including:
   - frequently reused components
   - complex components (many props, deep nesting, heavy effects)
   - components with UI jank, blocking work, slow renders, or expensive effects
   - components with weak accessibility/keyboard support
   - components that are visually inconsistent across **light + dark mode**
   - components with duplicated logic, dead code, or inconsistent patterns
3. For each candidate component, capture quick evidence:
   - file path(s)
   - why it needs refactor (smells, complexity, perf, a11y, theming, bugs)
   - rough scope and risks

### Selection Criteria (choose exactly 7)
Pick the 7 issues that maximize impact and parallelizability:
- high user-visible impact or high reuse
- clearly separable ownership boundaries (low file overlap)
- doable independently without sequencing dependencies
- should result in measurable improvements (perf, a11y, consistency, maintainability)

### Linear Issue Creation Requirements
Create **7 Linear issues** titled with this format:
**`Refactor: <ComponentName> — <primary goal>`**

Each issue must include the following sections (use headings):

#### 1) Summary
What the component is, where it is, and what’s wrong today.

#### 2) Files / Locations
Bullet list of exact paths.

#### 3) Problems Observed
Concrete bullet points (avoid vague “needs cleanup”). Include any evidence from scan.

#### 4) Proposed Refactor
Step-by-step plan. Include guardrails to avoid scope creep.

#### 5) Evaluation Checklist (must be comprehensive)
Include **all** of the following categories, with explicit checkboxes:

**Light/Dark Mode**
- [ ] Visual parity: backgrounds, borders, text contrast, focus rings, disabled states
- [ ] No hardcoded colors that break themes
- [ ] States (hover/active/focus/error/loading) correct in both modes

**Accessibility**
- [ ] Semantic roles/labels where applicable
- [ ] Proper name/description for interactive controls
- [ ] Screen-reader sanity pass (announcements make sense)
- [ ] Color contrast meets minimum expectations
- [ ] No “div button” anti-patterns (or equivalent)

**Keyboard Accessibility**
- [ ] Fully operable via keyboard only
- [ ] Logical tab order
- [ ] Visible focus indicators in light/dark mode
- [ ] Escape/Enter/Space behaviors appropriate
- [ ] No keyboard traps

**Performance / UI Blocking**
- [ ] No unnecessary rerenders (memoization/derived state sanity)
- [ ] Avoid blocking main thread work during input/scroll
- [ ] Heavy work moved off critical render path
- [ ] Lazy-load / code-split where appropriate
- [ ] Eliminated layout thrash / forced reflow patterns (if present)

**Regression Safety**
- [ ] Unit/integration tests added or updated
- [ ] Story/demo coverage updated (if present)
- [ ] No API breaking changes without migration notes

#### 6) Definition of Done (DoD)
Must be objective and testable. Include:
- measurable outcomes (where possible)
- all checklist items satisfied
- tests passing
- no visual regressions in light/dark
- no a11y regressions

#### 7) PR Instructions
- Create a branch: `refactor/<component>-<short-goal>`
- Open a PR when implementation is complete
- Link the PR to the Linear issue
- Include before/after notes and screenshots (light + dark)
- Call out perf/a11y changes explicitly in the PR description

### Labels / Metadata
Apply consistent labels to each issue:
- `refactor`
- `a11y`
- `theme`
- `performance`
Also add a “parallelizable” tag/label if available.

### Output Expectations
At the end, provide:
- A list of the **7 created Linear issue URLs/IDs**
- A one-line description per issue explaining why it was selected
- Confirmation that they are designed to run in parallel with minimal overlap

### Constraints
- Create **exactly seven** issues.
- Do not create “mega refactor” tickets—keep each scoped to one component or tightly related set.
- Do not include instructions about stack/tooling—assume full repo familiarity and access.

--- 

If you want, I can also adapt this prompt into two versions: one for a “planner” agent (triage + selection) and one for “executor” agents (each picks up one Linear issue and ships the PR).
