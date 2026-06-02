---
title: "Clerk E2E Testing"
type: guide
created: 2026-03-03
updated: 2026-03-03
source: chatgpt-export
conversation_id: 69a74143-64c0-8326-99f4-6f2055a9af34
message_count: 4
tags: [chatgpt, import, code]
---
# Clerk E2E Testing

> Conversation ID: 69a74143-64c0-8326-99f4-6f2055a9af34
> Created: 2026-03-03T20:15:08Z
> Updated: 2026-03-03T20:16:37Z
> Messages: 4

---

## User

clerk testing in production e2e

---

## Assistant

## entity["company","Clerk","auth platform"] Testing in Production (E2E)

### Objective  
Validate full authentication flows (sign up, sign in, session handling, role access) against the live production environment without polluting real user data.

---

## 1. Use a Dedicated Production Test Tenant
- Create a separate Clerk instance for production testing.
- Use a dedicated subdomain (e.g., `auth-test.yourapp.com`).
- Restrict access via:
  - IP allowlist
  - Basic auth
  - Feature flag
- Disable public sign-ups if not required.

---

## 2. Create Dedicated Test Users
Create seeded production test accounts:
- `e2e-admin@yourdomain.com`
- `e2e-user@yourdomain.com`

Assign roles explicitly inside Clerk.

Avoid random email generation in production unless you auto-clean them.

---

## 3. Use Playwright / Cypress with Production Base URL

Example with **Playwright**:

```ts
test('production login works', async ({ page }) => {
  await page.goto('https://yourapp.com/sign-in');

  await page.getByLabel('Email').fill('e2e-user@yourdomain.com');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD);

  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL('https://yourapp.com/dashboard');
});
```

Set:
```
BASE_URL=https://yourapp.com
CLERK_PUBLISHABLE_KEY=pk_live_***
```

Never commit live keys. Use CI environment secrets.

---

## 4. Test These Critical Flows

### Authentication
- Sign in
- Sign out
- Session refresh
- Expired session handling
- MFA (if enabled)

### Authorization
- Admin route access
- Protected API route
- Role-based UI visibility

### Edge Cases
- Invalid password
- Locked account
- Email verification flow

---

## 5. Prevent Data Pollution

Options:

**Option A: Reuse Same Test Users**
- Reset state before each test run.

**Option B: Create + Delete via API**
Use Clerk Backend API to clean up test users post-run.

---

## 6. Webhooks in Production

If using Clerk webhooks:
- Point to a production-safe endpoint
- Log webhook events during E2E
- Verify:
  - `user.created`
  - `session.created`
  - `session.ended`

---

## 7. CI Strategy

Recommended:
- Run full E2E suite nightly against production.
- Run smoke tests on every deploy.
- Alert on auth failures immediately.

---

## 8. What NOT to Do
- Do not test with real customer accounts.
- Do not expose test sign-up publicly.
- Do not run destructive database tests in production.

---

If you want, specify:
- Framework (Next.js, Remix, etc.)
- Test runner (Playwright, Cypress)
- Hosting (Vercel, AWS, etc.)

I can provide a hardened production E2E setup tailored to your stack.

---

## User

mostly conerned with how we do basic e2e smoke test in production

---

## Assistant

## entity["company","Clerk","auth platform"] Production E2E Smoke Test (Minimal + Safe)

### Objective  
Validate that authentication and one protected route work in live production after deploy. Keep it fast (<60s) and non-destructive.

---

# What To Test (Only 3 Things)

1. **App loads**
2. **Login works**
3. **Protected page loads authenticated**

That’s it. Smoke tests confirm system health, not full behavior coverage.

---

# Setup

### 1. Dedicated Production Test User

Create one permanent account:

```
e2e-smoke@yourdomain.com
```

- Stable password
- Minimal permissions
- No billing impact
- Excluded from analytics

Do not create/delete users dynamically in production.

---

### 2. Use Playwright Against Live URL

Example:

```ts
import { test, expect } from '@playwright/test';

test('production smoke test', async ({ page }) => {
  await page.goto('https://yourapp.com');

  await page.click('text=Sign in');

  await page.getByLabel('Email').fill(process.env.SMOKE_EMAIL);
  await page.getByLabel('Password').fill(process.env.SMOKE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/dashboard/);
  await expect(page.locator('text=Dashboard')).toBeVisible();
});
```

Environment variables in CI only.

---

# CI Strategy

After production deploy:

1. Wait 30–60 seconds
2. Run single smoke spec
3. Fail deploy if:
   - Login fails
   - Redirect loop
   - 500 on protected page

Run time target: 20–40 seconds.

---

# Make It Stable

### Use data-testid attributes
Avoid brittle selectors.

### Disable animations in prod via flag
Reduces flake.

### Add retry once in CI
Network variance happens in prod.

---

# Optional: Add One API Check

If you have authenticated API routes:

```ts
await page.request.get('https://yourapp.com/api/me', {
  headers: { Authorization: `Bearer ${token}` }
});
```

Confirms session cookie + backend validation.

---

# What Not To Include

- Sign up flow
- Password reset
- MFA enrollment
- Billing
- Role switching
- Database mutations

Smoke tests must be deterministic.

---

# Recommended Structure

```
/e2e
  smoke.spec.ts
```

Nothing else runs against production.

---

# When This Fails

Common causes:
- Clerk publishable key mismatch
- Incorrect allowed origins
- Session cookie domain issue
- Redirect URL misconfigured
- Edge middleware misrouting

---

If you share your stack (Next.js / App Router / Vercel etc.), I can tighten this into a production-hardened template.
