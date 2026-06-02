---
title: "Auth UX Audit"
type: guide
created: 2026-05-17
updated: 2026-05-17
source: chatgpt-export
conversation_id: 6a0a1ca4-8b2c-83e8-9972-c982b42a5c8f
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Auth UX Audit

> Conversation ID: 6a0a1ca4-8b2c-83e8-9972-c982b42a5c8f
> Created: 2026-05-17T19:57:30Z
> Updated: 2026-05-17T19:57:57Z
> Messages: 2

---

## User

Jov.ie so on production right now I’m just looking at it and we have like a couple issues with off like one when you’re on the off screen. It says it says continue with Google. Continue with Apple when you just click the sign-up button or request access button from the homepage there’s an awful model that just says Apple Google doesn’t say continue with Apple. Continue with Google, which tells me that for some reason there’s two separate components of the same thing like that should be the same Capone in there for the same tax in both places further on mobile the model should not be a model. It should be a full screen thing right even if it’s a model, it should still be full screen right because it’s it’s right so you know I’m a mobile model on mobile a model on mobile.

Modal on mobile

Jesus Christ speech to text hates that he’s a bad idea right so we want that to be full screen and then I just need an audit of like sign up sign in with the model and then the full screen off both are correct both have everything they’re supposed to have the legal leaks Lynx work everything works and then there’s test covers to prevent regression on this and so I need a prompt. That’s basically gonna have you know Kodex go and audit all this shit and I would like it to be and then I want a /perf-loop set to basically block to get the performance up on both the off model and the off page for like the homepage itself and off model and then the homepage and like one big thing is that the office from Clarke is like loading slowly so like you’ll see the model and you’ll see like the text and stuff, but then the off buttons won’t load right away and we basically have Google owe off an apple off and I think it’s like waiting for clerk to see which method is enabled, but like they’re both always enabled so I feel like we should be able to at least preload those buttons while we wait for Clark in the background like we should be able to optimistically load the off buttons. I don’t really understand why we’re having to wait for a response from Klahre to do that and then because they’re they’re coming in slow it’s shifting the layout around and then you’re getting this weird waterfall behavior and shit and that’s really bad especially when this is like the sign-up journey it needs to be frictionless so can you like kind of think about how to qualify all of those things I just discussed and harden them and go even wider than that and think about like adjacent issues that we might face and harden for all those so that it’s just a world class experience where like the user doesn’t notice any notice or feel any kind of late and see the whole process is just like really fast, even if Clark is being slow on their end

Clerk*



---

## Assistant

Mr. White, use this prompt:

