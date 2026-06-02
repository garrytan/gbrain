---
title: "Prevent text highlighting"
type: guide
created: 2026-02-05
updated: 2026-02-05
source: chatgpt-export
conversation_id: 6985132c-5f9c-8331-845a-c3b5a099bf67
message_count: 6
tags: [chatgpt, import, code]
---
# Prevent text highlighting

> Conversation ID: 6985132c-5f9c-8331-845a-c3b5a099bf67
> Created: 2026-02-05T22:01:17Z
> Updated: 2026-02-05T22:02:21Z
> Messages: 6

---

## User

prevent tex thighlighting on buttons

---

## Assistant

Mr. White — assuming you mean **prevent text highlighting/selection on buttons** (the usual UX annoyance), this is the standard, correct fix.

### CSS (cross-browser)
```css
button,
.btn {
  user-select: none;
  -webkit-user-select: none; /* Safari */
  -ms-user-select: none;     /* old Edge/IE */
}
```

### If it still happens on mobile (iOS tap-hold)
Add:
```css
button,
.btn {
  -webkit-touch-callout: none;
}
```

### If you want it **only while clicking/dragging**
```css
button:active {
  user-select: none;
}
```

### JS fallback (rarely needed)
```js
button.addEventListener("mousedown", e => e.preventDefault());
```

**Do not** globally disable `user-select` on `body` — that’s bad UX and breaks accessibility.

If you meant something *other than* text selection (e.g., focus outline, hover highlighting, Tailwind, React, or mobile Safari weirdness), say which stack and I’ll zero in fast.

---

## User

in tailwind

---

## Assistant

Mr. White — in **Tailwind**, this is built in.

### Prevent text selection on buttons
```html
<button class="select-none">
  Click me
</button>
```

### Mobile Safari (long-press callout)
```html
<button class="select-none touch-none">
  Click me
</button>
```

### If you also want to kill tap highlight (iOS/Android)
```html
<button class="select-none touch-none [ -webkit-tap-highlight-color:transparent ]">
  Click me
</button>
```

### Common real-world combo
```html
<button
  class="select-none touch-none focus:outline-none"
>
  Button
</button>
```

### Tailwind config (optional utility)
If you want a reusable utility:
```js
// tailwind.config.js
plugins: [
  ({ addUtilities }) => {
    addUtilities({
      '.no-select': {
        'user-select': 'none',
        '-webkit-user-select': 'none',
        '-webkit-touch-callout': 'none',
      },
    })
  }
]
```

Use `select-none` **only on interactive elements**, not globally.

If you’re seeing this specifically during **drag**, **double-click**, or **iOS long-press**, say which one — Tailwind has a clean fix for each.

---

## User

in linear on their login page not buttons or text can be selected. how do they do it? and should we adopt this

---

## Assistant

Mr. White —

### How Linear does it
On Linear’s login page, **they disable text selection at the page/container level**, not just buttons. Mechanically, it’s this pattern:

```css
html, body {
  user-select: none;
  -webkit-user-select: none;
}

input, textarea {
  user-select: text;
  -webkit-user-select: text;
}
```

Often paired with:
```css
* {
  -webkit-tap-highlight-color: transparent;
}
```

So:
- Nothing decorative is selectable
- Inputs still behave normally
- No drag-highlight, no accidental selection, no iOS callouts

This is intentional and tightly scoped.

---

### Why Linear does this
Facts, not vibes:

- **Login pages are non-content pages**
- Selection provides **zero utility**
- Prevents accidental highlight during rapid clicking
- Feels more “native app” than “website”
- Reduces visual noise and perceived jank

This is common in high-polish SaaS (Linear, Stripe Dashboard, Notion auth flows).

---

### Should *you* adopt this?
**Yes — but only for auth / landing / shell pages.**

**Good places**
- Login / signup
- Splash / onboarding
- App chrome (sidebars, nav, empty states)

**Bad places**
- Docs
- Dashboards with data
- Anything users might copy
- Forms beyond basic auth

Accessibility note (important):
- This is **acceptable** if inputs remain selectable
- Screen readers are unaffected
- Keyboard navigation is unaffected

Linear’s approach is compliant because it’s **contextual**, not global.

---

### Tailwind implementation (clean)
```html
<body class="select-none">
  <input class="select-text" />
</body>
```

Optional iOS polish:
```html
<body class="select-none [ -webkit-tap-highlight-color:transparent ]">
```

---

### Bottom line
Linear is doing this **on purpose**, for UX polish.
You should copy it **selectively**, not dogmatically.

If you want, tell me:
- marketing site vs app
- auth flow complexity
- mobile-heavy or desktop-heavy

I’ll tell you exactly where to draw the line.


## See Also
- [[chatgpt/chatgpt_button-text-update]]
- [[chatgpt/chatgpt_cant-hear-ai-text]]
- [[chatgpt/chatgpt_clean-up-text-2]]
- [[chatgpt/chatgpt_clean-up-text-options]]
- [[chatgpt/chatgpt_clean-up-text-request]]
