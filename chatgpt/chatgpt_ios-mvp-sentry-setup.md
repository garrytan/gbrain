---
title: "iOS MVP Sentry Setup"
type: guide
created: 2026-05-25
updated: 2026-05-25
source: chatgpt-export
conversation_id: 6a139a71-1ae4-83e8-a40b-1646f8987e6e
message_count: 5
tags: [chatgpt, import, code, long-form]
---
# iOS MVP Sentry Setup

> Conversation ID: 6a139a71-1ae4-83e8-a40b-1646f8987e6e
> Created: 2026-05-25T00:40:39Z
> Updated: 2026-05-25T00:41:47Z
> Messages: 5

---

## User

Hey bro, homestead, crazy. iOS observability, can I wire sentry, and what's like the MVP, if that looked like?

---

## Assistant

I’ll ground this in the current Sentry iOS setup, then translate it into a Jovie MVP that catches auth/WebView/deep-link failures without overbuilding.

---

## Assistant

Mr. White, yes. **Wire Sentry now.** For iOS MVP, the goal is simple: when auth fails, deep links break, the app hangs, or a build crashes, you know **which user, which release, which screen, which callback URL state, and what happened right before it.**

Sentry’s Apple SDK supports automatic error/crash reporting, watchdog terminations, app hangs, and basic performance monitoring for iOS. Session Replay is also available, but Sentry explicitly warns to verify masking before production because sensitive data can be captured if configured poorly. citeturn140541search0turn140541search4

## MVP observability stack for Jovie iOS

### 1. Crash/error capture

Install Sentry in the iOS app and capture:

- Native crashes
- Unhandled errors
- Auth flow failures
- Deep-link callback failures
- Network errors around login, profile import, and chat
- App hangs / watchdog terminations

Minimum tags:

```txt
app_platform: ios
app_surface: native
environment: production | preview | development
release: ios@<version>+<build>
user_id: <clerk_user_id_if_known>
session_id: <local_uuid>
auth_provider: clerk | apple | google | spotify
```

### 2. Auth flow breadcrumbs

For the current iOS auth bug, add explicit breadcrumbs around every boundary:

```txt
auth_start
auth_sheet_opened
auth_provider_selected
auth_callback_received
auth_callback_url_parsed
auth_session_closed
clerk_session_exchange_started
clerk_session_exchange_succeeded
clerk_session_exchange_failed
native_session_persisted
app_route_after_login
```

Each breadcrumb should include safe metadata:

```txt
provider
callback_scheme
callback_host
callback_path
has_code: true/false
has_state: true/false
has_error: true/false
error_code
current_route
network_status
```

Do **not** log auth codes, tokens, refresh tokens, emails, phone numbers, or full callback URLs.

### 3. Deep-link observability

Every time the app receives a URL, log a structured event:

```txt
deep_link_received
deep_link_parse_failed
deep_link_route_matched
deep_link_route_unmatched
```

Useful fields:

```txt
scheme
host
path
query_keys_only
source_app
cold_start: true/false
app_state: active | background | launching
```

This is the thing that tells you whether the bug is:

- iOS never received the callback
- iOS received it but parsed it wrong
- Clerk exchange failed
- session saved but route state failed
- app UI rendered the wrong post-auth state

### 4. Performance traces for the few paths that matter

Turn on tracing for critical flows only:

- App launch
- Sign in
- OAuth callback handling
- Chat send → first token
- Artist import
- Public profile load
- Merch/card generation later

Sentry supports sessions for release health, including crash-free rates, error rates, and session duration per release. citeturn140541search18

### 5. Session Replay: limited, sampled, masked

I would enable Session Replay only for:

```txt
errors_sample_rate: high for errored sessions
normal_sample_rate: very low, maybe 0–1%
```

And mask aggressively:

- Inputs masked
- Text masked where needed
- No tokens
- No email addresses
- No callback URLs
- No profile private data
- No payment data

For Jovie, Replay is useful mainly for **auth jank, navigation loops, blank screens, and chat flicker**. It is less important than structured breadcrumbs at MVP stage.

## The actual MVP implementation spec

Give Codex this:

