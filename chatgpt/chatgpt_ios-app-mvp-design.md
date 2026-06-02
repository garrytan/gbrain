---
conversation_id: 69dd4d2a-7af0-83e8-903f-39ab4603d92b
created: 2026-04-13
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: iOS App MVP Design
type: note
updated: 2026-04-13
---

# iOS App MVP Design

**Related:** [[design_ux]]

> Conversation ID: 69dd4d2a-7af0-83e8-903f-39ab4603d92b
> Created: 2026-04-13T20:08:11Z
> Updated: 2026-04-13T20:32:09Z
> Messages: 4

---

## User

Heyo, really quickly, just imagining what an iOS app can look like for Jovi, and basically, what I'm trying to achieve is knowing what the final version of the app will look like and then working backwards to the minimum viable slice so that we can launch something like today that does barely anything, but exists on an iPhone, and then add little slices and iterate quickly rather than doing a long build of something and then not really understanding what it is. So like, the bare minimum I'm thinking that makes sense is you have an iOS app, it's got an icon, it opens, it's got a splash screen. There's an auth flow where you can sign up and create an account, or you can log in. And then we show you, once you log in, the dashboard shows a big QR code, and then jobee.ie slash tip, or whatever your profile link is, right underneath it. And then it just becomes a way that you can share that QR code with people, and, you know, and then, you know, and that's it. Then it can be a thing where later we could introduce like NFC stuff or whatever. And then we could introduce like a releases screen where you can see all of your releases and then share QR codes for those with people, or, you know. Maybe you tap on every release and the right drawer opens up as a full-screen page and you can edit things. You can edit your profile. You know, you can show someone your profile as a full-screen thing rather than it being in a browser, etc. So it would basically start to let you do all these things. Task manager, so you can see all the tasks you have for all your releases and stuff. And then even allowing you to create new releases or do like voice memos and create voice memos on your phone and stuff. And then also, moving into mobile makes it easy for us to generate social sharing assets and stuff and for you to quickly share things on social. So if you quickly have a place where you can see all your releases and then copy them and paste the links into DMs, or you have, you know, you're on mobile and you can save assets to then upload on other apps, like social apps and stuff, then it becomes a pretty powerful thing. But all I want to ship is you can log in and there's a QR code. Like that's it. That's all I want to ship. However, when I start adding all these other features, I don't want to go back and have to redo infrastructure. So that's what I'm trying to think about. So I'm building a plan right now, and I'm going to show you the premise for the plan. And I want you to tell me if any of these 12 premises are wrong and should not be handled the way they're handled. But I'll share them below. But basically, yeah, just tell me if that's right or not. And they don't, you know, we don't really have... Yeah, that's kind of where I'm at.

PREMISES (REVISED):

