---
title: "Clerk Allowlist Feature"
type: note
created: 2026-01-04
updated: 2026-01-04
source: chatgpt-export
conversation_id: 695ad4a8-63e4-8332-b0d5-c8bd454ab312
message_count: 4
tags: [chatgpt, import, code]
---
# Clerk Allowlist Feature

> Conversation ID: 695ad4a8-63e4-8332-b0d5-c8bd454ab312
> Created: 2026-01-04T20:59:20Z
> Updated: 2026-01-04T20:59:52Z
> Messages: 4

---

## User

clerk allowlist

---

## Assistant

**Clerk allowlist** is a built-in feature in **Clerk’s authentication platform** that restricts *who can sign up* for your application by requiring their identifier (like email, phone number, domain, or wallet) to be explicitly permitted. Only identifiers added to the allowlist can create accounts. Others are blocked from signing up. citeturn0search0turn0search20

**Key points:**

- It **limits sign-ups to specific identifiers** (email addresses, domains, phone numbers, Web3 wallets). citeturn0search0turn0search20  
- Identifiers you add are **case-insensitive**. citeturn0search0  
- Without any entries, **all sign-ups get blocked** if allowlist is enabled. citeturn0search0  
- It’s typically a **paid feature** for production use, though you can test it in development. citeturn0search0  
- Allowlist governs *sign-ups*, not sign-ins for existing users (Clerk changed this behavior in recent releases). citeturn0search10

**Typical use cases:**  
- Internal admin tools where only company emails should register.  
- Exclusive beta access for a curated list of accounts.  
- B2B apps where only invited clients can create a login.

**How it works in practice:**  
You enable the allowlist in the **Clerk Dashboard > Restrictions > Allowlist** and add identifiers. You can also manage allowlist entries via the Clerk backend API (e.g., `createAllowlistIdentifier()` to add an identifier). citeturn0search20

If you want implementation examples or code snippets for a specific platform (Next.js, Node, etc.), let me know.

---

## User

sso redirect

---

## Assistant

Mr. White —

**SSO redirect** (in **entity["company","Clerk","authentication platform"]**) is the URL flow that sends a user **from your app → identity provider (IdP) → back to your app** after authentication.

### How it works (Clerk)
1. User clicks **“Sign in with SSO”**.
2. Clerk redirects them to the **IdP** (Okta, Azure AD, Google Workspace, etc.).
3. After auth, the IdP redirects **back to Clerk**.
4. Clerk redirects the user to **your app’s final URL**.

### The 3 redirects you must configure
1. **IdP → Clerk callback**
   - Set in the IdP.
   - Example:  
     ```
     https://YOUR-CLERK-DOMAIN.clerk.accounts/sso/callback
     ```

2. **Clerk → App post-auth redirect**
   - Set in Clerk Dashboard or via params.
   - Common options:
     - Default redirect URL
     - `redirect_url` query param
     - `afterSignInUrl` / `afterSignUpUrl`

3. **Optional deep link**
   - Preserve where the user was going:
     ```
     /sign-in/sso?redirect_url=/dashboard
     ```

### Common mistakes (facts, not opinion)
- ❌ Missing callback URL in the IdP → SSO fails silently.
- ❌ Redirect URL not allowlisted in Clerk → blocked redirect.
- ❌ Mismatch between **SSO connection domain** and user email domain.
- ❌ Expecting allowlist to handle SSO domain control (SSO has its own gate).

### Minimal Next.js example
```ts
<SignIn
  afterSignInUrl="/dashboard"
  redirectUrl="/dashboard"
/>
```

### When redirects break
- Check **Clerk Dashboard → SSO Connections → Logs**
- Verify **IdP redirect URI**
- Confirm **environment (dev vs prod) domains**

If you want, tell me **which IdP** and **framework** you’re using and I’ll give you the exact redirect URLs and config.


## See Also
- [[chatgpt/chatgpt_clerk-account-management-features]]
- [[chatgpt/chatgpt_clerk-apple-integration-setup]]
- [[chatgpt/chatgpt_clerk-apple-sign-in-issue]]
- [[chatgpt/chatgpt_clerk-auth-vercel-preview]]
- [[chatgpt/chatgpt_clerk-auth-vs-neon-auth]]
