---
title: "Linear app border-radius"
type: note
created: 2026-01-08
updated: 2026-01-08
source: chatgpt-export
conversation_id: 69600610-6a30-8328-ab9f-a18413fc8dc2
message_count: 2
tags: [chatgpt, import, code]
---
# Linear app border-radius

> Conversation ID: 69600610-6a30-8328-ab9f-a18413fc8dc2
> Created: 2026-01-08T19:31:28Z
> Updated: 2026-01-08T19:33:08Z
> Messages: 2

---

## User

linear app border radius

---

## Assistant

There isn’t a published **official border-radius value scale from Linear’s design system** publicly available online. Linear’s brand guidelines don’t include specific UI token values like radius sizes. citeturn1search0

**What you *can* use in CSS for rounded corners (standard):**
```css
/* Apply the same rounding on all corners */
border-radius: 4px;
border-radius: 8px;
border-radius: 50%;

/* Different values per corner */
border-radius: 4px 8px 8px 4px;

/* Elliptical radii */
border-radius: 10px / 20px;
```
This uses the standard CSS `border-radius` property to control how round corners are — the higher the value, the more rounded the corners. citeturn1search1

If you meant **Linear the app’s UI**, typical modern UI systems use small consistent radii like `4px` and `8px`, but Linear hasn’t publicly shared an exact token list. Designers often choose values based on component size (e.g., small elements get smaller radii). citeturn1search2

Want me to give you a practical border-radius scale (e.g., px recommendations) for use in your own projects?