```text
You are auditing and hardening Jovie’s auth entry points on production.

Context:
Production has inconsistent auth UX between the homepage signup/request-access modal and the dedicated auth page. The full auth page shows “Continue with Google” and “Continue with Apple.” The homepage modal only shows “Apple” and “Google,” which strongly suggests duplicated auth components or divergent copy/config. We need one shared auth surface/component system with consistent behavior, copy, loading states, legal links, mobile behavior, and tests.

Primary goals:
1. Unify auth UI
- Find every auth entry point:
  - homepage signup button
  - request access button
  - sign in link/button
  - sign up link/button
  - dedicated auth page
  - modal auth flow
  - mobile auth flow
- Identify duplicated components or divergent implementations.
- Refactor so the modal and full auth page reuse the same core auth provider button component and shared copy.
- Provider buttons must consistently read:
  - Continue with Google
  - Continue with Apple
- No short labels like “Google” or “Apple” unless explicitly used in a tiny constrained layout, and even then document the reason.

2. Fix mobile modal behavior
- On mobile, the auth modal should present as a full-screen auth surface.
- Avoid cramped modal UX on mobile.
- Ensure the mobile version has:
  - correct title/subtitle
  - full-width provider buttons
  - correct legal links
  - clear close/back behavior
  - no background scroll bleed
  - safe-area handling
  - no viewport-height bugs on iOS Safari

3. Eliminate Clerk loading jank
Current issue:
The modal shell/text appears before Clerk social auth buttons are ready. Then buttons load late, shifting layout and creating a waterfall/janky signup journey.

Investigate:
- Why Clerk provider buttons are delayed.
- Whether the code waits for Clerk configuration/provider availability before rendering buttons.
- Whether Google OAuth and Apple OAuth are always enabled in this environment.
- Whether we can optimistically render stable provider button shells immediately while Clerk initializes in the background.

Target behavior:
- No layout shift when auth loads.
- Provider button area reserves final height immediately.
- Buttons appear instantly or with stable skeletons that exactly match final dimensions.
- Clerk readiness should only affect click behavior/disabled state, not layout.
- No late button insertion.
- No waterfall visual behavior.
- If Clerk is slow, the user should see a polished, stable auth surface.

4. Audit legal and secondary links
For every auth surface, verify:
- Terms link works.
- Privacy link works.
- Sign in / sign up switching works.
- Request access flow works.
- Close/back behavior works.
- Keyboard navigation works.
- Focus states are visible.
- Screen reader labels are sane.
- OAuth clicks route correctly.
- Errors render without layout explosions.
- Loading states are consistent.

5. Performance hardening
Run or create a focused `/perf-loop` for:
- homepage
- homepage auth modal
- dedicated auth page
- mobile auth full-screen auth surface

The perf loop should block until performance regressions are fixed or explicitly documented.

Measure:
- Lighthouse mobile and desktop
- CLS
- LCP
- INP
- bundle impact
- hydration behavior
- auth modal open latency
- time until provider buttons are visually stable
- unnecessary Clerk/client JS waterfalls

Targets:
- Zero visible layout shift in auth surfaces.
- Auth modal opens immediately.
- Provider button area stable from first paint.
- No spinner-only blank auth states unless absolutely unavoidable.
- Homepage performance should not regress because auth code is eagerly loaded.
- Lazy-load auth implementation only when appropriate, but prefetch enough that clicking signup feels instant.

Explore:
- preloading/prefetching auth modal code on hover, intent, or idle
- keeping provider button layout static before Clerk readiness
- splitting heavy auth code from homepage critical path
- using stable skeletons with exact final dimensions
- avoiding duplicate Clerk initialization
- avoiding hydration mismatches
- avoiding dynamic text/layout swaps after hydration

6. Regression tests
Add coverage to prevent this from coming back.

Required tests:
- Unit/component test: provider labels are “Continue with Google” and “Continue with Apple.”
- Unit/component test: modal and page use the shared provider button component or shared config.
- Mobile viewport test: auth modal renders full-screen.
- E2E test: homepage signup opens auth surface with correct buttons.
- E2E test: request access opens same auth surface behavior.
- E2E test: dedicated auth page shows same provider labels.
- E2E test: terms/privacy links exist and have valid hrefs.
- E2E test: no layout shift caused by late provider button insertion.
- E2E test: slow Clerk/mock delayed auth readiness still renders stable button slots immediately.
- Accessibility test: focus trap, keyboard close, visible focus, aria labels.

Use Playwright where appropriate. Mock Clerk readiness delay if needed.

7. Adjacent issues to look for
Audit and fix nearby auth UX risks:
- duplicated copy constants
- duplicated OAuth provider arrays
- provider order differences
- dark/light theme mismatches
- modal close state bugs
- auth modal causing homepage scroll jump
- body scroll lock leaks
- auth page and modal having different legal text
- inconsistent error handling
- inconsistent loading/error copy
- iOS Safari viewport issues
- Android Chrome viewport issues
- Clerk script loading blocking homepage
- hydration warnings
- double-click / repeated OAuth click bugs
- OAuth button enabled before handler is safe
- missing disabled/loading state
- provider icon layout shift
- fonts/icons loading late and moving buttons
- auth redirects losing intended destination

Deliverables:
1. A short audit summary listing every auth entry point found.
2. A concise explanation of the current cause of the inconsistent labels and delayed button rendering.
3. A refactor that creates one shared auth component/config used everywhere.
4. Mobile full-screen auth behavior.
5. Stable optimistic/skeleton provider button rendering.
6. Passing tests.
7. Before/after screenshots or Playwright snapshots for:
   - desktop homepage auth modal
   - mobile homepage auth full-screen
   - dedicated auth page
8. Performance results before/after, especially CLS and auth modal open latency.
9. A final checklist confirming:
   - consistent copy
   - no mobile modal
   - legal links work
   - no layout shift
   - slow Clerk handled gracefully
   - tests added
   - homepage perf did not regress

Be aggressive about deleting duplicate auth components. Prefer one shared primitive and one shared auth surface wrapper over patching divergent implementations.
```


## See Also
- [[chatgpt/chatgpt_auth-provider-for-chatgpt]]
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
- [[chatgpt/chatgpt_basic-auth-in-nextjs]]
- [[chatgpt/chatgpt_best-auth-providers-2025]]
- [[chatgpt/chatgpt_clerk-auth-vercel-preview]]
