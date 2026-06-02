---
title: "Nikita Bier Growth Hacks"
type: essay
created: 2025-07-04
updated: 2025-07-04
source: chatgpt-export
topic: coding-mobile
message_count: 19
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# Nikita Bier Growth Hacks

> **Source:** ChatGPT conversation
> **Date:** 2025-07-04T21:11:01Z
> **Messages:** 19
> **Topic:** coding-mobile

## Question

Nikita Bear, creator of GasApp, and who was just added as the product manager, head of product at Twitter, or X, whatever it's called. I know him a little bit. We've followed each other for a while. But somewhere, I seem to remember him tweeting a thread, talking about everything that he's learned or something, over all his time building mobile apps, and advice. And I know he specifically listed some growth hacks and stuff, like waiting for... Some trick he did, like holding notifications until you open the app, and then after you open the app for a second, immediately popping up the notification for something that had previously happened, to make it feel like there's more engagement happening and stuff. And he had a bunch of tricks like that, that I remember him talking about. But I'm trying to... I'm trying to see... I want to know what all it is, all the different tricks and stuff that he's shared. But also, I seem to remember some thread, and this might be by someone else, I could 

## Answer

Here’s what I found, Mr. White:

**1. Nikita Bier’s “10 Years Building Consumer Social Apps” thread**  
In January 2022, Nikita unrolled a 25-tweet thread sharing his top lessons from a decade of building social apps. Key takeaways (11 total) include:  
- **Prioritize testing over ideas.** Build repeatable testable experiments first.  
- **Target a narrow wedge.** Big things grow from small, passionate audiences.  
- **Design for clear data.** Simple UI changes that make user behavior obvious are more valuable than endless features.  
- **Leverage network effects.** If you can get 7 friends to install on demand, you’ve solved the hardest part.  
- **Make signup frictionless.** Short, Yup/No flows and prefilled phone-number verification hit highest conversion.  
- **Build into routines.** Tie your app’s core action to an existing daily habit.  
- **Solve a core need.** Nail the single most meaningful thing before layering on “nice-to-haves.”  
- **Expand from the wedge.** A product that works repeatedly in one community will scale to similar ones.  
- **Ride inflection points.** Launch where and when life transitions boost adoption.  
- **Obsess on retention.** Retain your first users by over-investing in their experience.  
- **Fail small, learn fast.** Every product decay risk is caught sooner with more “shots on goal.” citeturn1view0  

**2. Growth-hacking “tricks” from his Explode app**  
An in-depth analysis of Nikita’s most recent app, Explode, surfaces several “ninja moves”:  
- **ASO hack via dev-account naming.** He published Explode under a subtly braggable company name in the App Store to boost search relevance.  
- **Faux notification pop-up.** On first launch, a custom pop-up mimicking Apple’s allows “Allow” only—conditioning users to accept real push prompts later.  
- **Deferred “hot” notifications.** Delay delivery of backend events until the app is in foreground, then fire them all at once—making users feel like there’s nonstop activity.  
- **PiP onboarding** with clear progress indicators and a “Not Now” skip option for out-of-app steps (e.g. adding to iMessage). citeturn2search0  

**3. “Use-these-services” infra stack**  
While I couldn’t locate that exact Twitter thread, developers frequently advise:  
- **Auth0** for authentication—drop-in identity so you don’t build your own auth citeturn11search1  
- **Stripe** for payments—battle-tested billing and subscriptions citeturn11search1  
- **GraphQL** for your API layer—avoids over- and under-fetching on mobile citeturn11search9  

I also found a community post recommending:  
> *Mobile app:* React Native; *Auth:* Auth0; *Payments:* Stripe; *Infra:* any AWS services that make sense citeturn11search8  

**4. Other high-leverage mobile-app best practices**  
- **Start with proper research** and a lean MVP.  
- **Design your core UX early** and test on real devices.  
- **Automate CI/CD and testing** to catch regressions fast.  
- **Instrument analytics & A/B tes

*(Answer truncated — 3282 chars total)*

## Question

I wanna find that specific thread i was talking about. It might not be from Nikita but it was a twitter thread that had all the infrastructure things to use and it definitely recommend auth0, stripe, and graphql among other things

## Answer

Got it. To help track down the specific thread you're referring to, could you clarify a few things:

1. Approximately when do you remember seeing the thread? (e.g., this year, last year, 2+ years ago)
2. Do you remember any keywords, phrases, or usernames that might have been in the thread or the handle of the person who posted it?
3. Was it focused only on infrastructure/tools for mobile apps, or did it include broader advice about building/launching apps?

