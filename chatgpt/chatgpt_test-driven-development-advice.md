---
title: "Test-driven development advice"
type: note
created: 2025-08-23
updated: 2025-08-23
source: chatgpt-export
conversation_id: 68a90c6c-9960-832d-9c73-20388c209bb6
message_count: 2
tags: [chatgpt, import]
---
# Test-driven development advice

> Conversation ID: 68a90c6c-9960-832d-9c73-20388c209bb6
> Created: 2025-08-23T00:33:58Z
> Updated: 2025-08-23T00:34:03Z
> Messages: 2

---

## User

Should we build tests before we write code?

---

## Assistant

Mr. White, short answer: not always.  

**Test-Driven Development (TDD)** = write tests first, then code until they pass.  
**Code-First with Tests After** = write code, then cover with tests.  

### When to write tests first
- **Critical logic**: prevents bugs early (auth, payments, core data flow).  
- **Complex edge cases**: writing tests clarifies requirements before coding.  
- **Team environments**: makes specs explicit and prevents regressions.  

### When not to
- **Prototyping / MVP**: you need speed, specs aren’t stable. Writing tests first wastes time if code is likely to be rewritten.  
- **Exploratory coding**: when you’re still figuring out architecture.  

### Practical compromise
- Write code for MVP quickly.  
- Add tests around **core flows** (sign up, login, payments, dashboards).  
- As features stabilize, move toward TDD for high-impact pieces.  

👉 For Jovie, given YC advice and your need to ship fast: **don’t block on TDD everywhere**. Write tests **after** for stability, but use TDD on flows that must never break (sign-up → handle claim → public profile).  

Want me to sketch the exact flows in Jovie you should treat with TDD vs. test-after?