1. The iOS app is an API client, not a database client. It calls jov.ie/api/*
   endpoints. RLS enforcement happens server-side via Clerk bearer token →
   withDbSession() → set_config('app.clerk_user_id'). No Drizzle on iOS.

2. State management: @Observable + MVVM. Not TCA (overkill for current scope,
   adds learning curve). TCA is a future option if cross-screen state gets complex.

3. Local persistence: SwiftData for offline cache + mutation queue. Not GRDB
   (SwiftData is more idiomatic for SwiftUI), not Core Data (legacy boilerplate).

4. Networking: URLSession + async/await only. No Alamofire, no Moya. Protocol-
   based APIClient with request interceptor for Clerk token injection.

5. Image caching: Nuke (production-grade, pipeline architecture). Not AsyncImage
   (no disk cache, no processing).

6. AI chat: Call the existing /api/chat endpoint with URLSession streaming (SSE).
   No separate AI SDK needed. Parse Server-Sent Events from the same Vercel AI
   SDK stream the web uses. Same rate limits, same tool gating, same models.

7. Offline strategy: Read-through cache (SwiftData local store), write-back queue
   for mutations. APNs for server-push invalidation (future). TTL-based expiry
   for now. Profile data cached aggressively (changes rarely), chat not cached.

8. Secure storage: Keychain via native Security framework for Clerk tokens. Not
   UserDefaults. Not a third-party wrapper.

9. New API endpoints needed: Not just GET /api/mobile/me. A proper mobile API
   surface: GET /api/mobile/me, GET /api/mobile/releases, PUT /api/mobile/profile,
   POST /api/mobile/chat (or reuse /api/chat with CORS). Version-free, same auth.

10. CI/CD: Fastlane + GitHub Actions for TestFlight distribution. Not just
    xcodebuild. Fastlane match for code signing.

11. gstack integration: gstack doesn't run inside the iOS app. It helps during
    development: /qa can test the API endpoints, /browse can verify the web
    fallback, /review catches issues in PRs touching apps/ios/. No iOS-specific
    gstack skill needed yet.

12. Developer experience: Xcode previews with mock data for every screen, protocol-
    based DI so every dependency is swappable, Swift Testing framework (not legacy
    XCTest), fast package-level unit tests that don't boot a simulator.

---

## Assistant

I’m checking your premises against current Apple, Clerk, Vercel, and library docs, then I’ll mark each one as solid, needs adjustment, or risks rework later.

---

## Assistant

A few corrections are already clear: use Clerk’s iOS SDK for auth and token storage, version the mobile API from day one, and keep SwiftData as an optional cache seam.

---

## Assistant

Mr. White, this is mostly right.

I would keep 1, 2, 4, 10, and 11.
I would revise 3, 6, 7, 8, 9, and 12.
I would treat 5 as optional later infrastructure rather than a foundational decision.

One missing premise matters a lot: this stack effectively sets your minimum iOS version to 17. SwiftUI Observation support starts at iOS 17, SwiftData is iOS 17+, and Clerk’s current iOS SDK requires iOS 17+ and Xcode 16+. If that floor is acceptable, the rest of the plan gets much cleaner. citeturn153543search1turn153543search7turn153543search25turn475343search0

1. Keep.  
The app should be an API client only. Clerk’s model for authenticated backend calls is a session token sent to your backend, typically in the `Authorization` header for cross-origin or native requests, with server-side verification on each request. That boundary is correct and future-proof. citeturn929440view6turn929440view7

2. Keep.  
`@Observable` + MVVM is a good default for this app size. Apple’s Observation system is first-party and supported by SwiftUI on iOS 17+. I would add one lightweight app router/coordinator for auth gating and deep links. citeturn185410search1turn153543search1

3. Revise.  
SwiftData is fine for local caching. Apple has kept adding indexing, persistent history, schema migration, and custom store capabilities, so it is a real option now. I would still keep SwiftData behind repository protocols and I would not build a generalized offline mutation queue yet. Your QR-only first release has no meaningful post-login write path. citeturn153543search16turn185410search18turn153543search19turn185410search22

4. Keep, with one fix.  
`URLSession` + async/await is the right choice. Inject the bearer token on each `URLRequest`. Apple explicitly says you should not set `Authorization` through `URLSessionConfiguration.httpAdditionalHeaders`. `URLSession.AsyncBytes` is available when you need streaming. citeturn273801search0turn273801search16turn273801search27

5. Optional later.  
Nuke is a solid choice once you have avatars, artwork, release covers, and image-heavy screens because it has a real pipeline plus memory and disk caching. It is irrelevant to the QR-only launch. You can ship the first version with zero remote-image infrastructure and generate the QR locally from the profile URL. citeturn229973search0turn229973search6

6. Revise slightly.  
Reusing the same backend capability for chat is good. Binding the iOS client to “whatever stream format the web currently emits” is the risky part. Vercel AI SDK supports multiple response helpers and stream shapes, including data streams, UI message streams, and SSE consumption. I would either freeze that wire contract deliberately or add `/api/mobile/v1/chat` as a thin adapter over the same core chat service. citeturn709238search11turn709238search0turn709238search10turn273801search16

7. Revise.  
TTL cache is fine as a first pass. APNs invalidation should be treated as an optimization only. Apple documents that background notifications can wake your app for updates, and it also documents limits on silent/background notifications. Your correctness path should be foreground refresh and explicit refetch, with pushes improving freshness when they arrive. citeturn772669search0turn772669search14

8. Revise.  
Keychain is the right storage class for secrets. I would let the Clerk iOS SDK own auth state and flows instead of building your own raw token storage layer. Clerk’s iOS SDK already gives you app-level configuration plus native SwiftUI auth views, which is the fastest path to your first release. Use direct Keychain access for app secrets Clerk does not manage. citeturn273801search1turn273801search7turn165215search2turn165215search0

9. Revise materially.  
A mobile-specific API surface is correct. “Version-free” is the part I would reject. Versioning exists to handle breaking changes safely while older clients keep working, and that matters more on mobile because old app versions stay in circulation. I would start with `/api/mobile/v1/me` and return everything the dashboard needs in one payload. Add `/releases`, `/profile`, `/tasks`, and `/chat` only when those screens actually ship. citeturn292140search12turn292140search10turn292140search15

10. Keep.  
Fastlane + GitHub Actions + `match` is a standard release path. fastlane’s own docs show `setup_ci`, `match`, `build_app`, and `upload_to_testflight`, and `match` is explicitly designed to share signing credentials across a team. citeturn929440view9turn929440view10

11. Keep.  
This is a dev workflow decision, not a runtime architecture decision. The gstack repo describes `/review`, `/qa`, and `/browse` as slash-command tooling for planning, review, browser QA, and release workflow. Keeping that out of the app runtime is correct. citeturn559624view0

12. Revise slightly.  
Xcode previews with mocks, protocol DI, and package-level unit tests are all good decisions. I would use Swift Testing by default for new unit tests. I would not ban XCTest. Apple explicitly supports running Swift Testing and XCTest side by side, which is useful for migration and for UI or integration layers. citeturn731059search7turn731059search9turn153543search26turn731059search13

Two extra premises I would add:

First, if you use Clerk native iOS, you need to enable Clerk’s Native API and set up associated domains. That is launch-critical for auth to behave cleanly. citeturn312873search1turn165215search2

Second, your first release should be built around one server response and one local screen model. I would make that resource `MobileMeResponse` with fields like `displayName`, `publicProfileURL`, `qrPayload`, `avatarURL`, and `hasCompletedOnboarding`. Everything else can grow around that.

What I would actually ship now:

Use Clerk’s `AuthView` for sign-in and sign-up. It already handles the auth surface natively in SwiftUI. citeturn165215search0turn165215search2

Build one endpoint: `GET /api/mobile/v1/me`.

Generate the QR on device from `publicProfileURL` or `qrPayload`.

Show one dashboard screen with the QR and share actions.

Skip SwiftData, Nuke, offline queue, releases APIs, chat, and APNs until a shipped screen actually needs them.

That gets you the wedge you want today without painting yourself into a corner.


**Topic:** [[chatgpt-clusters/coding_mobile]]


## See Also
- [[chatgpt/chatgpt_3d-muffin-head-design]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_ai-design-review-tools]]
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_ai-platform-design-ideas]]
