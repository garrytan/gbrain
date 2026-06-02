---
title: "Apple Developer Assistance"
type: guide
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
topic: coding-mobile
message_count: 7
tags: [chatgpt, knowledge, coding-mobile]
---
# Apple Developer Assistance

> **Source:** ChatGPT conversation
> **Date:** 2026-05-09T02:28:48Z
> **Messages:** 7
> **Topic:** coding-mobile

## Question

One thing left for you (apps/desktop/SIGNING.md has the full checklist, ~15 min):

Find/export Developer ID Application cert from the Log Your Body Apple Developer team as .p12
Generate app-specific password at appleid.apple.com
Run 5 gh secret set commands

Open that Apple site for me and help me find whatever they're talking about. It says for Logger Body, but we probably want to make a new one for Jovie. 

## Answer

I’ll ground this in the repo checklist first, then point you to the exact Apple account screens and likely Jovie-specific GitHub secret values.

## Answer

Mr. White, the checklist lives on branch `itstimwhite/desktop-signed-auto-release`, not `main`. It says the 5 secrets are: `MAC_CERTIFICATE_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. fileciteturn13file0

Use **Jovie** credentials if a Jovie Apple Developer team exists. The doc mentions **Log Your Body** because that team is already enrolled and owns/was expected to own `appId: app.jov.ie`. fileciteturn13file0 A Developer ID Application cert is the certificate Apple uses to sign a Mac app distributed outside the Mac App Store, and Apple says only the Account Holder can create Developer ID certs. citeturn491530view0

### What to open

Open the Apple Account page for the app-specific password:

**Apple Account → Sign-In and Security → App-Specific Passwords → Generate**

Label it:

```text
jovie-notarytool
```

Apple’s current docs say app-specific passwords require two-factor authentication and are generated from `account.apple.com` under **Sign-In and Security → App-Specific Passwords**. citeturn544997view0

Then open Apple Developer for the cert/team:

**Apple Developer → Account → Certificates, Identifiers & Profiles → Certificates**

For a new Jovie cert, choose:

```text
+ → Software → Developer ID → Developer ID Application
```

Apple’s current flow is Certificates → plus button → Software → Developer ID → Developer ID Application, then upload a CSR and download the `.cer`. citeturn491530view0

### If creating the cert fresh

On your Mac:

```bash
# Create the CSR using Keychain Access, per Apple:
# Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority
```

Use:

```text
User Email Address: your Apple Developer email
Common Name: Jovie Developer ID Application
CA Email Address: leave empty
Request is: Saved to disk
```

Apple’s CSR instructions match that flow: Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority, enter email/common name, leave CA email empty, save to disk. citeturn710093view0

Upload the CSR in Apple Developer, download the `.cer`, then double-click the `.cer` so it appears in **Keychain Access → login → My Certificates**.

### Export `.p12`

In **Keychain Access**:

1. Select `login` keychain.
2. Go to **My Certificates** or **Certificates**.
3. Find:

```text
Developer ID Application: Jovie ... (TEAMID)
```

4. Right-click → **Export**.
5. Save as:

```text
jovie-cert.p12
```

6. Set a strong export password. You’ll use that as `MAC_CERTIFICATE_PASSWORD`.

Verify locally:

```bash
security find-identity -v -p codesigning
```

You want to see something like:

```text
Developer ID Application: Jovie Inc. (A1B2C3D4E5)
```

### Get Team ID

In Apple Developer:

```text
Account → Membership → Team ID
```

It should be a 10-character string, for example:

```text
A1B2C3D4E5
```

### Run the 5 GitHub secret commands

From the repo:

```bash
cd /path/to/Jovie

base64 -i jovie-ce

*(Answer truncated — 4002 chars total)*

## Question

We investigated our little pop-up modal here for Clark. See how oversized it is? It should be contained to a tiny little modal right in the center of the screen. It also looks like there are issues when you click the sign-in versus sign-out button, stuff like that. If you click off-screen, you can see some other UX issues. Can you look at both and then compile all the UX issues that you see? 

## Answer

I’ll compare the `/signup` and `/signin` Clerk flows against the expected small centered modal, then tie visible UX problems to the underlying implementation. I already found signup and marketing sign-in use different modal paths, which likely explains their inconsistent behavior.

## Answer

The sign-in modal already has safeguards like body portal, scroll lock, focus trap, hash cleanup, and a 400px cap. The deeper mismatch is Clerk redirect-mode buttons feeding an embedded-modal-style page.

## Answer

Mr. White, here’s the compiled UX QA list for the Clerk auth modal/sign-in/sign-up flows.

## Main issues

### 1. Sign-up modal is too large for the intended behavior

The intercepted `/signup` modal shell is sized at up to `600px` wide, with an inner Clerk container up to `520px`. That is larger than the “tiny centered modal” you described. fileciteturn26file0

The CSS then makes the Clerk modal title very large inside `.jovie-auth-modal`:

```css
font-size: clamp(2.45rem, 7.4vw, 3.35rem);
```

That makes the auth modal feel like a full marketing hero instead of a compact dialog. fileciteturn32file0

Recommended target:

```text
modal max-width: 360–400px
inner max-width: 360–380px
title: 20–24px
radius: 20–24px
```

---

### 2. Sign-up and sign-in behave inconsistently

The marketing-glass header uses normal links for both actions:

```tsx
href={APP_ROUTES.SIGNIN}
href={APP_ROUTES.SIGNUP}
```

So “Sign in” routes to `/signin`, while “Start Free Trial” routes to `/signup`. fileciteturn50file0

There is an intercepted modal route for signup:

```text
apps/web/app/@auth/(.)signup/page.tsx
```

That route is explicitly designed to render signup inside a modal over the current page. fileciteturn24file0

I did not find a matching intercepted signin modal route. The sign-in page is a full auth page under:

```text
apps/web/app/(auth)/signin/page.tsx
```

So users get two different experiences:

```text
Start Free Trial / signup → modal over page
Sign in → full-page auth screen
```

That feels broken even when both routes technically work.

---

### 3. Auth state is wrong on public marketing pages

The marketing-glass header always renders:

```text
Contact
Sign in
Start Free Trial
```

It uses static public links, so it does not switch to an authenticated state. fileciteturn50file0

The dynamic `AuthActions` component already has the correct pattern: if authenticated, show `Open App`; if unauthenticated, show `Log in` and `Sign up`. fileciteturn51file0

Expected behavior:

```text
Signed out: Sign in / Start Free Trial
Signed in: Open App / account menu
```

Current likely behavior:

```text
Signed in user still sees Sign in / Start Free Trial on marketing pages
```

That likely explains the “sign-in versus sign-out” confusion.

---

### 4. Backdrop click uses `router.back()`, which can produce weird exits

The modal’s dismiss function is:

```tsx
const dismiss = useCallback(() => {
  router.back();
}, [router]);
```

Backdrop click, Escape, and the back button all call that same dismiss behavior. fileciteturn26file0

That is risky because the close action depends on browser history. If the user landed directly on `/signup`, refreshed, opened from another page, or has an unexpected history stack, clicking outside the modal can send them somewhere surprising or appear to fail.

Expected behavior:

```text
Backdrop click closes the modal to a deterministic route, usually `/`
or the originating pathname.
```

Use `router.back()` only

*(Answer truncated — 8820 chars total)*
