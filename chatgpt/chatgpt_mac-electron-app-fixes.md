---
title: "Mac Electron App Fixes"
type: essay
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69fec6b5-b868-83e8-8c19-b752ad7d8ebf
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Mac Electron App Fixes

> Conversation ID: 69fec6b5-b868-83e8-8c19-b752ad7d8ebf
> Created: 2026-05-09T05:31:34Z
> Updated: 2026-05-09T06:04:39Z
> Messages: 6

---

## User

this si the clean app sidebar header we need on our app.
we need to  remove the chrome extensino button and dropdown. and make it look native mac.

we should also look up common elecoron app gotchas generally and specifically about ux/ui and fix those/harden them.

app name/display name etc. folder structure etc. We should ship it with a good dmg drag and drop designed install hting.

fix our focus rings everywhere. help me harden this prompt. i want our mac electonr app to be jank free.






---

## Assistant

I’ll turn this into a concrete engineering prompt with acceptance criteria, covering the native macOS sidebar/header, Electron UX hardening, packaging/DMG requirements, focus rings, and verification steps.

---

## Assistant

Mr. White, use this prompt:

```text
You are working in this repo as a senior Electron/macOS app engineer. The goal is to make the macOS Electron app feel polished, native, and jank-free.

Primary objective:
Implement the clean native macOS-style sidebar header shown in the attached reference. Remove the Chrome extension button, dropdown, and any browser/extension-looking affordances from the desktop app UI. The app should feel like a real Mac app, not a web app in a shell.

Do this as an implementation task, not a design brainstorm. Inspect the repo first, identify the Electron/main/preload/renderer/build structure, then make the smallest safe changes that produce a shippable result.

Scope

1. Native macOS window/header/sidebar polish
- Replace the current sidebar header with a native-feeling macOS header matching the reference.
- Preserve native macOS traffic lights. Use Electron’s supported macOS title bar options such as `titleBarStyle: "hidden"` or `hiddenInset`, and use `trafficLightPosition` only if needed to align the reference cleanly.
- Make the empty header/sidebar top region draggable with `-webkit-app-region: drag`.
- Mark all interactive controls as `-webkit-app-region: no-drag`.
- Ensure the traffic lights never overlap app content, sidebar buttons, account controls, search, dropdowns, or nav items.
- Remove the Chrome extension button/dropdown from the desktop app. Search for related strings, components, icons, routes, IPC handlers, menu entries, and packaged assets. Remove or hide the desktop UI path cleanly while preserving any separate web-extension functionality if it exists.
- Use system-native typography and spacing: `-apple-system`, native-feeling line heights, subtle separators, compact but readable sidebar rows, no heavy web shadows.
- Use native-feeling sidebar colors. Prefer semantic CSS variables and system-aware light/dark mode. Avoid hard-coded colors that break in dark mode.
- Avoid fake browser chrome, extension icons, web toolbar affordances, and web-app-looking dropdown treatments.
- Prevent white flash on launch by setting an appropriate `BrowserWindow` `backgroundColor`, delaying show until ready where appropriate, and matching renderer background.

2. Focus rings and keyboard UX
- Audit focus rings everywhere: sidebar nav, header controls, dropdowns, buttons, inputs, dialogs, menus, modals, settings, onboarding, and any empty states.
- Use `:focus-visible` for keyboard focus. Do not show noisy focus rings on normal mouse clicks.
- Never remove outlines unless a visible replacement exists.
- Create one consistent focus-ring token/system, for example:
  - visible on keyboard focus
  - uses system/accent-compatible color
  - 2px outline or equivalent
  - sensible offset
  - respects border radius
  - works in light and dark mode
- Ensure all interactive elements are keyboard reachable and have correct roles/labels.
- Test tab order through the main app, sidebar, header, dialogs, dropdowns, and settings.
- Fix hidden traps, invisible focus states, focus lost after modal close, and dropdowns that cannot be escaped with keyboard.

3. Electron security hardening
Audit and harden Electron configuration:
- Use a current supported Electron version if the repo is behind.
- `nodeIntegration: false` in renderers.
- `contextIsolation: true`.
- `sandbox: true` where compatible.
- No deprecated `remote` usage.
- Use a preload script with `contextBridge`; expose only narrow, typed APIs.
- Validate IPC senders and inputs in every privileged IPC handler.
- Do not expose raw `ipcRenderer`, raw Electron APIs, filesystem APIs, shell APIs, or broad command APIs to the renderer.
- Keep `webSecurity: true`.
- Do not enable `allowRunningInsecureContent`.
- Do not enable speculative Chromium experimental features.
- Add or tighten Content Security Policy.
- Deny permissions by default with a session permission handler; allow only known required permissions.
- Block unexpected navigation.
- Block unexpected `window.open`.
- Open external links through `shell.openExternal` only after validating protocol and host allowlists.
- Avoid `file://` if feasible; prefer a custom app protocol for local renderer content.
- Review Electron fuses and disable capabilities the app does not need.

