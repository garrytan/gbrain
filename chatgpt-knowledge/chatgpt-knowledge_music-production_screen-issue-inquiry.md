---
title: "Screen Issue Inquiry"
type: guide
created: 2026-05-13
updated: 2026-05-13
source: chatgpt-export
topic: music-production
message_count: 8
tags: [chatgpt, knowledge, music-production]
---
**Topic:** [[chatgpt-knowledge/_topics/music-production]]

# Screen Issue Inquiry

> **Source:** ChatGPT conversation
> **Date:** 2026-05-13T17:16:37Z
> **Messages:** 8
> **Topic:** music-production

## Question

{'asset_pointer': 'sediment://file_0000000038ec720cbb2c7ccc38bfe6ed', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 179623, 'width': 709}
{'asset_pointer': 'sediment://file_00000000e29471f5b933185106e6ae5f', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sa

## Answer

Mr. White, the main problem is the **flow promises account creation, then ends in a waitlist**.

The user sees **“Create your account”**, signs in with Apple, waits through a blank screen, then lands on **“You Are On The Waitlist.”** That feels like something broke or like the app changed the deal after authentication.

### Biggest issues

1. **Wrong expectation**
   - “Create your account” implies immediate access.
   - The result is waitlist-only.
   - Better copy: **“Request access”**, **“Join the waitlist”**, or **“Create an account to request access.”**

2. **Blank black transition screen**
   - The second screen looks broken.
   - Add a loader or message: **“Creating your account…”**, **“Checking access…”**, or **“Saving your request…”**

3. **Apple auth branding looks off**
   - Apple says: **“Sign in to Jovie Web”**
   - That feels technical/internal. Use the clean user-facing app name: **“Jovie.”**

4. **Waitlist copy is awkward**
   - Current: **“You Are On The Waitlist”**
   - Better: **“You’re on the waitlist”**
   - Current: **“We will email you when your account is ready to continue.”**
   - Better: **“We’ll email you when your account is approved.”**

5. **No confirmation of which email was saved**
   - Especially with Apple, the user may have used an Apple relay email.
   - Show: **“We’ll email tim@example.com when access is ready.”**

6. **Only action is “Sign Out”**
   - That makes the screen feel like a dead end.
   - Add one useful secondary action: **“Change email”**, **“Contact support”**, or **“Back to home.”**

7. **Cookie banner should not appear here**
   - It distracts from a core auth/waitlist state.
   - It has only **Manage**, no obvious accept/dismiss.
   - Hide it during auth/onboarding, or make it compact and dismissible.

8. **Visual polish issues**
   - The waitlist icon/top-left area looks slightly misaligned or duplicated.
   - The card is pinned high with a huge empty black area below.
   - The first screen’s underlying Apple button shows a spinner while the Apple sheet is already open, which makes the background look stuck.

### Likely technical diagnosis

Apple sign-in is probably succeeding. The app then routes the user through a callback/creation step, checks access, and returns a waitlist state. The broken part is either:

- the **copy**, if users are expected to be waitlisted; or
- the **access/allowlist logic**, if this account should have been admitted.

The fastest fix: change the first screen to **“Join the waitlist”**, add a visible callback loading state, rename the Apple service from **“Jovie Web”** to **“Jovie”**, and show the saved email on the waitlist screen.

## Question

Our app has lots of issues like this. Write an audit prompt to find them across all with screens and scope expand to other gotchas

## Answer

Mr. White, use this as the audit prompt:

```text
You are a senior product, UX, growth, accessibility, and QA auditor. Audit this app from the perspective of a first-time user, returning user, skeptical buyer, mobile user, and edge-case user.

I will provide screenshots, screen recordings, flows, copy, or product notes. Your job is to find every issue that could cause confusion, lost conversion, broken trust, support tickets, churn, legal/privacy risk, or implementation bugs.

Be blunt, specific, and practical. Cite the exact screen, copy, UI element, or transition that caused each issue. Do not give generic advice. Do not praise the product unless it directly affects the audit.

Core audit goals:
1. Find mismatches between what the screen promises and what actually happens.
2. Find confusing, misleading, awkward, or low-trust copy.
3. Find broken or missing loading states, error states, empty states, success states, and edge-case states.
4. Find dead ends, unclear CTAs, weak hierarchy, inconsistent components, and unclear next steps.
5. Find auth, onboarding, waitlist, invite, billing, account, and permissions gotchas.
6. Find mobile UX issues: safe areas, keyboard behavior, modals, scrolling, tap targets, dark mode, gestures, and iOS/Android convention breaks.
7. Find trust issues: vague claims, unexplained data use, suspicious redirects, cookie banners, OAuth naming, email ambiguity, and missing confirmation.
8. Find accessibility issues: contrast, font size, focus order, screen reader labeling, alt text, reduced motion, color-only meaning, and dynamic type.
9. Find analytics and instrumentation gaps: events needed to diagnose drop-off, failed auth, rage taps, exits, retries, and conversion.
10. Find areas where the app needs better copy, UX, QA, or product logic.

For every issue, output this table:

| Priority | Screen / Flow | Issue | Evidence | Why it matters | Recommended fix | Better copy / UI |
|---|---|---|---|---|---|---|

Priority scale:
- P0: Blocks use, breaks trust, causes account/payment/auth failure, or creates legal/privacy risk.
- P1: Likely causes meaningful drop-off, confusion, support tickets, or failed conversion.
- P2: Noticeable polish, clarity, accessibility, or consistency issue.
- P3: Minor improvement.

Audit these categories:

A. Flow logic and expectation setting
- Does the screen title match the actual outcome?
- Are users told what will happen before they commit?
- Are waitlists, approvals, invites, subscriptions, and eligibility checks explained before auth/payment?
- Are there surprise outcomes after sign-in, signup, payment, or data submission?
- Are transitions clear between states?
- Are users ever dropped onto a blank, frozen, or unexplained screen?

B. Authentication and account creation
- OAuth provider naming: does Apple/Google show the correct public app name?
- Does the app explain whether users are creating an account, signing in, joining a waitlist, requesting access, or linking an account?
- Are App

*(Answer truncated — 10127 chars total)*

## Question

Have the agent use /browse to take screenshots itself and inspect the actual code. 

## Question

Audit only

## Question

Use ruflo and sub agents to work in parallel quickly

## Answer

Mr. White, use this updated prompt:

```text
You are auditing this app only.

Use ruflo and subagents to work in parallel quickly. Use /browse to inspect the actual running app like a user, take screenshots yourself, and inspect the actual codebase to identify root causes. Do not fix anything. Do not edit app code. Do not create PRs. Do not refactor. Do not write patches. The deliverable is an audit report only.

You may create audit artifacts such as:
- audit-report.md
- screenshots/
- notes from subagents

Do not modify source files, config files, routes, components, styles, tests, migrations, or package files.

Primary objective:
Find issues across the app that create user confusion, failed conversion, broken trust, support tickets, auth/account problems, waitlist confusion, billing risk, accessibility problems, analytics blind spots, QA gaps, and fragile implementation logic.

Use two evidence sources:
1. Actual app behavior from /browse, including screenshots.
2. Code inspection, including routes, components, auth logic, state handling, copy, analytics, API calls, feature flags, access control, billing, cookies, and error handling.

Work in parallel with subagents:

Subagent 1 — UX, flow, and copy audit
- Browse every reachable user-facing flow.
- Take screenshots of each screen and state.
- Find expectation mismatches, unclear CTAs, misleading copy, awkward wording, dead ends, surprise outcomes, weak success states, missing next steps, and inconsistent terminology.
- Pay special attention to signup, login, waitlist, onboarding, account creation, OAuth, invite flows, and post-auth states.

Subagent 2 — Auth, account, invite, and waitlist audit
- Inspect both UI and code for auth/account flows.
- Check Apple/Google OAuth naming, redirect handling, callback loading states, account creation logic, allowlist/waitlist logic, invited-user handling, existing-account handling, duplicate-account handling, Apple private relay email handling, wrong-account switching, sign-out behavior, expired sessions, and denied OAuth permissions.
- Identify places where the UI says one thing and the code does another.

Subagent 3 — Code/state/error implementation audit
- Inspect routes, components, hooks, server actions/API routes, middleware, state machines, loading states, error handling, redirects, cookies, feature flags, and environment-dependent behavior.
- Find missing loading states, blank screens, race conditions, double-submit issues, stale state, unhandled promises, poor error messages, weak retries, fragile redirects, and unreachable/ambiguous states.
- Identify root cause files/functions for each issue where possible.

Subagent 4 — Mobile, responsive, and accessibility audit
- Use /browse in mobile-sized viewports and desktop viewports.
- Check iPhone safe areas, Android behavior where possible, status bar contrast, notch/home-indicator overlap, keyboard behavior, modal scrolling, tap targets, viewport height issues, sticky banners, dark mode/light mode,

*(Answer truncated — 8786 chars total)*
