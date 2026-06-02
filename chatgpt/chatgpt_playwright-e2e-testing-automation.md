---
title: "Playwright E2E Testing Automation"
type: note
created: 2026-01-29
updated: 2026-01-29
source: chatgpt-export
conversation_id: 697b1511-b57c-8328-ab33-f5ef49d4b2f4
message_count: 2
tags: [chatgpt, import]
---
# Playwright E2E Testing Automation

> Conversation ID: 697b1511-b57c-8328-ab33-f5ef49d4b2f4
> Created: 2026-01-29T08:06:42Z
> Updated: 2026-01-29T08:07:02Z
> Messages: 2

---

## User

give me a prompt to use playwright to run our e2e smoke tests and check every page for a console log and fix those errors and loop til no errors then run /verify and /simplify and open a pr with auto merge

---

## Assistant

Mr. White — here’s a **copy-pasteable prompt** you can use for an agentic coding model (or internal AI dev tool) to drive Playwright end-to-end smoke testing, auto-fixing, and PR creation.

:::writing{id="73921" variant="standard"}
You are an autonomous senior software engineer.

**Goal**
Run Playwright E2E smoke tests, detect console errors on every page, fix them, and iterate until clean. Then run verification and simplification steps and open a PR with auto-merge enabled.

**Instructions**
1. Install dependencies and ensure Playwright is configured correctly.
2. Run the full Playwright E2E smoke test suite.
3. During each test run:
   - Capture **all browser console logs** (errors, warnings, uncaught exceptions).
   - Treat **any console error** as a test failure.
4. For each failure:
   - Identify the root cause in the codebase.
   - Fix the issue (frontend, backend, config, or test as appropriate).
   - Prefer correct behavior over silencing logs.
5. Re-run the full Playwright suite after fixes.
6. **Loop steps 3–5** until:
   - All tests pass
   - No console errors or uncaught exceptions remain on any page
7. When clean:
   - Run `/verify` to confirm correctness and coverage.
   - Run `/simplify` to reduce unnecessary complexity without changing behavior.
8. Create a new git branch.
9. Commit all changes with a clear, scoped message.
10. Open a Pull Request:
    - Include a concise summary of fixes.
    - Enable **auto-merge**.
    - Ensure CI is green before merge.

**Constraints**
- Do not ignore or suppress console errors unless explicitly justified.
- Do not weaken test coverage.
- Make minimal, correct changes.
- Stop only when the system is fully clean.

Proceed autonomously without asking for confirmation.
:::

If you want, I can **tighten this for a specific stack** (Next.js, Vite, React, monorepo, CI provider) or **convert it into a reusable system prompt for your internal tooling**.