4. Electron performance/jank hardening
Audit common Electron performance traps:
- No synchronous IPC.
- No blocking filesystem, network, or CPU-heavy work in the main process.
- Move heavy CPU work to workers/utility processes where appropriate.
- Avoid loading expensive modules at startup.
- Lazy-load non-critical renderer code.
- Bundle renderer/main code appropriately.
- Remove unused dependencies, polyfills, debug code, and duplicate asset loads.
- Minimize network requests during startup.
- Ensure first paint is stable: no layout shift, no late sidebar jump, no header resizing after load.
- Preserve/restore window size and position safely.
- Set sensible min window dimensions.
- Ensure renderer crashes, failed preload, failed auth, or failed network calls produce graceful UI rather than blank windows.

5. Native macOS app behavior
- App lifecycle should feel native:
  - app remains open when last window closes on macOS unless product requirements say otherwise
  - clicking Dock icon reopens/focuses the main window
  - Cmd+Q quits
  - Cmd+W closes window
  - Cmd+, opens Preferences/Settings if that screen exists
  - About panel shows correct app name/version/company/icon
- Use a proper application menu. Remove dev/debug menu items in production.
- Disable or restrict DevTools shortcuts in production.
- Use native dialogs where appropriate.
- Ensure right-click/context menus do not expose browser/dev junk.
- Ensure title, Dock name, menu name, About name, DMG volume name, and executable name are consistent.

6. App identity, metadata, and folder structure
Audit and fix app identity:
- `package.json` `name`: lowercase package-safe name.
- `productName`: polished display name, e.g. `Jovie` unless the repo already defines the intended brand.
- `appId`: stable reverse-DNS identifier, e.g. `ie.jov.app` or the repo’s existing canonical identifier. Do not invent a new appId if one already ships publicly.
- Set `executableName` if needed.
- Ensure macOS Info.plist fields, bundle name, display name, copyright, version, build number, app icon, and About panel agree.
- Remove stale Chrome extension naming/assets from the desktop package.
- Clean folder structure without a risky rewrite. Prefer something like:
  - `electron/main`
  - `electron/preload`
  - `src/renderer`
  - `assets/icons`
  - `assets/dmg`
  - `build/entitlements`
  Adapt to the existing repo conventions.
- Ensure packaged files include only what is needed. Exclude tests, source maps if not intended, screenshots, local env files, extension-only assets, and dev artifacts.

7. macOS packaging, signing, notarization, and DMG
Create or harden a shippable macOS build:
- Use the repo’s existing packaging tool, likely Electron Builder or Electron Forge. Do not migrate tools unless necessary.
- Configure macOS code signing.
- Configure hardened runtime.
- Configure notarization for distribution outside the Mac App Store.
- Build Apple Silicon and Intel support as appropriate; prefer universal build if the project already supports it and size is acceptable.
- Add entitlements only where required. Keep them minimal.
- Verify the final `.app` launches on a Gatekeeper-enabled Mac.
- Verify the app works when moved to `/Applications`.
- Avoid writing mutable data inside the app bundle. Use proper user data paths.

DMG requirements:
- Produce a polished drag-and-drop DMG installer.
- Include app icon on the left and `/Applications` alias on the right.
- Include a tasteful branded background image with a simple drag arrow/instruction.
- Use correct icon sizes and coordinates.
- Use a clean volume title, e.g. `Jovie`.
- Use a clean artifact name, e.g. `Jovie-${version}-${arch}.dmg` or the repo’s release convention.
- Include a `.zip` artifact too if the app’s macOS auto-update flow requires it.
- Do not ship an ugly default DMG window.