The more detail you can recall, the better chance I have of finding it accurately.

## Question

It was probably sometime between 2022 and 2024 and it definitely has a single tweet per recommendation in one big thread and it was all about building apps (idk if it was mobile specific or not) and it was like specifically leaning into the idea of trying to minimize how much reinventing the wheel you do and just get to the point fast

## Answer

Understood. I’ll track down the specific Twitter thread you’re referring to—likely posted between 2022 and 2024—that lists recommended tools and services like Auth0, Stripe, and GraphQL for building apps quickly without reinventing the wheel. I’ll also gather the full list of recommendations from that thread if found.

I’ll update you as soon as I locate it.

## Answer

# SaaS Infrastructure Recommendations Twitter Thread (Auth0, Stripe, GraphQL, etc.)

## Context and Thread Overview
The thread in question appears to be **“Technical Design Patterns for SaaS”** posted on Twitter by Brandon Bayer ([@flybayer](https://twitter.com/flybayer)). This multi-tweet thread (circa 2020) outlines a comprehensive stack of tools and practices to build SaaS applications quickly while **“build[ing] as little as possible”** and focusing on speed and product quality【12†L24-L31】. It emphasizes using proven third-party services (like Auth0 for auth, Stripe for payments via external billing systems, GraphQL for APIs, etc.) to avoid reinventing the wheel and to **“get to the point fast.”** Below is a breakdown of the key recommendations from that thread, organized by category.

## Frontend Frameworks and Developer Tools
- **Use React or Vue for UI:** The thread suggests using a modern frontend framework such as **React** (or **Vue**) to build rich, maintainable UIs. These have become “boring” (well-established) technologies adopted widely from startups to enterprise, and even enable code-sharing with native via React Native Web for potential mobile apps【12†L35-L42】.  
- **Leverage a Meta-Framework (Next.js/Nuxt.js):** To streamline development, it recommends using frameworks like **Next.js** (for React) or **Nuxt.js** (for Vue). These provide an out-of-the-box optimized environment (handling Webpack, build optimizations, etc.) for fast and efficient UI development【12†L42-L47】. The Chrome team has even worked on Next.js to further improve its performance【12†L42-L47】.  
- **Utility-First CSS or CSS-in-JS:** Instead of writing custom CSS from scratch, the thread advices using utility-first CSS frameworks like **Tailwind CSS** (or, alternatively, CSS-in-JS solutions like Emotion + Theme UI). These give “Lego-like” building blocks to style apps without starting from zero【12†L48-L53】, speeding up styling and making maintenance easier.  
- **TypeScript for Frontend and Backend:** Adopt **TypeScript** across the stack. As a statically-typed superset of JavaScript, TypeScript can prevent many bugs and serves almost like “1,000 unit tests” worth of safety. It improves developer confidence and productivity (with IDE autocompletion, etc.) on both client and server code【12†L76-L83】.  
- **Code Generation with GraphQL + TypeScript:** Use GraphQL together with TypeScript to enable automatic code generation for data fetching. With the right tools, you can define the data requirements and have codegen produce strongly-typed data-fetching functions. This provides IDE auto-complete and compile-time safety for API calls【12†L83-L87】, reducing boilerplate and errors.

## Backend Architecture and API Design
- **Use GraphQL instead of REST:** The thread strongly recommends **GraphQL** as “the modern replacement for REST.” GraphQL simplifies client-server interactions by allowing clients to request exactly the data they need and easily stitch together data fr

*(Answer truncated — 13326 chars total)*

## Question

Typescript in swift?

## Answer

Mr. White, could you clarify what you mean by “TypeScript in Swift”? Are you asking how to:

- Embed or run TypeScript (transpiled to JavaScript) inside a native Swift app?  
- Use a TypeScript-style code-generation workflow for Swift (e.g. GraphQL codegen)?  
- Or something else entirely?

Let me know your goal and I’ll point you to the right approach.

## Question

Can u use typescript in a swift app and should i

## Answer

You can’t “import” TypeScript into native Swift—but since TS compiles down to JavaScript, you **can** embed a JS engine (Apple’s JavaScriptCore, Hermes, Duktape, etc.) in your Swift app and load your TS-compiled JS at runtime.  

**Pros:**  
- Share business-logic between a web app and your iOS app.  
- Iterate JavaScript code without shipping a full native update.  

**Cons:**  
- Performance overhead of a JS VM vs. pure Swift.  
- Debugging gets more complex (bridging, source-maps, async calls).  
- You lose most of Swift’s type-safety, tooling and native APIs.  

**Should you?**  
– **No**, unless you have a compelling need to share a large JS/TS codebase (e.g. a game engine, heavy web-logic or cross-platform business rules).  
– If you just want to write UI and app logic in TS, you’re better off using **React Native** (or Expo) rather than a Swift project.  

For almost all pure-iOS work, stick with Swift (and Swift Package Manager/SwiftGen/SwiftLint) for best performance, stability and developer ergonomics.

## Question

Can i connect claude code and linear to have it import and tackle issues

## Answer

Yes—you can. The high-level pattern is:

1. **Capture new (or updated) Linear issues via webhook or polling.**  
   - In Linear, create an API key and set up a webhook on the “Issue” events you care about (e.g. `issue.create`, `issue.update`).  
   - Alternately, run a cron job that queries the Linear GraphQL API for recently created issues.

2. **Forward each issue to Claude Code via Anthropic’s API.**  
   - When your webhook endpoint fires, extract the issue title/description.  
   - Call the Anthropic Claude Code endpoint (e.g. `claude-code-1.3`) with a prompt like:  
     ```
     You are an expert engineer. Here’s a new issue:
     Title: …
     Description: …
     Please suggest next steps or draft code snippets to address it.
     ```  
   - You’ll get back a structured reply you can parse.

3. **Post Claude’s output back into Linear.**  
   - Use Linear’s GraphQL mutation (`issueCommentCreate` or `issueUpdate`) to add Claude’s suggestions as a comment (or even change the issue status/assignee).  

4. **Deploy as a small serverless function** (e.g. on Vercel, AWS Lambda) or a lightweight Node/Go service.  

---

### No-code alternatives
- **Zapier or Make (Integromat):**  
  - Trigger on “New Issue in Linear.”  
  - Add a “Webhook” action to call Anthropic’s Claude Code API.  
  - Then “Create Comment” in Linear with the response.

- **n8n:** similar flow: Linear node → HTTP Request to Claude → Linear node.

---

### Should you?
- **Use it** if you want automated triage, AI-drafted guidance, or boilerplate code suggestions.  
- **Don’t** if you need human vetting on every change—treat AI output as a first draft that you review.  

Let me know if you’d like example code snippets or more detail on any step.

## Question

🍎 Native Apple Sign In with credentials
🍎 User ID: 001603.ff1ff495cca5485c8896264590913e2b.2104
🍎 ID Token received: eyJraWQiOiJVYUlJRlky...
❌ Apple Sign In with ID token failed: ClerkAPIError(code: "authorization_invalid", message: Optional("Unauthorized request"), longMessage: Optional("You are not authorized to perform this request"), meta: nil, clerkTraceId: Optional("e9b0bb876c7c7fef9df260839be686fb"))
❌ Error details: ClerkAPIError(code: "authorization_invalid", message: Optional("Unauthorized request"), longMessage: Optional("You are not authorized to perform this request"), meta: nil, clerkTraceId: Optional("e9b0bb876c7c7fef9df260839be686fb"))
❌ Error type: ClerkAPIError
❌ Error domain: Clerk.ClerkAPIError
❌ Error code: 1
❌ Error userInfo: [:]
🍎 Error in signInWithAppleCredentials: ClerkAPIError(code: "authorization_invalid", message: Optional("Unauthorized request"), longMessage: Optional("You are not authorized to perform this request"), meta: nil, clerkTraceId: Opti

## Answer

Here are the most likely causes of that “Unauthorized request” error and how to fix them:

1. **Apple OAuth isn’t fully configured in Clerk**  
   - In your Clerk Dashboard ▶️ **Authentication** ▶️ **OAuth** ▶️ **Apple**, make sure you’ve set:  
     - **Service ID** (the identifier you created in Apple’s Developer console)  
     - **Team ID**, **Key ID** and **private key** (from your Apple “Sign in with Apple” key bundle)  
   - In Apple’s Developer console, under your Service ID → **Web** configuration, add **exactly** the callback URI Clerk expects (e.g. `https://<your-domain>/callback` or your dev URL).  
   - If they don’t match byte-for-byte (including trailing slashes), Apple will accept the auth request but Clerk will reject the resulting token as “unauthorized.”

2. **You’re calling the wrong Clerk method (use the built-in OAuth helper)**  
   If you manually extract the ID token and call `signInWithAppleCredentials(...)`, you must also supply the matching OAuth **state** and **nonce** that Clerk originally generated. If those don’t line up, Clerk can’t verify the flow.  
   
   **Simplest fix:** let Clerk handle the OAuth handshake for you:

   ```swift
   import Clerk

   // wherever you kick off sign-in:
   Task {
     do {
       let session = try await Clerk.shared.signInWithOAuth(provider: .apple)
       // success!
     } catch {
       print("Sign-in error:", error)
     }
   }
   ```

   This uses Clerk’s hosted Apple UI, generates and validates state/nonce for you, and avoids mismatches.

3. **Missing or invalid Clerk Frontend API key**  
   - Make sure your app’s Info.plist (or your initialization code) includes the correct **Clerk Frontend API** key for your environment.  
   - If you’re on a private subnet or custom domain, verify that the SDK is loading that key correctly before any sign-in call.

4. **Redirect URI mismatch in your app’s URL schemes**  
   - If you’re testing on-device with a custom URL scheme (e.g. `myapp://callback`), be sure that same URI is registered both in Apple’s Service ID settings **and** in Clerk’s OAuth settings. Otherwise the token comes back to your app but Clerk won’t accept it.

---

**Next steps to resolve:**

- 🔍 In Clerk Dashboard, double-check your Apple provider settings and callback URLs.  
- 🔄 Switch to `signInWithOAuth(provider: .apple)` so Clerk manages the handshake (state/nonce) for you.  
- ✅ Confirm that your Clerk Frontend API key is present and correct in your app’s config.

Let me know once you’ve verified those, or if you’re still seeing the same error!

## Question

Email signing with clerk is working its just apple sign in that isnt

## Answer

Mr. White, if email works but Apple fails, focus on your Apple-specific config:

1. **Clerk Apple OAuth settings**  
   - In Clerk Dashboard → Authentication → OAuth → Apple, confirm your **Service ID**, **Team ID**, **Key ID** and **private key** exactly match what you generated in the Apple Developer portal.  
   - Make sure your **Redirect URI** in Clerk matches the one under your Service ID’s “Web” settings (including trailing slash and HTTPS).

2. **Apple key validity**  
   - Check that your `.p8` private key hasn’t expired or been rotated. If in doubt, revoke & re-create it in Apple and update Clerk.

3. **State & nonce**  
   - If you’re manually calling `signInWithAppleCredentials(idToken:)`, you must also pass the original **state** and **nonce** Clerk generated. Otherwise Clerk can’t verify the token.  
   - **Simplest**: switch to  
   ```swift
   let session = try await Clerk.shared.signInWithOAuth(provider: .apple)
   ```  
   so Clerk manages state/nonce for you.

4. **Environment mismatch**  
   - Ensure you’re using the correct **Frontend API Key** for your dev vs. prod environment. An Apple token issued under one domain/SDK key will be rejected under another.

5. **App Bundle & Service ID alignment**  
   - In Apple Developer, your Service ID’s **Bundle ID** and any associated App IDs must include the correct app identifier. A mismatch there can yield an “Unauthorized request.”

Once you’ve verified/update those four areas, retry. Let me know if it still fails with the same error trace.

## Question

What tests should an iOS app have?

## Answer

Mr. White, a solid iOS test suite covers a spectrum from low-level logic to full-app flows. At minimum you’ll want:

- **Unit Tests (XCTest)**  
  • Business logic, view-models, utility functions, data parsing.  
  • Fast, isolated, no network or UI.  

- **Network Layer Tests**  
  • Mock your API/client (URLSession stubs or a library like Mocker).  
  • Assert request formatting, JSON decoding, error handling.  

- **Integration Tests**  
  • Combine real (or local) database, network stubs, and your view-models.  
  • Verify end-to-end flows (e.g. login → data fetch → display).  

- **UI Tests (XCUITest)**  
  • Automate key user journeys: onboarding, login, main screens, log-out.  
  • Catch regressions in navigation and accessibility.  

- **Snapshot Tests**  
  • Render critical views under various states (empty/error/data).  
  • Use a tool like iOSSnapshotTestCase or SwiftSnapshotTesting to detect unintended UI shifts.  

- **Performance Tests**  
  • Measure launch time, table-scroll fluidity, image-decode speed.  
  • XCTest’s `measure` blocks or Instruments benchmarks.  

- **Accessibility Tests**  
  • Validate that all tappable elements have labels and correct traits.  
  • You can write small XCTest checks against `accessibilityIdentifier`/`accessibilityLabel`.  

- **Static Analysis & Linting**  
  • Integrate SwiftLint rules in your CI to catch style or possible logic issues before tests run.  

By combining these, you’ll catch regressions early, ensure your core logic is rock-solid, and maintain a smooth, reliable user experience.