```md
Implement MVP iOS observability for Jovie using Sentry.

Goals:
1. Capture native iOS crashes, unhandled errors, app hangs, watchdog terminations, and key manually captured auth/deep-link failures.
2. Make the current iOS auth failure debuggable end-to-end.
3. Avoid leaking auth tokens, OAuth codes, refresh tokens, emails, phone numbers, full callback URLs, or private user/profile data.

Tasks:
- Add Sentry iOS SDK initialization at app launch.
- Configure environment, release, dist/build number, and platform tags.
- Attach user context only after auth is known, using Clerk user ID only.
- Add safe global tags:
  - app_platform=ios
  - app_surface=native
  - build_channel=dev|preview|production
  - app_version
  - build_number
- Add breadcrumbs for the full auth lifecycle:
  - auth_start
  - auth_sheet_opened
  - auth_provider_selected
  - auth_callback_received
  - auth_callback_url_parsed
  - auth_session_closed
  - clerk_session_exchange_started
  - clerk_session_exchange_succeeded
  - clerk_session_exchange_failed
  - native_session_persisted
  - app_route_after_login
- Add breadcrumbs/events for deep-link handling:
  - deep_link_received
  - deep_link_parse_failed
  - deep_link_route_matched
  - deep_link_route_unmatched
- Redact all sensitive query values. Log query key names only.
- Manually capture exceptions for:
  - OAuth callback parse failure
  - missing auth code/state
  - state mismatch
  - Clerk session exchange failure
  - post-auth routing failure
  - persisted session validation failure
- Add performance spans around:
  - app launch
  - sign-in flow
  - callback handling
  - session exchange
  - first authenticated route render
- Add a debug-only screen/action that intentionally sends a test Sentry event, test breadcrumb chain, and test handled error.
- Add docs in `/docs/observability/ios-sentry.md` explaining:
  - what is captured
  - what is redacted
  - how to test locally
  - how to verify a release in Sentry
  - how to debug the current auth callback issue from Sentry events
- Add tests where practical for URL sanitization and deep-link parsing.

Acceptance criteria:
- A failed iOS sign-in produces one Sentry issue with breadcrumbs showing each auth/deep-link step before failure.
- Callback URLs are sanitized before logging.
- No token, code, email, phone, or full callback URL appears in Sentry payloads.
- Build version and release are visible in Sentry.
- User context is attached only after a known authenticated user exists.
- Debug test event appears in Sentry from a simulator and real device.
```

## What I would skip for MVP

Skip:

- Full custom analytics pipeline
- Datadog/New Relic
- Complex dashboards
- Custom replay infra
- Logging every UI interaction
- Product analytics inside Sentry
- Capturing chat content
- Capturing full request/response bodies

## Best MVP shape

Use this structure:

```txt
Sentry = engineering truth
PostHog/Statsig later = product truth
Server logs = backend truth
```

For right now, Sentry should answer:

> “Why did this iOS user fail to sign in, and what did the app do immediately before it failed?”

That is the highest-leverage observability target for Jovie iOS.

---

## User

Should it be wired directly or should there be an adapter so that we can change providers later, which is probably on the table.

---

## Assistant

Mr. White, use an **adapter**.

Direct wiring is faster for day one, but observability touches everything: auth, routing, API, deep links, chat, releases, users, native errors. If Sentry leaks everywhere, switching later becomes annoying and your app code starts speaking “Sentry” instead of “Jovie observability.”

## Recommendation

Use:

```txt
App code → Jovie Observability Adapter → Sentry
```

The adapter should be thin. No enterprise abstraction circus.

## MVP adapter shape

```ts
observability.captureError(error, context)
observability.captureMessage(message, context)
observability.addBreadcrumb(name, data)
observability.setUser(user)
observability.clearUser()
observability.setTag(key, value)
observability.startSpan(name, context)
observability.withScope(context, fn)
```

For iOS/Swift, same concept:

```swift
Observability.capture(error, context: ...)
Observability.breadcrumb("auth_callback_received", data: ...)
Observability.setUser(id: clerkUserId)
Observability.setTag("app_platform", "ios")
Observability.startSpan("auth.session_exchange")
```

## What should stay provider-neutral

These are **Jovie concepts**, not Sentry concepts:

```txt
auth_start
auth_callback_received
deep_link_parse_failed
clerk_session_exchange_failed
chat_first_token_timeout
profile_import_failed
public_profile_render_failed
```

Your app should emit those. The adapter decides how to translate them into Sentry breadcrumbs, issues, tags, spans, etc.

## What can be Sentry-specific

Keep this inside the implementation file:

```txt
SentrySDK.start(...)
SentrySDK.capture(...)
SentrySDK.configureScope(...)
SentryReplayOptions
beforeSend redaction
release/dist config
```

That way the blast radius is one file/folder.

## Folder structure

