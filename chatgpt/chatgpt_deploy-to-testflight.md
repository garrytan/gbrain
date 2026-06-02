---
conversation_id: 692243b6-f910-832a-a21c-e8bec1ac51f5
created: 2025-11-22
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Deploy to TestFlight
type: note
updated: 2025-11-22
---

# Deploy to TestFlight

**Related:** [[coding_mobile]]

> Conversation ID: 692243b6-f910-832a-a21c-e8bec1ac51f5
> Created: 2025-11-22T23:14:03Z
> Updated: 2025-11-22T23:14:28Z
> Messages: 2

---

## User

How to deploy to testflight

---

## Assistant

Here’s the current, standard way to get a build onto TestFlight, Mr. White. This is all through Xcode + App Store Connect. citeturn0search0turn0search1turn0search11

### 0) Preconditions (do once)
1. **Apple Developer Program membership** (paid).  
2. **App record exists in App Store Connect**  
   - App Store Connect → **Apps** → **+** → New App.  
3. In Xcode, your target has:
   - **Bundle Identifier** that matches the App Store Connect app
   - **Version** (e.g., 1.2) and **Build number** (e.g., 45).  
4. Fix signing:
   - Xcode → Target → **Signing & Capabilities** → pick your Team.
   - Use “Automatically manage signing” unless you know you need manual. citeturn0search12

### 1) Archive the app in Xcode
1. Select **Any iOS Device (arm64)** or “Generic iOS Device” as the run destination (not a simulator).
2. **Product → Archive**.  
3. When the archive finishes, Organizer opens. citeturn0search1

### 2) Upload the archive to App Store Connect
1. In Organizer → **Distribute App**.
2. Choose **App Store Connect**.
3. Choose **Upload**.
4. Follow prompts:
   - Sign in
   - Select your app
   - Let Xcode manage signing
   - Finish upload. citeturn0search1turn0search2turn0search4

After upload, App Store Connect will **process** the build (usually a few minutes). You’ll see it under TestFlight once processing completes. citeturn0search11

### 3) Enable TestFlight testing
Go to App Store Connect → **Apps** → your app → **TestFlight**.

#### Internal testing (fastest)
1. Under **Internal Testing** → **+** create a group.
2. Add internal testers (must be in your App Store Connect team).
3. Add the processed build to that group.  
Internal testers can install immediately—no beta review required. citeturn0search10turn0search11

#### External testing (needs Beta App Review)
1. Under **External Testing** → **+** create a group.
2. **Add Builds** to that group.
3. Fill in required TestFlight info (what to test, contact email, etc.).
4. **Submit for Beta App Review**.  
Once approved, you can invite up to 10k external testers by email or public link. citeturn0search3turn0search11turn0search14

### 4) Testers install
Testers download the **TestFlight app**, accept your invite/public link, and install your build. Builds stay available for **90 days**. citeturn0search11

---

## Common “why don’t I see my build?” fixes
- **Still processing** in App Store Connect → wait a bit, refresh. citeturn0search11
- **Wrong bundle ID** or uploading from a different target/scheme.
- **Build number didn’t increment** — App Store Connect rejects duplicates.
- **Signing mismatch** — ensure the same Team + bundle ID.
- **Export compliance/encryption question** blocking external testing submission. citeturn0search11
- Using too-old Xcode for current SDK requirements (Apple periodically enforces minimum Xcode/SDK versions). citeturn0search5turn0search6

---

If you want, tell me your setup (UIKit/SwiftUI, iOS-only vs multi-platform, manual vs auto signing), and I’ll tailor the exact clicks/screens to your case.


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_testflight-review-process]]
- [[chatgpt/chatgpt_xcode-vs-testflight-performance]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
