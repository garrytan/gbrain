---
title: "Test Handling Strategies"
type: note
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 697ff34a-d6d8-8332-8b10-52634b673465
message_count: 2
tags: [chatgpt, import]
---
# Test Handling Strategies

> Conversation ID: 697ff34a-d6d8-8332-8b10-52634b673465
> Created: 2026-02-02T00:43:55Z
> Updated: 2026-02-02T01:00:47Z
> Messages: 2

---

## User

If tests catch nothing for 30 days, do you:

Remove them

Rewrite them

Ignore it

---

## Assistant

Mr. White,

**Neither remove nor ignore by default.** Do this instead—fact-driven:

1. **Audit the test**
   - What risk does it cover?
   - Why hasn’t it failed? (dead code, trivial assertion, poor data, flaky disabled paths)

2. **Rewrite if the risk is real**
   - Strengthen assertions.
   - Add adversarial / edge-case inputs.
   - Ensure it can actually fail when the behavior breaks.

3. **Remove only if the risk is gone**
   - Feature deprecated, code path unreachable, or redundant coverage proven elsewhere.
   - Document the removal decision.

4. **Ignore only temporarily**
   - If it’s low value *but* might matter later—tag it for review with an owner and date.

**Rule of thumb:**  
A test that never fails is either **excellent** (guarding stable, high-value invariants) or **useless**. Prove which one.


## See Also
- [[chatgpt/chatgpt_ai-agent-test-strategies]]
- [[chatgpt/chatgpt_ai-optimization-strategies]]
- [[chatgpt/chatgpt_avoiding-alcohol-service-strategies]]
- [[chatgpt/chatgpt_debate-strategies-overview]]
- [[chatgpt/chatgpt_development-velocity-strategies]]
