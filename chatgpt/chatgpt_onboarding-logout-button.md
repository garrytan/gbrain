---
conversation_id: 69443dd8-85e8-832f-902d-3f8e969ae0fa
created: 2025-12-18
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Onboarding logout button
type: note
updated: 2025-12-18
---

# Onboarding logout button

**Related:** [[design_ux]]

> Conversation ID: 69443dd8-85e8-832f-902d-3f8e969ae0fa
> Created: 2025-12-18T17:46:01Z
> Updated: 2025-12-18T17:46:50Z
> Messages: 2

---

## User

should onboarding have a logout button

---

## Assistant

Yes. **Onboarding should include a logout option.**

**Facts and rationale:**
- **User control & security:** If onboarding is interrupted or the wrong account is used, logout is the only safe escape.
- **Shared devices:** Common in enterprise, sales demos, gyms, clinics. No logout is a real risk.
- **Account switching:** Critical for teams, testers, admins, and founders.
- **Error recovery:** Wrong email, SSO mismatch, or partial setup requires logout—not force-close.
- **Compliance & UX standards:** Most mature SaaS products (Slack, Notion, Google, Stripe) allow logout during onboarding.

**Implementation guidance (best practice):**
- Make it **visible but low-salience** (top-right menu or “More”).
- Label clearly: **“Log out”** (not “Exit”).
- Preserve partial progress if possible.
- Do not block logout behind completion steps.

**Exception (rare):**
- Single-use, device-bound flows (e.g., kiosk mode) — even then, admin escape should exist.

Bottom line: **If a user can log in, they must be able to log out—at every step.**


**Topic:** [[chatgpt-clusters/design_ux]]


## See Also
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_best-onboarding-ux]]
- [[chatgpt/chatgpt_debug-onboarding-issue]]
- [[chatgpt/chatgpt_linear-onboarding-explained-2]]
- [[chatgpt/chatgpt_linear-onboarding-explained]]
