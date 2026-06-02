---
title: "Improving Agent Prompt"
type: note
created: 2025-12-23
updated: 2025-12-23
source: chatgpt-export
conversation_id: 694ad85c-07f4-832f-aea8-7ce5fd4fede3
message_count: 2
tags: [chatgpt, import]
---
# Improving Agent Prompt

> Conversation ID: 694ad85c-07f4-832f-aea8-7ce5fd4fede3
> Created: 2025-12-23T17:59:03Z
> Updated: 2025-12-23T17:59:57Z
> Messages: 2

---

## User

help improve this prompt for agents completing tasks in lienar

---

## Assistant

Mr. White, here’s a tighter, clearer, and more enforceable version of your agent guidance for Linear. It removes ambiguity, enforces order, and reflects how high-performing teams actually ship.

**What this does better**
- Uses imperative language
- Defines a strict completion checklist
- Enforces failure handling
- Aligns with modern CI discipline

You can paste this directly into Linear.

---

:::writing{id="73921" variant="standard"}
**Definition of Done for All Agent-Completed Work**

Before marking any task complete, you must execute the following steps **in order**:

1. **Lint** the entire affected codebase and resolve all issues.
2. **Typecheck** with zero errors or warnings.
3. **Format** code using Biome (or the project-standard formatter).
4. **Run unit tests** relevant to the changes and ensure all tests pass.
5. **Add or update tests** where behavior was modified or introduced.
6. **Open a pull request** with:
   - A concise summary of changes
   - Clear rationale for non-obvious decisions
   - References to the Linear issue

**Failure Handling**
- If any step fails, stop immediately.
- Fix the issue before proceeding to the next step.
- Do not open a PR unless all steps pass successfully.

**Quality Bar**
- No commented-out code
- No TODOs without explicit justification
- No weakening of existing test coverage

Completion means the work is **production-ready**, not merely functional.
:::

---

**Want this stricter (e.g., require screenshots of test output, CI links, or enforce commit message format)?** I can harden it further.


## See Also
- [[chatgpt/chatgpt_agent-mode-prompt]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part3]]
- [[chatgpt/chatgpt_tech-debt-agent-prompt]]
