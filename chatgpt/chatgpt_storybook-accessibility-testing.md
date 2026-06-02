---
title: "Storybook accessibility testing"
type: guide
created: 2025-12-09
updated: 2025-12-09
source: chatgpt-export
conversation_id: 6937b565-f070-832f-ae6f-d36f6c0e6fc9
message_count: 4
tags: [chatgpt, import, code]
---
# Storybook accessibility testing

> Conversation ID: 6937b565-f070-832f-ae6f-d36f6c0e6fc9
> Created: 2025-12-09T05:36:38Z
> Updated: 2025-12-09T05:37:38Z
> Messages: 4

---

## User

should we use stroybook test for testing accessibilty?

---

## Assistant

Mr. White, **Storybook’s accessibility testing is useful**, but it’s not sufficient by itself.

## **Where Storybook Is Strong**
Use Storybook a11y tests when you want to:
- Automatically catch basic issues (contrast, aria-labels, tab order, etc.)
- Test accessibility at the **component level** before integration
- Give designers and developers fast feedback while building UI

This works well because Storybook:
- Is isolated and visual
- Supports addons like `@storybook/addon-a11y` and `storybook-testing-library`
- Lets you test many states of a component cheaply

**Verdict:** For unit-level UI accessibility, Storybook is efficient.

---

## **Where Storybook Is Weak**
Do **not rely on it for complete accessibility coverage**, because it cannot:
- Validate real keyboard navigation across multiple screens
- Confirm screen-reader narration across routes, dialogs, or dynamic content
- Handle page-level landmark structure
- Catch semantic issues caused by app layout or routing
- Detect timing/animation problems
- Validate real-world focus traps (modals, drawers, portals)

So **Storybook is incomplete for production accessibility guarantees**.

---

# **Best Practice**
Use Storybook for:
- Component-level a11y smoke tests
- CI-ready automated checks
- Rapid feedback during UI development

Also use:
- **End-to-end accessibility tests** (Playwright, Cypress + Axe)
- **Manual keyboard testing**
- **Screen-reader testing** (NVDA/VoiceOver)

---

# **Recommended Stack**
**Component level:** Storybook + Axe addon  
**App-level automation:** Playwright + Axe or Deque  
**Final validation:** Manual keyboard + screen-reader pass

---

### **Bottom line**
> Use Storybook for *early and fast* accessibility detection, not as your only accessibility test strategy.

If you want, I’ll outline how to set this up in CI, or evaluate your current testing stack.

---

## User

will this catch white text on a white backround?

---

## Assistant

Mr. White,

**Yes — Storybook a11y (Axe) will reliably detect white text on a white background**, because it evaluates:

- **Color contrast between foreground and background**
- **Whether text meets WCAG contrast thresholds**

White text on a white (or nearly white) background fails contrast immediately, so Axe will throw an accessibility violation automatically.

### **Caveats**
There are edge cases where Storybook might *miss* visual contrast issues:

- The text is **not actually rendered** (hidden or off-screen)
- The component has **transparent backgrounds** and Storybook doesn’t know the *real* page background color
- The component inherits contrast only when placed inside a specific layout or theme that Storybook **doesn’t know about**

So:  
**If the component has its own foreground + background defined inside Storybook, it will catch it.**  
**If contrast depends on global app styles or themes, Storybook may not know the real background, and then you need integration-level testing.**

---

# **Practical example**
If your button declares:

```
color: white;
background: white;
```

Axe inside Storybook → **FAILS immediately**

If the button is:

```
color: white;
background: transparent;
```

Storybook tests might **not know the background is white** unless you wrap it in a Storybook decorator or global theme.

---

# **Recommendation**
To guarantee detection of contrast issues:

- Wrap Storybook stories in **the same theme/layout** used in production
- Add **Playwright + Axe** tests at the page level to catch situations Storybook can’t infer

---

## **Bottom line**
> Storybook a11y will catch white-on-white text **if the component knows its background in the Storybook story**.  
> If contrast depends on page-level styling, add app-level tests.

If you want, I’ll tell you exactly how to structure your stories to eliminate false negatives.


## See Also
- [[chatgpt/chatgpt_storybook-testing-overview]]
- [[chatgpt/chatgpt_accessibility-contrast-check]]
- [[chatgpt/chatgpt_ada-gym-accessibility-rules]]
- [[chatgpt/chatgpt_mobile-vs-desktop-accessibility]]
- [[chatgpt/chatgpt_ai-app-testing-process-part1]]
