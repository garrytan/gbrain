---
title: "Storybook vs Playwright"
type: note
created: 2026-02-02
updated: 2026-02-04
source: chatgpt-export
conversation_id: 69810c19-5850-8332-b7e8-85fa92e328cc
message_count: 2
tags: [chatgpt, import]
---
# Storybook vs Playwright

> Conversation ID: 69810c19-5850-8332-b7e8-85fa92e328cc
> Created: 2026-02-02T20:42:02Z
> Updated: 2026-02-04T17:10:58Z
> Messages: 2

---

## User

should we ditch storybook and use only playwright

---

## Assistant

Mr. White — short, factual take.

**No, don’t fully ditch Storybook unless you change what problems you’re solving.**  
Storybook and Playwright optimize for *different failure modes*.

---

## Where **Storybook** still wins
image_group{"query":["Storybook UI component explorer","Storybook React components","Storybook design system"]}
- **Component isolation** → fastest way to reason about UI states  
- **Visual regression at the component level** (esp. Chromatic)  
- **Design-system workflows** (designers + devs speak the same artifact)  
- **State explosion control** (loading / error / edge states without mocks hell)

If you maintain a **shared component library or design system**, Storybook pays for itself.

---

## Where **Playwright** is strictly better
image_group{"query":["Playwright end-to-end testing","Playwright browser testing","Playwright CI testing"]}
- **End-to-end confidence** (real browser, real APIs)
- **User-path correctness** (what actually ships)
- **Lower cognitive overhead** (one tool, one mental model)
- **Fewer “storybook-only” states that never exist in prod**

If your app is **product-centric**, not **library-centric**, Playwright delivers more ROI.

---

## The mistake teams make
Using **Storybook as a testing tool**  
It’s a **development & communication tool first**, testing second.

---

## Practical decision rule
| Situation | Recommendation |
|---------|----------------|
| Design system / component library | **Keep Storybook + Playwright** |
| Early-stage product, small team | **Playwright only** |
| Storybook rarely updated / lies about reality | **Delete Storybook** |
| Designers rely on Storybook | **Keep it** |
| CI time + flakiness is killing you | **Reduce Storybook, not Playwright** |

---

## Lean setup I see work best
- **Playwright** → critical user journeys, smoke + regression
- **Storybook** → *only* shared primitives (buttons, inputs, modals)
- No duplicated assertions between the two

---

### Bottom line
If Storybook is **not actively used by humans**, kill it.  
If it’s your **source of truth for UI states**, keep it—but stop pretending it replaces E2E.

If you want, tell me:
- team size  
- product vs design-system focus  
- frontend stack  

I’ll give you a binary yes/no call.