8. QA and acceptance criteria
Run all available checks:
- typecheck
- lint
- unit tests
- renderer tests
- Electron smoke test
- production build
- macOS package build
- signed/notarized validation if credentials are available

Manual QA checklist:
- Launch app cold: no white flash, no layout jump, no visible dev UI.
- Sidebar header matches the reference and feels native.
- Chrome extension button/dropdown is gone from desktop app.
- Traffic lights align correctly and do not overlap content.
- Window dragging works from header/sidebar empty area.
- Interactive controls inside drag areas still click normally.
- Tab through the whole app with visible focus rings.
- Test light mode and dark mode.
- Test small window size and large window size.
- Test external links.
- Test Cmd+Q, Cmd+W, Cmd+,, About, app menu.
- Test packaged app from `/Applications`.
- Test DMG drag-and-drop install flow.

Deliverables:
- Implement the changes.
- Provide a concise summary of changed files.
- List exact Electron/security/performance hardening changes made.
- List packaging/signing/notarization changes made.
- Include test results and any commands run.
- Include any remaining risks or follow-ups only if blocked by missing credentials, missing assets, or product decisions.
```

Key source-backed details I’d keep in the prompt: Electron’s title-bar docs explicitly support hidden macOS title bars while keeping traffic lights, custom traffic-light positioning, and draggable regions via `app-region`/`-webkit-app-region`. citeturn379985view0turn379985view1 Electron’s own security checklist calls out `contextIsolation`, sandboxing, no Node integration for remote content, CSP, navigation/window-open limits, IPC sender validation, custom protocols over `file://`, and not exposing raw Electron APIs. citeturn157978view0turn995901view0 Electron’s performance checklist directly targets the jank issues you mentioned: startup work, blocking main/renderer processes, unnecessary modules/polyfills/network requests, and bundling. citeturn654836view0 For packaging, Electron and Apple both expect macOS apps distributed publicly to be code signed/notarized, and Apple requires hardened runtime for notarization. citeturn601866view3turn601866view0 Electron Builder’s DMG config supports custom background, icon positions, icon sizing, title, window sizing, and artifact naming, which maps well to the drag-and-drop installer you want. citeturn446643view1turn545086view0

---

## User

now do this prompt
figure out whats up with our onboarding chat interface and waitlist gating. mkae sure someone can sign up today, going through chat and get qulified or waitilisted and then signup when they get taking off waitlist and properly get emailed about it. and have auto accept after x days on wiatlist and on off. and keep the controls and intercace simple. ensure test coverage has no gaps and everything has performance benchmarks nad blockers. make a worldclass hardening plan so that by the end of it i cna confidently dump thousanda of click an hour in there and not stress

---

## Assistant

Mr. White, I’ll turn this into a repo-execution prompt with clear product behavior, admin controls, email flows, test coverage, load/performance targets, and launch-blocker gates.

---

## Assistant

Mr. White, use this prompt:

```text
You are working in this repo as a senior full-stack product engineer, growth engineer, and reliability lead.

Goal:
Audit, fix, and harden the onboarding chat interface and waitlist gating system so a real user can sign up today, go through the chat onboarding flow, get qualified or waitlisted, receive the correct emails, and successfully sign up after being manually or automatically removed from the waitlist.

The end state should be simple, reliable, measurable, and production-ready for thousands of clicks per hour without operator stress.

Do this as an implementation task. Inspect the repo first. Identify the app architecture, auth system, database/schema, email provider, queue/background job system, analytics, admin UI, tests, deployment setup, and current onboarding/waitlist code paths before making changes.

Primary user flows to guarantee

1. New user, accepted immediately
- User lands on the app.
- User starts onboarding through the chat interface.
- Chat collects the minimum required information.
- Qualification logic runs deterministically.
- User is approved immediately if they meet criteria.
- User can create an account in the same session.
- User receives the correct welcome/signup confirmation email.
- App state, database state, analytics, and email state all agree.

2. New user, waitlisted
- User lands on the app.
- User starts onboarding through the chat interface.
- Chat collects the minimum required information.
- Qualification logic runs.
- User is waitlisted if they do not meet immediate acceptance rules or if waitlist mode is enabled.
- User sees a clear waitlist confirmation state in-product.
- User receives a waitlist confirmation email.
- Duplicate submissions do not create duplicate waitlist rows, duplicate users, or duplicate emails.
- Returning waitlisted users see the correct state.

3. Waitlisted user, manually accepted
- Admin can view waitlisted users in a simple interface.
- Admin can approve a user from the waitlist.
- Approval is idempotent.
- User receives an invite/approval email.
- Invite link is secure, single-use or safely reusable with server-side validation, and expires according to config.
- User can complete signup after clicking the invite.
- User status changes from `waitlisted` to `invited`/`approved` to `signed_up`.
- Admin UI reflects the final state.

4. Waitlisted user, auto-accepted after X days
- Add a simple on/off control for auto-acceptance.
- Add a simple setting for `autoAcceptAfterDays`.
- Auto-accept should be off by default unless product config says otherwise.
- The job should run safely on a schedule.
- It should accept users who have been waitlisted for at least X days.
- It should respect capacity limits, suppression rules, rejected users, bounced emails, existing users, and manual overrides.
- It should send the same approval/invite email as manual approval.
- It should be idempotent and safe to retry.

5. Waitlist mode on/off
- Add or verify a simple control/config:
  - waitlist enabled: users go through qualification and may be waitlisted.
  - waitlist disabled/open signup: qualified users can sign up immediately.
  - hard-closed mode if needed: users can only join waitlist.
- Keep controls minimal. Avoid complex admin workflows unless already present.

Data model and state machine

Define or repair the canonical state model. Avoid ambiguous booleans.

Recommended states:
- `chat_started`
- `qualified`
- `waitlisted`
- `invited`
- `approved`
- `signed_up`
- `rejected`
- `expired`
- `blocked`

Use a clear transition model:
- `chat_started -> qualified`
- `qualified -> approved`
- `qualified -> waitlisted`
- `waitlisted -> invited`
- `waitlisted -> rejected`
- `invited -> signed_up`
- `approved -> signed_up`
- `invited -> expired`

Requirements:
- One canonical user/waitlist record per email.
- Email comparisons must be normalized.
- Prevent duplicate rows with database constraints, not only application logic.
- Store qualification inputs, qualification result, reason codes, status, source, timestamps, invite token metadata, email delivery metadata, and admin actor where applicable.
- Add audit logs for status changes.
- Ensure PII is minimized and protected.
- Do not store raw chat transcripts unless product explicitly requires it. If stored, make retention and privacy clear.

Onboarding chat interface

Audit the chat UX and make it production-grade:
- It should be obvious what the user needs to do next.
- It should collect only required information.
- It should handle partial completion, refreshes, back/forward navigation, and returning users.
- It should avoid dead ends.
- It should show clear loading, success, waitlist, error, and retry states.
- It should not allow double-submit bugs.
- It should not lose messages or state during async calls.
- It should gracefully handle slow qualification, failed network calls, email errors, auth errors, and rate limits.
- It should avoid jank, layout shift, scroll jumps, broken mobile behavior, and invisible focus states.
- It should meet basic accessibility standards:
  - keyboard usable
  - visible focus states
  - screen-reader labels
  - sensible heading structure
  - error messages tied to fields
  - reduced-motion support where relevant

Qualification logic

Find the current qualification logic and make it explicit.

Requirements:
- Qualification rules should be centralized.
- Rules should be testable without rendering UI.
- Every decision should produce a reason code.
- Avoid hard-coded magic scattered across the app.
- Support config-driven gates where reasonable:
  - waitlist mode
  - auto-accept enabled
  - auto-accept after days
  - capacity limit
  - allowed domains or blocked domains if relevant
  - minimum criteria
- Ensure qualification cannot be bypassed from the client.
- Server must be the source of truth.

Signup and auth

Verify the signup path from every state:
- approved immediate user
- invited waitlist user
- existing waitlisted user
- existing account
- expired invite
- invalid invite
- duplicate email
- user with unverified email
- user who starts signup but abandons
- user who returns after invite

Requirements:
- Signup should never depend only on client-side flags.
- Invite tokens should be generated securely.
- Tokens should be hashed at rest if feasible.
- Tokens should have expiration and replay protections.
- Existing users should be handled gracefully.
- Signup after approval should update waitlist/onboarding state atomically.
- Auth redirects should preserve intended destination.

Email lifecycle

Audit and harden every email:
- waitlist confirmation email
- approval/invite email
- signup confirmation/welcome email
- optional reminder email before invite expiry
- optional admin notification email

Requirements:
- Emails should be triggered from durable server-side events, not fragile client-side calls.
- Email sending should be idempotent.
- Avoid duplicate sends on retries, refreshes, double clicks, deploys, and job reruns.
- Store provider message IDs and send status.
- Track bounced, complained, suppressed, delivered, and failed states if provider supports webhooks.
- Use clear subject lines and sender identity.
- Approval email must include a working signup link.
- Links should include signed tokens or server-validated invite IDs.
- Email templates should render correctly in common clients.
- Add previews or snapshot tests for templates.
- Add plain-text alternatives.

Admin controls

Keep the interface simple:
- Waitlist mode: on/off.
- Auto-accept: on/off.
- Auto-accept after X days.
- Optional capacity limit per day.
- Waitlist table with search/filter by status, email, created date, qualification reason.
- Row actions:
  - approve
  - reject
  - resend invite
  - view audit/history
- Bulk approve only if already safe and easy.
- Show counts:
  - total waitlisted
  - approved today
  - invited pending
  - signed up
  - email failures
  - auto-accept enabled/disabled
- Do not expose internal complexity to normal admins.

Reliability and scale

Harden for thousands of clicks per hour:
- Add rate limiting on onboarding, qualification, signup, invite redemption, and email-triggering endpoints.
- Add bot/spam protection where appropriate.
- Add input validation on all endpoints.
- Add server-side schema validation.
- Add database indexes for email, status, created date, invite token hash, and job queries.
- Use transactions for status changes and signup completion.
- Use queues/background jobs for email and auto-acceptance if available.
- Ensure jobs are idempotent and safe under concurrent workers.
- Add locks or compare-and-swap updates where needed.
- Avoid N+1 queries in admin lists and job runs.
- Avoid synchronous email sending in user-facing request paths unless already proven fast and reliable.
- Add graceful degradation for email provider outages.
- Add retry policies with backoff.
- Add dead-letter handling or visible failure states for blocked jobs.
- Add circuit breakers where appropriate.

Performance benchmarks

Create or update benchmarks for:
- onboarding chat initial load
- chat message round trip
- qualification endpoint latency
- waitlist submission latency
- signup endpoint latency
- invite redemption latency
- admin waitlist list query
- auto-accept job throughput
- email enqueue latency

Target thresholds unless the repo already defines stricter ones:
- onboarding UI first usable state: under 2 seconds on a normal broadband connection
- qualification endpoint p95: under 500 ms excluding third-party dependencies
- waitlist submission p95: under 750 ms excluding email provider send time
- invite redemption p95: under 750 ms
- admin waitlist query p95: under 1 second for at least 100k waitlist rows
- auto-accept job: able to process at least 10k waitlisted users without timeout
- no user-facing endpoint should block on bulk email sends

Add load tests using the repo’s existing tooling, or introduce a lightweight tool such as k6/Artillery only if needed:
- simulate thousands of clicks/hour
- simulate onboarding starts
- simulate waitlist submissions
- simulate invite redemptions
- simulate duplicate submissions
- simulate bot bursts
- simulate email provider slowdown/failure
- capture p50, p95, p99, error rate, database load, and queue depth

Observability

Add or verify dashboards/metrics/logs for:
- onboarding starts
- chat completions
- qualification pass/fail
- waitlist submissions
- duplicate submissions
- approval count
- invite emails sent
- invite email failures
- signup completions
- invite redemption failures
- auto-accept job runs
- auto-accept users processed
- auto-accept failures
- queue depth
- endpoint latency
- endpoint error rate
- DB query latency
- conversion rate by state

Add structured logs with correlation IDs. Avoid logging sensitive PII or raw tokens.

Add alerts for:
- signup failure spike
- waitlist submission failure spike
- email send failure spike
- auto-accept job failure
- queue backlog
- invite redemption failure spike
- high p95/p99 latency
- database constraint violations above normal duplicate levels
- unexpected state transitions

Security and abuse prevention

Audit and harden:
- CSRF protection where relevant.
- Rate limits.
- Bot protection.
- Email enumeration risks.
- Token entropy.
- Token expiration.
- Token hashing at rest.
- Server-side authorization for admin actions.
- Admin audit logs.
- Validation and sanitization of chat inputs.
- SQL injection protection.
- XSS protection in chat messages and admin UI.
- SSRF risks if chat can call tools or ingest URLs.
- Open redirect risks in invite/signup links.
- Broken access control on waitlist records.
- Environment variable exposure.
- Secrets in client bundles.

Testing requirements

Add or fix coverage across unit, integration, E2E, load, and failure tests.

Unit tests:
- qualification rules
- state transitions
- email normalization
- duplicate prevention logic
- invite token generation/validation
- auto-accept eligibility
- config parsing
- admin action permissions

Integration tests:
- onboarding chat submit -> qualified immediate
- onboarding chat submit -> waitlisted
- duplicate waitlist submission
- manual approval -> invite email enqueued
- auto-accept job -> invite email enqueued
- invite redemption -> signup allowed
- expired invite -> signup denied with useful UI
- email failure -> retry/dead-letter behavior
- existing user edge cases
- database transaction rollback cases

E2E tests:
- full immediate signup flow
- full waitlist flow
- full manual approval flow
- full auto-accept flow
- returning waitlisted user flow
- invalid/expired invite flow
- admin approve/resend flow
- mobile/responsive onboarding flow
- keyboard navigation through onboarding

Failure tests:
- email provider down
- database slow
- double click submit
- two tabs submitting same email
- concurrent auto-accept job workers
- refresh mid-chat
- network disconnect during submission
- deployment during waitlist submission if testable

Performance/load tests:
- thousands of clicks/hour
- burst onboarding starts
- burst duplicate signups
- large waitlist admin query
- large auto-accept job

Test quality bar:
- No critical path should be covered only by mocks.
- Use deterministic fixtures.
- Use real database constraints in integration tests.
- Include regression tests for every bug found during the audit.
- CI should run critical tests automatically.
- Load tests can run separately if they are too heavy for normal CI.

Implementation constraints

- Prefer small, safe, incremental changes.
- Do not rewrite the entire onboarding system unless the existing one is unusable.
- Keep product controls simple.
- Keep UI copy clear and short.
- Avoid adding dependencies unless they solve a clear production problem.
- Do not make client-side qualification the source of truth.
- Do not send emails directly from the browser.
- Do not create hidden states that admins cannot understand.
- Do not create a system that only works in happy-path demos.

Acceptance criteria

By the end, the following must be true:
- A new user can sign up today through the onboarding chat.
- A qualified user can be approved immediately and complete signup.
- A non-qualified or gated user can be waitlisted.
- A waitlisted user receives the correct waitlist email.
- A manually approved waitlisted user receives the correct approval email and can sign up.
- An automatically approved waitlisted user receives the correct approval email and can sign up.
- Auto-accept can be turned on/off.
- Auto-accept-after-X-days is configurable.
- Admin controls are simple and understandable.
- Duplicate submissions are safe.
- Email sending is idempotent.
- Invite links are secure.
- State transitions are auditable.
- Critical paths have unit, integration, and E2E tests.
- Performance/load tests exist with clear thresholds.
- Observability exists for failures, conversion, latency, queue depth, and email health.
- The system can handle thousands of clicks per hour with measured evidence, not assumptions.

Deliverables

Provide:
- Summary of current onboarding/waitlist architecture.
- List of bugs, gaps, and risks found.
- Exact changes made.
- Data model/state machine changes.
- Email flow changes.
- Admin control changes.
- Security hardening changes.
- Performance hardening changes.
- Test coverage added.
- Benchmark/load test results.
- Commands run.
- Remaining blockers, if any, separated into:
  - missing credentials
  - missing product decision
  - missing infrastructure
  - deferred non-critical polish
```

I’d add this instruction at the top when giving it to an implementation agent:

```text
Do not stop at planning. Implement the fixes you can safely make in this repo. When credentials, production email provider access, or deployment-only systems are unavailable, add mocks/test doubles, document the blocker, and leave the production integration path explicit.
```

And this as the minimum success metric:

```text
The critical path is only considered done when these four flows pass automated tests:
1. chat onboarding -> immediate approval -> signup -> welcome email
2. chat onboarding -> waitlist -> waitlist email
3. waitlist -> manual approval -> invite email -> signup
4. waitlist -> auto-accept after configured days -> invite email -> signup
```


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
