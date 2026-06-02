---
title: "Storybook a11y Overview"
type: note
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 695445e2-4460-8330-86ab-9247a6fae9b8
message_count: 2
tags: [chatgpt, import, code]
---
# Storybook a11y Overview

> Conversation ID: 695445e2-4460-8330-86ab-9247a6fae9b8
> Created: 2025-12-30T21:36:35Z
> Updated: 2025-12-30T21:37:07Z
> Messages: 2

---

## User

storybook a11y

---

## Assistant

Here’s a concise overview of **Storybook a11y (accessibility)** — what it is, how it works, and how to use it:

### 📌 What it is
**Storybook a11y** is an **accessibility addon** for Storybook that automatically tests your UI components for accessibility issues using **axe-core**, a popular accessibility engine. It helps catch common WCAG violations (like missing alt text, poor contrast, etc.) right inside your Storybook UI. citeturn0search0turn0search1

---

### ⚙️ How to install

In your Storybook project directory:

```bash
npx storybook add @storybook/addon-a11y
```

or

```bash
npm install --save-dev @storybook/addon-a11y
```

Then add it to Storybook’s config (`.storybook/main.js|ts`):

```javascript
export default {
  addons: [
    '@storybook/addon-a11y',
    // other addons…
  ],
};
```

This makes the accessibility panel appear in the Storybook UI. citeturn0search1

---

### 🧪 What you get in Storybook

Once installed:

- **Accessibility toolbar icon** and **panel** in Storybook.
- Automated **accessibility scans** run on the active story.
- Results grouped into:
  - **Violations** (issues found),
  - **Passes** (rules that passed),
  - **Incomplete** (needs manual review). citeturn0search1

---

### 🛠️ Configuration

You can customize how the addon runs by setting `parameters.a11y` in your `.storybook/preview.js|ts`:

```js
export const parameters = {
  a11y: {
    // CSS selector to audit (default: body)
    context: 'body',

    // axe-core configuration
    config: { /* rule overrides */ },

    // axe.run options
    options: {},
  },
};
```

You can also **disable automatic checks** (e.g., per story or globally) by setting:

```js
globals: {
  a11y: { manual: true }
}
```

This prevents Storybook from scanning every time you open a story. citeturn0search1turn0search11

---

### 🤖 Integrating with tests

Storybook’s a11y addon can also work with test runners like **Vitest** so accessibility checks are included in your automated test suite. This usually involves importing the addon’s annotations into your test setup. citeturn0search1

---

### 📍 Quick workflow
1. Browse to a story in Storybook.
2. Open the **Accessibility panel**.
3. Review violations, passes, and incomplete items.
4. Fix issues in your component (e.g., add aria-labels, improve contrast).
5. Re-run the checks to verify. citeturn0search1

---

### 🧠 Notes

- The addon catches many common WCAG issues automatically, but manual testing with assistive technologies is still recommended for full coverage. citeturn0search1
- You can tweak which rules to run or disable specific ones if they aren’t relevant to your components. citeturn0search11

---

If you want example config code specific to your framework (React/Vue/Angular), let me know which one you’re using and I can tailor it.
