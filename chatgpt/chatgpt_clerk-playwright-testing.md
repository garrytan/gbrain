---
title: "Clerk Playwright Testing"
type: note
created: 2026-01-27
updated: 2026-01-27
source: chatgpt-export
conversation_id: 69784a2c-b484-8325-8275-c8e4f6ef8a3e
message_count: 2
tags: [chatgpt, import, code]
---
# Clerk Playwright Testing

> Conversation ID: 69784a2c-b484-8325-8275-c8e4f6ef8a3e
> Created: 2026-01-27T05:16:29Z
> Updated: 2026-01-27T05:18:58Z
> Messages: 2

---

## User

clerk playwright testing

---

## Assistant

Here’s a concise overview of **Clerk + Playwright testing** — focused on getting you started writing authenticated end-to-end tests with Clerk in Playwright:

---

## 🧪 What Playwright & Clerk Testing Is

- **Playwright** is Microsoft’s end-to-end testing framework for web apps (Chromium, Firefox, WebKit). It automates browser interactions and supports isolation per test via browser contexts. citeturn0search14  
- **Clerk** is a user authentication solution, and `@clerk/testing` provides helpers so Playwright tests can sign in/out without UI automation. citeturn0search0turn0search4

---

## 📦 Setup

1. **Install dependencies**

```bash
npm install @clerk/testing --save-dev
npm init playwright
```
This installs Playwright and Clerk’s testing helpers. citeturn0search0

2. **Configure environment variables**
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - Credentials for a test user (username/email & password) citeturn0search0

3. **Configure Playwright**
   - Create your `playwright.config.ts`
   - Use a storage directory for auth state caching if needed (for faster reuse). citeturn0search1

---

## 🔧 Write Authenticated Tests

### Use Clerk Testing Helpers

Import helpers inside your test file:

```js
import { test, expect } from '@playwright/test';
import { clerk } from '@clerk/testing/playwright';

test('authenticated flow', async ({ page }) => {
  await page.goto('/');       // Load page that initializes Clerk
  await clerk.signIn({
    page,
    signInParams: {
      strategy: 'password',
      identifier: process.env.TEST_USER_EMAIL,
      password: process.env.TEST_USER_PASSWORD,
    },
  });
  await page.goto('/protected'); // Protected route
  await expect(page).toHaveURL(/protected/);
});
```

- `clerk.signIn()` lets tests authenticate **without UI-driven interactions**. citeturn0search10

### Optional Helpers

- **`clerk.signOut({ page })`**: Ends the session. citeturn0search10  
- **`clerk.loaded({ page })`**: Waits until Clerk has loaded in the page. citeturn0search10

---

## 🔄 Test Auth State Reuse

Playwright runs each test in an isolated browser context. To avoid logging in on every test:

1. Run a setup test to authenticate once.
2. Save Playwright’s `storageState` (cookies/localStorage) to a file. citeturn0search1

```js
await page.context().storageState({ path: 'auth.json' });
```

3. Load that state in subsequent tests via Playwright config:  
```js
use: { storageState: 'auth.json' }
```

---

## 🧠 Best Practices

- **Never commit auth state files** (they have sensitive tokens). citeturn0search1  
- Run tests in CI with real dev instance keys & a dedicated test user. citeturn0search0  
- Focus E2E tests on user flows, not isolated units. citeturn0search12

---

## 🧬 Example Resources

- Clerk official Playwright testing guide — Clerk Docs. citeturn0search0  
- Example Playwright + Clerk repo on GitHub (demo test flows). citeturn0search5

---

If you want, I can give you a **starter Playwright + Clerk test template** you can drop into your project.
