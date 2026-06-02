---
title: "E2E Test Account Setup"
type: note
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 6980469d-719c-8333-89dd-418738bf85f5
message_count: 2
tags: [chatgpt, import]
---
# E2E Test Account Setup

> Conversation ID: 6980469d-719c-8333-89dd-418738bf85f5
> Created: 2026-02-02T06:39:26Z
> Updated: 2026-02-02T18:09:35Z
> Messages: 2

---

## User

should our e2e test accounts be manually created in clerk and our db or seeded automaticallly

---

## Assistant

Mr. White —

**Short answer:** seed them automatically.

**Why automatic seeding is the correct default**
- **Determinism:** E2E tests must be repeatable. Manually created Clerk users drift over time.
- **CI/CD compatibility:** Headless test runs can’t rely on human setup.
- **Speed & scale:** New environments (preview, staging) come up clean with no manual steps.
- **Resetability:** You can wipe + reseed between runs to avoid state bleed.

**Recommended setup**
1. **Create test users via Clerk API** during test setup  
   - Use a dedicated Clerk *test instance* or environment.
   - Tag users with metadata like `role: e2e`, `env: test`.

2. **Seed your DB automatically**  
   - After Clerk user creation, insert corresponding rows using the Clerk `userId` as the FK.
   - Do this in a single seed script or test harness hook.

3. **Tear down aggressively**
   - Delete test users from Clerk post-run **or**
   - Reuse a small fixed pool and reset DB state before each suite.

**When manual creation is acceptable**
- One-off **debug accounts** for local dev only.
- Never as a dependency for CI or automated E2E.

**Hard rule**
If a test cannot be run from a clean environment with a single command, the setup is wrong.

If you want, I can outline a clean Clerk + DB seeding flow (local vs CI) in ~10 lines of pseudocode.


## See Also
- [[chatgpt/chatgpt_apple-dev-account-setup]]
- [[chatgpt/chatgpt_clerk-otp-test-setup]]
- [[chatgpt/chatgpt_create-account-page-setup-part1]]
- [[chatgpt/chatgpt_create-account-page-setup-part2]]
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
