---
title: "E2E testing with Clerk"
type: guide
created: 2025-12-04
updated: 2025-12-04
source: chatgpt-export
conversation_id: 6932136b-0170-832d-aed8-5bc8e0ff0a19
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# E2E testing with Clerk

> Conversation ID: 6932136b-0170-832d-aed8-5bc8e0ff0a19
> Created: 2025-12-04T23:04:12Z
> Updated: 2025-12-04T23:07:51Z
> Messages: 4

---

## User

explain how e2e testing should work with clerk.dev as auth

---

## Assistant

Mr. White, here’s a concise, fact-driven explanation of how **end-to-end testing** should be structured when using **Clerk** as your authentication provider.

---

# **1. Core Principles**
E2E tests must **not** depend on real third-party auth flows (Clerk, Auth0, Google OAuth, etc.).  
Clerk recommends — and the industry standard practice is — to **bypass interactive login** and authenticate using:

### **A. Test-only API keys + backend-issued session tokens**  
or  
### **B. Clerk’s built-in "test users" + programmatic sign-in**  
depending on your stack and E2E framework.

**Never** run UI login flows in E2E — they’re slow, brittle, and not representative of the behavior you actually want to test (your app, not Clerk).

---

# **2. Recommended Architecture**

## **(A) For Playwright (most common)**

### **Step 1 — Create a Clerk test user (via dashboard or API)**
Clerk provides a special environment for testing.

You create a test user with known credentials.  
This user **only exists in test mode**, not production.

### **Step 2 — Programmatically sign in**
Use Clerk’s backend API (`clerkClient.users.getUser`, `clerkClient.sessions.createSession`, etc.) to get a **session ID** or **JWT** for this test user.

Example pattern (not literal code):

```ts
const session = await clerkClient.sessions.create({
  userId: TEST_USER_ID
});

const cookie = `__session=${session.sessionToken}`;
```

### **Step 3 — Inject the session cookie into the browser**
Playwright:

```ts
await context.addCookies([
  {
    name: "__session",
    value: sessionToken,
    url: "http://localhost:3000"
  }
]);
```

Now every page load is authenticated as that user without navigating the login UI.

### **Step 4 — Run tests normally**
All protected routes behave as though the user logged in legitimately.

---

## **(B) For Cypress**
Cypress works similarly:

1. Use Clerk backend API to issue a session.  
2. Set the `__session` cookie before visiting the app:

```js
cy.setCookie("__session", sessionToken)
cy.visit("/")
```

No UI login required.

---

# **3. Why this works with Clerk**
Clerk stores the authenticated session in the `__session` cookie (or equivalent depending on your SDK integration).  
If you generate a valid session token and place it where Clerk expects it, your app sees the test runner as a real signed-in user.

You are **not faking** authentication — you’re using Clerk’s official test mode and session creation APIs.

---

# **4. Additional Best Practices**

### **Use a separate Clerk instance for testing**
Protects real user data and lets you freely create/delete test users.

### **Avoid testing Clerk UI widgets**
You only need to test *your* UI and business logic, not Clerk’s.

### **Use a single login hook per test suite**
Generate the session once in Playwright/Cypress’s global setup, reuse cookie storage.

### **Use roles via test users**
Clerk supports custom roles/permissions.  
Create multiple test users (admin / member / banned / etc.) to test access-control paths.

---

# **5. Example Full Flow Summary (Playwright)**  
Concise version:

1. Create Clerk test user  
2. In Playwright global setup:  
   - Call Clerk API → create session token  
   - Save cookie storage to `.auth/user.json`  
3. In each test:  
   - Load the saved authentication state  
4. All routes are authenticated instantly, no UI login required

This is the standard production-grade pattern.

---

If you want, Mr. White, I can generate:
- A full working Playwright or Cypress template  
- A reusable `login()` helper  
- A CI-ready configuration (GitHub Actions, Vercel preview URLs, etc.)  

Just tell me your tech stack (Next.js? Astro? Remix? Node backend?).

---

## User

next.js and this runs in CI on github actions.

can i just make a user on clerk or they need to be a special kind of user?

---

## Assistant

Mr. White, here’s the clear, fact-driven answer:

# **1. Yes — you can create a normal Clerk user for testing**
Clerk **does not require** a special user type for E2E tests.

**BUT** the test user must be created **inside Clerk’s "Development" or "Test Mode" environment** — *not* in Production.  
Any user created in Dev/Test automatically behaves as a "**test-safe user**":

- They do **not** affect production data  
- You can generate unlimited sessions  
- You can even bypass email/SMS verifications  
- You can delete/reset them freely  
- CI can use them without risk  

So: **a regular user is fine as long as it’s in the Dev/Test instance.**

---

# **2. How this works in CI (GitHub Actions)**

### **You need:**
- `CLERK_SECRET_KEY` (the Dev/Test secret, **not** the production one)
- A test user ID (you can store it as `CLERK_TEST_USER_ID` in GitHub secrets)

Then your GitHub Actions test setup does something like:

1. **Call Clerk backend API** → create a session for that user  
2. **Inject `__session` cookie** into Playwright/Cypress  
3. Run your E2E suite fully authenticated

This is the standard, safe pattern.

---

# **3. Should you pre-create the user manually or via API?**

Either works:

### **Option A — Pre-create manually (simplest)**
- Go to Clerk Dashboard → Dev instance → Users  
- Create a user like `ci-test@example.com`  
- Store the user ID in GitHub secrets  
- CI uses that ID to create sessions

This is the typical approach.

### **Option B — Create user on-the-fly via Clerk API**
- CI calls `clerkClient.users.createUser()`  
- Uses that new user ID for the session generation  
- Delete afterward if desired

Useful if you need a fresh user per test run, but not required.

---

# **4. What *not* to do**
Do **not**:

❌ Run the Clerk sign-in UI flows during E2E  
❌ Use production users  
❌ Use OAuth providers (Google, Apple, GitHub) in tests  
❌ Try to "mock" Clerk client-side — defeats E2E testing

---

# **5. Good to know**
Clerk session tokens created by the backend API behave exactly like real sessions.  
Once you inject the `__session` cookie, your Next.js app sees the user as fully authenticated.

---

If you want, I can give you:

- A **ready-to-paste Playwright `global-setup.ts`** that logs in via Clerk  
- A **GitHub Actions workflow file** for running authenticated E2E tests  
- A **complete Next.js test fixture** with Clerk preconfigured

Just tell me which E2E framework you are using (Playwright or Cypress).


## See Also
- [[chatgpt/chatgpt_e2e-testing-with-clerk-2]]
- [[chatgpt/chatgpt_clerk-e2e-testing-setup]]
- [[chatgpt/chatgpt_clerk-e2e-testing]]
- [[chatgpt/chatgpt_clerk-playwright-testing]]
- [[chatgpt/chatgpt_clerk-with-nextjs-react-e2e]]
