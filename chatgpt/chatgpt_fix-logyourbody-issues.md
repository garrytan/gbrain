---
title: "Fix LogYourBody issues"
type: note
created: 2025-08-02
updated: 2025-08-02
source: chatgpt-export
conversation_id: 688d944a-f610-8328-93a6-e434c88095f7
message_count: 4
tags: [chatgpt, import]
---
# Fix LogYourBody issues

> Conversation ID: 688d944a-f610-8328-93a6-e434c88095f7
> Created: 2025-08-02T04:30:04Z
> Updated: 2025-08-02T04:30:44Z
> Messages: 4

---

## User

Give me a prompt to go through logyourbody and fix anything that isn't working as it should.

---

## Assistant

**Copy-paste this into your favorite code-copilot and hit “go.”**

---

**Prompt**

> **Role:** Senior full-stack engineer with CI/CD access.  
> **Codebase:** LogYourBody  
> &nbsp;&nbsp;• iOS – Swift/SwiftUI + HealthKit, Fastlane, GitHub Actions  
> &nbsp;&nbsp;• Web – Next.js (React/TS), Tailwind, Supabase, Clerk, Cloudinary  
> **Mission:** Find **anything** that’s broken, flaky, mis-wired, or non-compliant and make it work—no excuses.  
>   
> **Procedure**  
> 1. **Pull & bootstrap**  
> &nbsp;&nbsp;• `git clone … && git checkout main`  
> &nbsp;&nbsp;• Install deps (`bun install` / `pnpm i`, Cocoapods/SPM)  
> 2. **Static sanity**  
> &nbsp;&nbsp;• Run linters: ESLint, SwiftLint; auto-fix where possible.  
> 3. **Automated test pass**  
> &nbsp;&nbsp;• `fastlane test` for iOS; `pnpm test && pnpm cypress run` for Web.  
> &nbsp;&nbsp;• For every failure: locate root cause → patch → commit (`git commit -m "fix: …"`). Re-run until **green**.  
> 4. **Build & run**  
> &nbsp;&nbsp;• iOS: `xcodebuild -scheme LogYourBody -configuration Release`  
> &nbsp;&nbsp;• Web: `pnpm build && pnpm start`  
> &nbsp;&nbsp;• Fix any build/runtime errors or warnings ≥ “⚠️ Deprecated”.  
> 5. **UX smoke test**  
> &nbsp;&nbsp;• Launch simulators/browsers → walk through core flows (sign-up, HealthKit sync, photo upload, DEXA import, analytics dashboard).  
> &nbsp;&nbsp;• Note glitches, crashes, API 4xx/5xx; patch and add regression tests.  
> 6. **Architecture hygiene**  
> &nbsp;&nbsp;• Enforce atomic design (atoms/molecules/organisms) across Web UI; merge duplicates; move logic out of atoms.  
> &nbsp;&nbsp;• Ensure naming conventions are consistent (`PascalCase` components, `kebab-case` files).  
> 7. **Performance pass**  
> &nbsp;&nbsp;• Profile startup, largest contentful paint, and heavy SwiftUI views; eliminate obvious bottlenecks.  
> 8. **CI verification**  
> &nbsp;&nbsp;• Run the full GitHub Actions pipeline; ensure build, tests, and deploy previews succeed.  
> 9. **Deliverable**  
> &nbsp;&nbsp;• Push to `fix/all-the-broken-stuff` branch, open PR with summarized changelog and screenshots.  
> 10. **Exit criteria:** No failing tests, no build warnings, zero reported crashes, lint clean, flows work end-to-end.

> **Constraints**  
> • Keep code idiomatic (Swift >5.9, React 19).  
> • No breaking API changes without migration helpers.  
> • Write clear commit messages; squash-merge when approved.

---

That’s it—let the bot earn its keep.

---

## User

Focus only on ios

---

## Assistant

**iOS-only Fix-Everything Prompt**

> **Role:** Senior iOS engineer with full repo + Fastlane access  
> **Target:** *LogYourBody* (Swift/SwiftUI, HealthKit, Cloudinary, Clerk, Supabase)  
> **Objective:** Find and fix every defect, warning, or flaky behavior in the iOS app until the test suite is 100 % green and the build ships clean.

---

### 1. Bootstrap
1. `git clone … && git checkout main`
2. `bundle install && pod install` (or `swift package resolve` if pure SPM)  
3. Open `LogYourBody.xcworkspace`

### 2. Static Checks
* Run `swiftlint --fix`  
* Address any remaining violations manually. Commit: `chore(lint): clean up`

### 3. Test Pass
* `fastlane test` (unit + UI tests)  
* For every failure: diagnose → patch → add/extend test → `git commit -m "fix(test): …"`  
* Repeat until **zero red**.

### 4. Build & Run
* `xcodebuild -scheme LogYourBody -configuration Release`  
* Launch on latest iOS simulator + one older iOS version.  
* Eliminate **all** build warnings (treat warnings as errors).

### 5. Core-Flow Smoke Test
Walk these flows and fix anything off:
1. Onboarding → Clerk auth  
2. HealthKit permission + sync  
3. Progress-photo capture & Cloudinary upload  
4. DEXA PDF import & parsing  
5. Dashboard metrics update

Add UI tests for any bug you squash.

### 6. Crash & Log Scrub
* Pull latest Firebase/Crashlytics (or local crash logs) → reproduce → patch.  
* Silence noisy console logs; convert unavoidable ones to `os_log(.debug, …)`.

### 7. Performance Pass
* Instruments → Time Profiler + Main Thread Checker on startup and photo upload.  
* Optimize obvious bottlenecks (e.g., heavy SwiftUI views, blocking I/O).  
* Ensure animations stay ≤ 16 ms per frame.

### 8. CI Verification
* Run the full GitHub Actions pipeline (`yarn ios-ci` or similar).  
* Confirm: build, tests, code-sign, and TestFlight upload all succeed.

### 9. Deliverable
* Push branch `fix/ios-sweep`  
* Open PR with changelog summarizing fixes, screenshots/GIFs of core flows, and before/after metrics.  
* Title: **“iOS: zero-bug sweep”**

**Exit criteria:**  
* 0 failing tests  
* 0 build warnings  
* 0 open Crashlytics issues  
* All primary flows pass on device and simulator  

—Go make it bulletproof.
