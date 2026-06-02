---
title: "Tailwind max-width 680px"
type: note
created: 2025-12-09
updated: 2025-12-10
source: chatgpt-export
conversation_id: 6938a606-337c-8328-9af0-6c45089a83ee
message_count: 2
tags: [chatgpt, import, code]
---
# Tailwind max-width 680px

> Conversation ID: 6938a606-337c-8328-9af0-6c45089a83ee
> Created: 2025-12-09T22:43:18Z
> Updated: 2025-12-10T01:32:53Z
> Messages: 2

---

## User

max-w- thats like 680pixeks ish in tailwind css

---

## Assistant

Mr. White, the Tailwind class closest to **≈680px max-width** is:

**`max-w-2xl` → 42rem = 672px** (base font-size 16px)

So if you need *roughly* 680px, just use:

```html
<div class="max-w-2xl">
```

If you need **exact 680px**, define a custom utility in `tailwind.config.js`:

```js
extend: {
  maxWidth: {
    '680': '680px',
  },
}
```

Then:

```html
<div class="max-w-680">
```

Most of the time, `max-w-2xl` is perfectly fine.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
