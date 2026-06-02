---
title: "Onboarding flow recommendation"
type: note
created: 2025-12-18
updated: 2025-12-19
source: chatgpt-export
conversation_id: 6944445f-3e9c-832c-9f09-330f564c1161
message_count: 2
tags: [chatgpt, import]
---
# Onboarding flow recommendation

> Conversation ID: 6944445f-3e9c-832c-9f09-330f564c1161
> Created: 2025-12-18T18:13:52Z
> Updated: 2025-12-19T22:33:10Z
> Messages: 2

---

## User

best onboarding patttern. shoulw the dashbaord blurred out? or have a full screen typeform style?

---

## Assistant

Mr. White,

**Short answer:**  
Default to a **full-screen, focused onboarding flow**. Do **not** blur the dashboard.

**Why (evidence-based UX reasoning):**
- **Blurred dashboards increase cognitive load** and tease features before users understand value → higher early churn.
- **Full-screen flows reduce choice overload**, which improves completion rates in first-session activation.
- Top-performing SaaS products optimize for **time-to-first-value (TTFV)**, not feature exposure.

**Best-in-class onboarding pattern (validated):**
1. **Full-screen, Typeform-style flow (3–7 questions max)**
   - One question per screen
   - Clear progress indicator
   - Skippable
2. **Questions strictly tied to product configuration**
   - No “market research” questions
   - Every answer should immediately change defaults
3. **Instant transition to a *configured* dashboard**
   - User lands in a state that already feels useful
4. **In-product guidance after entry**
   - Tooltips, checklists, or contextual nudges
   - No modals unless critical

**When blurring *can* work (edge case):**
- If onboarding is **≤30 seconds**
- If the blur communicates a *single*, obvious action (e.g., “Connect Stripe”)
- Still inferior to full-screen in most cases

**Benchmarks to optimize:**
- Onboarding completion rate
- Time to first meaningful action
- Day-1 activation, not Day-7 retention

**Examples to emulate:**
- Linear (historically)
- Notion
- Superhuman
- Vercel

**Rule of thumb:**  
If the user hasn’t yet experienced value, **hide the product and guide them**.  
If they *have*, get out of the way immediately.

If you want, tell me:
- B2B vs B2C  
- First core action  
- Time-to-value target  

I’ll give you a concrete flow.


## See Also
- [[chatgpt/chatgpt_onboarding-flow-design]]
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_best-onboarding-ux]]
- [[chatgpt/chatgpt_debug-onboarding-issue]]
- [[chatgpt/chatgpt_linear-onboarding-explained-2]]