```txt
/lib/observability/
  index.ts
  types.ts
  sentry.ts
  redact.ts
  events.ts
  noop.ts
```

For iOS:

```txt
Jovie/Observability/
  Observability.swift
  ObservabilityEvent.swift
  SentryObservabilityProvider.swift
  Redaction.swift
  NoopObservabilityProvider.swift
```

## The important part: typed events

Do not let random string soup spread everywhere.

Use a small event catalog:

```ts
export const ObservabilityEvents = {
  AuthStart: "auth_start",
  AuthSheetOpened: "auth_sheet_opened",
  AuthCallbackReceived: "auth_callback_received",
  AuthCallbackParsed: "auth_callback_url_parsed",
  AuthSessionExchangeFailed: "clerk_session_exchange_failed",
  DeepLinkReceived: "deep_link_received",
  DeepLinkRouteUnmatched: "deep_link_route_unmatched",
  ChatFirstTokenTimeout: "chat_first_token_timeout",
} as const;
```

Then app code does:

```ts
observability.addBreadcrumb(ObservabilityEvents.AuthCallbackReceived, {
  provider,
  callbackScheme,
  callbackHost,
  callbackPath,
  queryKeys,
});
```

## Add redaction at the adapter boundary

Every provider call should run through:

```txt
sanitizeContext()
sanitizeUrl()
sanitizeHeaders()
sanitizeQuery()
sanitizeUser()
```

Block:

```txt
token
access_token
refresh_token
id_token
code
authorization
cookie
set-cookie
email
phone
full callback URL
```

This is the biggest reason to use an adapter. You centralize safety.

## Rule of thumb

| Area | Wire direct? | Use adapter? |
|---|---:|---:|
| SDK init | Fine direct in bootstrap | Yes, wrapped config preferred |
| Crash capture | Sentry native SDK direct under hood | Adapter exposed to app |
| Manual errors | No | Yes |
| Breadcrumbs | No | Yes |
| User context | No | Yes |
| Tags | No | Yes |
| Redaction | No | Yes |
| Performance spans | Adapter, but keep simple | Yes |
| Session Replay | Provider-specific | Hidden behind config |

## Codex prompt

```md
Implement a thin provider-agnostic observability adapter for Jovie iOS, backed by Sentry for now.

Goal:
App code should call Jovie Observability APIs, not Sentry APIs directly, except inside the Sentry provider implementation.

Architecture:
- Create an Observability module with:
  - ObservabilityProvider protocol/interface
  - SentryObservabilityProvider implementation
  - NoopObservabilityProvider for tests/dev fallback
  - Observability facade used by app code
  - typed ObservabilityEvent enum/catalog
  - redaction/sanitization helpers

Required API:
- captureError(error, context)
- captureMessage(message, level, context)
- addBreadcrumb(event, context)
- setUser(id)
- clearUser()
- setTag(key, value)
- startSpan(name, context)
- configure(environment, release, buildNumber)

Event catalog:
- auth_start
- auth_sheet_opened
- auth_provider_selected
- auth_callback_received
- auth_callback_url_parsed
- auth_session_closed
- clerk_session_exchange_started
- clerk_session_exchange_succeeded
- clerk_session_exchange_failed
- native_session_persisted
- app_route_after_login
- deep_link_received
- deep_link_parse_failed
- deep_link_route_matched
- deep_link_route_unmatched
- chat_first_token_timeout
- profile_import_failed

Redaction:
- Never send auth codes, access tokens, refresh tokens, ID tokens, cookies, authorization headers, email addresses, phone numbers, or full callback URLs.
- For URLs, log scheme, host, path, and query key names only.
- Add tests for redaction and deep-link sanitization.

Constraints:
- Keep the adapter thin.
- Do not create a complex analytics framework.
- Do not make product analytics depend on Sentry.
- Sentry-specific concepts should stay inside SentryObservabilityProvider.
- App code should use ObservabilityEvent values, not raw strings.

Acceptance criteria:
- Searching the app code outside the provider should show no direct Sentry calls.
- A simulated auth failure creates a Sentry issue with typed breadcrumbs.
- No sensitive auth values appear in captured payloads.
- Provider can be swapped to NoopObservabilityProvider in tests.
- Release, environment, build number, platform, and user ID are attached correctly.
```

## Final call

Use the adapter. Keep it thin. Make **events and redaction** the real abstraction. Sentry is just the first sink.


**Topic:** [[chatgpt-clusters/coding_mobile]]
