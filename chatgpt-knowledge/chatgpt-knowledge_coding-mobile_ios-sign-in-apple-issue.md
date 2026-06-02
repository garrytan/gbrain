---
title: "iOS Sign In Apple Issue"
type: guide
created: 2025-07-09
updated: 2025-07-09
source: chatgpt-export
topic: coding-mobile
message_count: 8
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# iOS Sign In Apple Issue

> **Source:** ChatGPT conversation
> **Date:** 2025-07-09T23:50:24Z
> **Messages:** 8
> **Topic:** coding-mobile

## Question

How an i improve the I'm going to log your body app on our iOS app. Oh, sign in with Apple, we're having issues. So on the iOS app, when I get to the authentication page, I hit the sign in with Apple. It runs through the whole process and then throws up a message saying that sign in with Apple is not configured properly. And then to use sign in with email. When I do the same thing on the web app, it goes through the whole flow fine and authenticates. And then I'm able to use the app. They're both using the same instance on Clerk. It's a production instance and it's configured effectively the same way. So my assumption would be that somewhere in the Xcode app, we're not properly calling the Clerk sign in with Apple. And maybe we're trying to use a native one or something that didn't sign up or something. I'm not really sure. Can you write out a concise issue ticket that I can send our devs for that?

## Answer

Sure — here’s a concise issue ticket you can send your devs:

---

**Title:** iOS App: "Sign in with Apple" Not Configured Properly Error

**Priority:** High  
**Environment:** iOS App (Production)  
**Clerk Instance:** Production (same as Web)

**Issue:**  
When attempting to sign in with Apple on the iOS app, the flow runs but ends with an error:  
> "Sign in with Apple is not configured properly. Please use sign in with email."

This issue does *not* occur on the web app using the same Clerk production instance, where Sign in with Apple works correctly.

**Expected Behavior:**  
User should be able to complete Apple sign-in successfully on iOS, just like on web.

**Hypothesis:**  
Possible misconfiguration in the Xcode app setup — likely not using Clerk's iOS SDK integration for Sign in with Apple. May be defaulting to native `ASAuthorizationAppleIDProvider` flow without completing the Clerk `oauth()` or `signInWithProvider()` step.

**To Investigate:**  
- Confirm Clerk's iOS SDK is handling the Sign in with Apple flow (not a custom native implementation).  
- Check `Info.plist` for proper `Sign In with Apple` entitlements.  
- Validate redirect URIs and associated domains match Clerk config.  
- Verify iOS bundle ID is registered under Apple sign-in provider in Clerk dashboard.  

**Notes:**  
Web app works fine — this is iOS-only.

--- 

Let me know if you want this in GitHub issue format or JIRA markup.

## Question

Are we conveyed properly? Look at the sign-up view page.

## Answer

Your **SignUpView.swift** does include an `AppleSignInButton()` UI component, but it’s unclear if this button is actually wired to Clerk's Sign in with Apple logic. Here’s what might be missing or needs verification:

---

### 🔍 Potential Issues in `SignUpView.swift`

1. **`AppleSignInButton()` is a placeholder**  
   There’s no visible logic handling what happens when the Apple Sign-In button is tapped. If you're using Clerk, you need to explicitly call something like:

   ```swift
   Clerk.shared.signInWithProvider(.apple)
   ```

   or use their Swift SDK equivalent if wrapping this in your own AuthManager method.

2. **No `onTapGesture` or `.onPress` handler**  
   The current button:
   ```swift
   AppleSignInButton()
       .frame(height: 48)
       .allowsHitTesting(true)
   ```
   is UI only. Without an action handler, it won’t initiate authentication.

3. **Missing OAuth redirect logic**  
   Clerk expects a redirect from the Apple flow to route back into the app. You need to ensure your `AppDelegate` or `SceneDelegate` handles:

   ```swift
   application(_:open:options:) // or
   scene(_:openURLContexts:)
   ```

   And routes the URL to Clerk.

4. **Missing `.signInWithAppleButtonStyle` if you're using Apple’s native button**  
   If `AppleSignInButton()` is custom, fine. But if it's `ASAuthorizationAppleIDButton`, ensure you handle the delegate properly.

---

### ✅ What You Should Add

If you're using Clerk’s SDK, your button action should call your AuthManager to do this:

```swift
Button(action: {
    Task {
        do {
            try await Clerk.shared.signIn(with: .apple)
        } catch {
            // handle error
        }
    }
}) {
    AppleSignInButton()
        .frame(height: 48)
}
```

Or in your `AppleSignInButton()` wrapper, you must include that behavior.

---

### Recommendation

Inspect your `AppleSignInButton()` view component. If it’s just a styled UI component, wire it to an action that calls Clerk’s sign-in logic. If it wraps native `ASAuthorizationAppleIDProvider`, replace it with Clerk’s `signInWithProvider(.apple)` call instead.

## Question

Well, we are using the SDK, but we want to make sure that the auth happens not in a mini-browser, but like actually in the native iOS thing. So how should we do that?

## Answer

To use **Clerk's Sign in with Apple** on iOS *with native UI (ASAuthorizationController)* instead of the mini-browser OAuth flow, you’ll need to:

---

### ✅ Use Clerk's Native Apple Sign-In Support

Clerk's iOS SDK supports native Sign in with Apple by default — **but only if you configure it correctly**. Here's what to ensure:

---

### 1. **Clerk Configuration (Backend & Dashboard)**
- **Apple Sign-In must be enabled** in your Clerk dashboard under **OAuth** → **Apple**.
- **Bundle ID and Apple service ID** must be correctly registered.
- The redirect URI must include your iOS scheme: `clerk.your-app://oauth-callback`

---

### 2. **Add Native Apple Sign-In in SwiftUI**
Use Clerk’s SDK method for Apple sign-in **with the `native` strategy**:

```swift
import ClerkSDK

Button(action: {
    Task {
        do {
            try await Clerk.shared.signIn(with: .apple, strategy: .native)
        } catch {
            print("Apple sign-in failed: \(error.localizedDescription)")
        }
    }
}) {
    SignInWithAppleButton()
        .frame(height: 48)
}
```

> ⚠️ `strategy: .native` tells Clerk to use `ASAuthorizationAppleIDProvider` under the hood instead of launching a Safari view.

---

### 3. **Handle Redirects (Needed for Web Fallbacks Only)**
If you want to support both native and fallback OAuth (web), ensure your app can handle the OAuth callback:

```swift
// In your SceneDelegate (for UIKit)
func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    if let url = URLContexts.first?.url {
        Clerk.shared.handle(url)
    }
}
```

---

### 4. **Ensure `Sign in with Apple` Capability is Enabled**
In Xcode:
- Go to **Signing & Capabilities**
- Add **Sign In with Apple**
- Ensure your Bundle ID is registered with Apple Developer account for this capability

---

### 🔥 Final Integration Summary

- ✅ Call `Clerk.shared.signIn(with: .apple, strategy: .native)`
- ✅ Handle any redirect URLs (for fallback)
- ✅ Confirm Apple setup in both Clerk dashboard and Apple Developer portal
- ✅ Enable Sign in with Apple in Xcode project

---

Let me know if you want me to inspect or rewrite your `AppleSignInButton` wrapper to reflect this.

## Question

Yes lets add it to the signupview

## Answer

Done. The Sign in with Apple button in `SignUpView.swift` now uses Clerk's native sign-in strategy via `Clerk.shared.signIn(with: .apple, strategy: .native)`. Let me know if you want the same added to the sign-in screen as well.
