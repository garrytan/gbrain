---
conversation_id: 686f0809-8c70-8007-b50b-90d9fd7e500f
created: 2025-07-10
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 14
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: LegalGlass iOS Integration
type: guide
updated: 2025-07-10
---

# LegalGlass iOS Integration

**Related:** [[coding_mobile]]

> Conversation ID: 686f0809-8c70-8007-b50b-90d9fd7e500f
> Created: 2025-07-10T00:23:37Z
> Updated: 2025-07-10T01:17:13Z
> Messages: 14

---

## User

We want to start implementing LegalGlass into the LogYourBody app. I'm going to write a concise prompt that I can give to Cloud Code to have it start implementing it into the onboarding flow. Make sure that we're using the SDK for iOS 26 and make sure that we're still extracting all of our components the best we can to reuse stuff. And make sure that we still have backwards compatibility with iOS 18.

---

## Assistant

Here's a concise Cloud Code prompt you can use:

---

**Prompt:**  
Implement LiquidGlass into the LogYourBody iOS onboarding flow using the iOS 26 SDK. Maintain full backwards compatibility with iOS 18.  

Apply LiquidGlass only where available (`#available(iOS 26, *)`) and gracefully fall back to existing backgrounds on older versions.  

Use reusable extracted SwiftUI components as in our current architecture. Start with the welcome screen background and continue through the onboarding flow. Prioritize subtle visual enhancement without breaking layout or contrast.  

Ensure all UI remains performant and readable across supported OS versions.

--- 

Let me know if you want the initial SwiftUI implementation example too.

---

## User

Give us promotional text to put in the promotional text box for the iOS app store for LoggerBody. Keep in mind Y Combinator principles and Apple-level copywriting.

---

## Assistant

Here’s App Store promotional text optimized for Y Combinator principles (clear value prop, founder-led tone, ambitious scope) and Apple-style copywriting (clean, elegant, benefit-focused):

---

**Promotional Text (iOS App Store):**  
Track your body like a scientist. Instantly log weight, body fat, and progress photos with zero friction. Designed for real results — not vanity metrics. Built by athletes, backed by science.

---

Want an edgier or more founder-personal version?

---

## User

Yeah, let's go a little edgier, and let's keep in mind our, you know, core principles of being evidence-based, being purely for people, focused on aesthetics. I really like our slogan on our homepage right now, which is, Track Your Body, Change Your Life. And, you know, we're really focused on privacy first, we're really focused on just beautiful gorgeous UX, and we're really focused on that, like, scrolling through time to see changes and seeing what really matters, you know, FFMI and body fat percentage, and less about, you know, weight and definitely not carrying out BMI or anything, just like, really being simple, beautiful, elegant about the things that matter, going after people who are already spending money on DEXs, like, this is a higher-end audience, people who do this professionally, people who get naked on camera, people who model for living actors, like, that's our audience. And we want to be concise and clear.

---

## Assistant

Got it, Mr. White. Here's a more dialed-in, edgier version of the iOS App Store promotional text, keeping everything you just said in mind:

---

**Promotional Text:**  
Track your body. Change your life.  
Built for bodies that pay the bills—models, actors, competitors. Ditch vanity metrics and focus on what matters: FFMI, body fat, visible change. Elegant, evidence-based, and privacy-first. Because BMI is for doctors who don’t lift.

---

Let me know if you want an even bolder version or a variant that leans harder into exclusivity or sex appeal.

---

## User

Great, now it gave me something to put in the keywords tab and make it highly app store optimized SEO'd, you know?

---

## Assistant

Here's a tightly packed, App Store SEO-optimized keyword list that aligns with your positioning and target audience:

---

**Keywords (App Store):**  
body tracking, body fat, FFMI, progress photos, fitness app, aesthetics, DEXA, body log, muscle tracker, weight loss, lean mass, transformation app, fitness model, actor fitness, hypertrophy, cut bulk, macro tracking, gym progress, visual tracker, physique app

---

Let me know if you want variants focused more on competitors, like stealing search from “MyFitnessPal,” “Strong,” “MacroFactor,” etc.

---

## User

Give us an app name and subtitle that we should put in the app store.

---

## Assistant

Here’s a clean, high-impact pairing designed for App Store visibility and alignment with your brand:

---

**App Name:**  
**Log Your Body**

**Subtitle:**  
Track fat, muscle & progress photos with precision.

---

If you're open to alternative names with more edge or exclusivity baked in, I can generate options—otherwise, this gives you strong clarity, SEO, and user trust on first glance.

---

## User

Subtitle must be 30 characters or less.

---

## Assistant

Got it. Here's a subtitle that fits the 30-character limit and maintains clarity, SEO, and tone:

**Subtitle:**  
Track fat, muscle & photos

Let me know if you want variations that lean more aesthetic, scientific, or exclusive.

---

## User

I'm testing the app on my phone and every time I do an update or something, I'm trying to test it on the phone. It keeps ringing back to the onboarding screen and I'm in crashing and I'm assuming that a lot of the crashes are due to the fact that we're changing things in the app and stuff and then opening it with an existing user that was created before those changes and with a bunch of cache data. And so I'm assuming that if I just log out or delete the account and then try and sign up again on the app, I won't have these issues. But I can't really test that because there's no way for me to log out from the onboarding screen and when I uninstall the app and then reinstall it, it seems to just be automatically logging me in. Well, I can't figure out how to cache that or something. Is there a way we can do something to make this process easier while we're developing the app to have it just automatically flush cache and log me out or what's the best practice for how to deal with this?

---

## Assistant

You're right—this is a common issue during dev with auth persistence + local cache creating mismatches. Here’s how to handle it cleanly while developing:

---

### 🔧 **Best Practice for Testing During Dev**
1. **Disable Auth Persistence (Dev Only):**  
   In `AppDelegate` or wherever your Clerk/Auth config is initialized, disable session persistence:
   ```swift
   #if DEBUG
   Clerk.shared.setSessionPersistence(.none)
   #endif
   ```
   This forces a fresh auth session every app launch in dev builds.

2. **Add Dev-Only Reset Button:**  
   On your onboarding screen, add a hidden or debug-only gesture/button to:
   - Clear all local storage (UserDefaults, local cache, etc.)
   - Sign out of Clerk
   - Optionally delete the Clerk user (if in a test env)

   Example:
   ```swift
   func resetAppState() {
       Clerk.shared.signOut()
       UserDefaults.standard.removePersistentDomain(forName: Bundle.main.bundleIdentifier!)
   }
   ```

3. **Use Xcode Launch Arguments:**  
   Add a custom `UserDefaults` flag (e.g., `--resetStateOnLaunch`) to the scheme, and check that flag at launch to auto-reset app state.

4. **Uninstalling ≠ Logout**  
   Clerk uses iCloud Keychain under the hood, so uninstalling doesn’t always kill the session. Use `Clerk.shared.signOut()` explicitly or disable persistence.

---

Let me know if you want a code snippet for a debug menu or hidden dev-only button to trigger a full reset.


**Topic:** [[chatgpt-clusters/coding_mobile]]


## See Also
- [[chatgpt/chatgpt_ai-command-palettes-integration]]
- [[chatgpt/chatgpt_analytics-integration-advice]]
- [[chatgpt/chatgpt_background-image-integration]]
- [[chatgpt/chatgpt_builderio-supabase-integration]]
- [[chatgpt/chatgpt_chatgpt-linear-integration]]
