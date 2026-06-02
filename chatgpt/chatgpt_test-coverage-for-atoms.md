---
title: "Test Coverage for Atoms"
type: note
created: 2026-01-30
updated: 2026-01-30
source: chatgpt-export
conversation_id: 697bff42-417c-832e-906c-75e3024b60da
message_count: 2
tags: [chatgpt, import]
---
# Test Coverage for Atoms

> Conversation ID: 697bff42-417c-832e-906c-75e3024b60da
> Created: 2026-01-30T00:45:57Z
> Updated: 2026-01-30T00:47:13Z
> Messages: 2

---

## User

talk to me about test coverage for atoms

---

## Assistant

Mr. White—

If by **atoms** you mean *Atomic Design atoms* (the smallest UI building blocks), here’s the clean, facts-first take on **test coverage**.

## What atoms are
Atoms are **pure, minimal, reusable UI units**: buttons, inputs, icons, labels. They should have:
- Few props
- No business logic
- No external side effects

That definition drives how you test them.

## What to test (and what not to)
**High-value coverage for atoms focuses on correctness, not behavior chains.**

### You *should* test
1. **Rendering**
   - Renders without crashing
   - Renders required variants (size, state, theme)
2. **Props → output**
   - Given props, DOM output is correct
   - Class names / styles change as expected
3. **Accessibility**
   - Correct role
   - Keyboard focus
   - ARIA attributes when applicable
4. **Basic events (if any)**
   - onClick fires
   - onChange emits expected value

### You *should not* test
- Integration with other atoms
- Business logic (shouldn’t exist here)
- Complex user flows
- Visual pixel perfection (use visual regression instead)

## Coverage targets (practical, not dogmatic)
- **Statement / line coverage**: ~90–100% (easy because atoms are small)
- **Branch coverage**: Only meaningful if atoms have variants
- **Mutation testing**: Overkill for atoms

If an atom can’t hit high coverage easily, it’s probably **too big** and should be split.

## Test types that matter
1. **Unit tests (primary)**
   - Jest / Vitest + Testing Library
   - Fast, deterministic, cheap
2. **Visual regression (critical)**
   - Chromatic / Percy
   - Catches what unit tests never will
3. **Type coverage (often ignored, very valuable)**
   - Strict TypeScript props
   - Prevents invalid states at compile time

## Anti-patterns
- Snapshot tests for atoms (high noise, low signal)
- Testing implementation details (class internals, hooks)
- Duplicating the same test across every atom

## Rule of thumb
> **Atoms should be boring to test.**  
If testing feels complex, the atom is doing too much.

If you meant **atoms in another context** (state atoms like Jotai/Recoil, or something else entirely), say the word and I’ll adjust.
