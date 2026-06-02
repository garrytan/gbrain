---
title: "Google OAuth Issue"
type: note
created: 2026-05-13
updated: 2026-05-13
source: chatgpt-export
conversation_id: 6a03ecbd-81b0-83e8-8fd4-1adaf8cedd96
message_count: 3
tags: [chatgpt, import]
---
# Google OAuth Issue

> Conversation ID: 6a03ecbd-81b0-83e8-8fd4-1adaf8cedd96
> Created: 2026-05-13T03:15:10Z
> Updated: 2026-05-13T03:23:36Z
> Messages: 3

---

## User

tell me all the issues on this screen. also this was after a google oatuh attempt and we dont use passwords so unlcear whu this came up

---

## Assistant

Mr. White, I’ll separate the visible screen issues from the likely auth-flow/config problem that surfaced a password reset after Google OAuth, then note what to inspect first.

---

## Assistant

Mr. White, this screen has several issues.

## Critical auth-flow issue

The app is showing **“Set new password” after a Google OAuth attempt**. For Jovie, that is the core bug/confusion. A password reset screen should not appear in a passwordless/social-login-only product unless Clerk is forcing an account-linking security flow.

Most likely causes:

1. **Existing Clerk user has a password credential**
   Clerk says disabling Password only affects new users; existing users with passwords can still have password-based auth state. So an old/test user may still be triggering password reset behavior. citeturn173780view2

2. **Clerk account-linking protection**
   Clerk attempts to link OAuth accounts to existing Clerk accounts with the same email. If the existing Clerk email is unverified, Clerk may prompt the user to change/reset password before linking the OAuth account, as an account-takeover protection. citeturn173780view0

3. **Google OAuth is landing in a Clerk reset-password step**
   Clerk treats social sign-in/sign-up flows as equivalent: a Google sign-in can create or link an account depending on whether the user exists. citeturn173780view1 If your route/error handling sends failed or incomplete OAuth attempts to `/signin#/reset-password`, users will see this screen even though they never chose password auth.

## Visible screen/product issues

1. **Password reset in a no-password product**
   The screen violates the expected Jovie auth model. Users who clicked Google should see Google continuation, account linking, email verification, or an auth error—not a password form.

2. **Copy contradicts the user journey**
   It says:
   - “Sign in”
   - “Welcome back to Jovie”
   - “Set new password”
   - “For security reasons, it is required to reset your password.”

   That mixes sign-in, reset-password, and forced-security-reset states without explaining why.

3. **No OAuth context**
   There is no mention of Google, OAuth, account linking, existing account, or failed social login. The user has no idea why this happened.

4. **Duplicate validation text**
   “Your password must contain 8 or more characters.” appears twice.

5. **Unlabeled empty input**
   There is an empty `<input value="">` before “New password.” It appears to be an unlabeled field, likely a hidden/OTP/email/code field rendering incorrectly.

6. **Empty/unlabeled buttons**
   The DOM shows at least one `<button></button>` with no visible text or aria label. That is an accessibility issue and likely a UI artifact.

7. **Back link looks broken/internal**
   The Back link points to:

   `/CLERK-ROUTER/HASH/reset-password`

   That looks like an internal Clerk router artifact rather than a clean Jovie URL. It may confuse users or fail routing.

8. **No escape hatch**
   There is no obvious “Continue with Google,” “Use another sign-in method,” “Return to sign in,” or “Contact support.” The only meaningful action is setting a password.

9. **“Don’t have access? Join the waitlist” is misplaced**
   On a forced reset screen after OAuth, that link is irrelevant. The user likely already has access or is trying to authenticate.

10. **Brand/vendor mismatch**
   “Secured by Clerk” is visible. That may be acceptable for Clerk-hosted/prebuilt components, but on a confusing auth error screen it makes the experience feel less owned by Jovie.

11. **Password rules are irrelevant**
   The app does not use passwords, so showing password policy text creates the impression Jovie has password auth.

12. **No account identifier**
   The screen does not say which email/account is being reset. In forced auth flows, users need to know which identity is affected.

## What I’d check first

In Clerk Dashboard:

1. Check whether **Password** is enabled under User & authentication.
2. Check whether this specific user has an existing password credential.
3. Check whether the user’s email is verified in Clerk.
4. Check whether Google is enabled for both sign-up and sign-in.
5. Check account-linking behavior for same-email OAuth users.
6. Inspect the OAuth callback/error route to see whether incomplete OAuth attempts are redirected to `/signin#/reset-password`.

Most likely fix: remove password credentials from existing users where appropriate, ensure emails are verified before OAuth linking, and override/handle Clerk’s account-linking/reset step so Google users see a clear Jovie-branded explanation instead of a password reset form.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
