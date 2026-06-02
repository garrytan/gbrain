---
title: "Shake-to-report feature analysis"
type: guide
created: 2025-11-26
updated: 2025-11-26
source: chatgpt-export
conversation_id: 6927740c-fc10-8326-a266-3e9d818775a4
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Shake-to-report feature analysis

> Conversation ID: 6927740c-fc10-8326-a266-3e9d818775a4
> Created: 2025-11-26T21:41:55Z
> Updated: 2025-11-26T21:44:23Z
> Messages: 4

---

## User

How is the report bug popup in chatgpt built. When shake the iPhone it pops up. Is that a statsig feature? Or is it a custom thing

---

## Assistant

Short answer, Mr. White: that shake-to-report popup is almost certainly a custom thing (or a bug-report SDK), **not** a Statsig feature.

### 1. What Statsig actually does
Statsig is a feature flag / experiment platform: it serves variants, gates features, and logs events. Its SDKs are about evaluation and logging, not UI. citeturn0search1turn0search13turn0search17  

There’s no built-in “shake to open bug dialog” in Statsig.

At most, Statsig might *gate* whether the shake handler is enabled (e.g., experiment vs control), but the gesture and popup itself would be app code.

### 2. How the ChatGPT iOS app likely does it
Apple doesn’t ship a “report bug on shake” primitive; apps implement it roughly like this:

1. **Listen for the shake gesture** in a `UIWindow` / root view controller by overriding motion events:
   ```swift
   class RootViewController: UIViewController {
       override var canBecomeFirstResponder: Bool { true }

       override func viewDidAppear(_ animated: Bool) {
           super.viewDidAppear(animated)
           becomeFirstResponder()
       }

       override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
           guard motion == .motionShake else { return }
           presentBugReport()
       }

       private func presentBugReport() {
           let vc = BugReportViewController()
           vc.modalPresentationStyle = .formSheet
           present(vc, animated: true)
       }
   }
   ```

2. **Present a custom feedback controller** (`BugReportViewController`) that:
   - Captures a screenshot of the current screen.
   - Collects text input, logs, maybe device info.
   - Sends it to their internal reporting backend.

That’s exactly the pattern used by tools like Instabug or Shake: they hook the shake gesture and show their own bug-report UI. citeturn0search20turn0search12  

### 3. So is it:
- **Statsig feature?**  
  No – Statsig doesn’t provide that UI or gesture behavior.

- **Custom / bug-report SDK?**  
  Yes – it’s either:
  - Completely custom gesture + sheet built by OpenAI; or  
  - A third-party bug-report SDK under the hood (Instabug / Shake-style), wired to the shake gesture.

From the outside we can’t know which SDK (or none) they use, but architecturally it’s “listen for `motionShake` → present internal bug-report flow,” not a Statsig thing.

If you want, I can sketch a minimal “shake to feedback” implementation that also grabs a screenshot and posts it to your own backend.

---

## User

What can we use to wire this too for bug reporting? What would the yc advice be? What would open AI use?

---

## Assistant

You’ve basically got three tiers of answers here, Mr. White:

---

## 1. “We ship tomorrow” option – use an off-the-shelf SDK

If you just want **shake → screenshot → repro data → dashboard + Slack/Jira**, plug in something built exactly for this:

**Good fits:**

- **Instabug** – classic “shake to report” SDK for iOS/Android.  
  - Gives you shake trigger, screenshot, device info, repro steps, network logs, and a web dashboard out of the box. citeturn0search0turn0search11turn0search27  
  - Integrates with JIRA, Slack, etc.
- **Shake (shakebugs)** – explicitly marketed as *bug + crash reporting via shake gesture*. citeturn0search5turn0search16turn0search24  
  - SDK + dashboard, nice for mobile-first.
- **Shakebug** – similar space: online bug + crash tracker; you turn on shake with a flag like `isAllowShake = true`. citeturn0search12turn0search32  

If you’re not price-sensitive and want to move fast, a YC-style answer is: **use Instabug or Shake, don’t overthink it**. You can always rip it out later.

---

## 2. “We like owning the data” option – roll a thin layer on top of Sentry / your own backend

If you care about control / cost / data residency, do:

### Client side

- Your own **shake handler** (what you already have or are building).
- Take screenshot, gather a small payload:
  - app version, build number
  - user id / session id
  - current route / view
  - recent logs (last N lines)
  - optional console/network breadcrumbs

Then POST it to:

1. **Sentry “User Feedback”**  
   - Sentry already has user-feedback flows you can trigger from anywhere in the app and tie to events. citeturn0search2turn0search6turn0search21  
   - You can:
     - Create a Sentry event (or dummy event) with context.
     - Attach the user’s free-form text + screenshot as user feedback.
   - Pros: fits into your existing error monitoring; powerful search, linking, alerts.

2. **Simple custom backend → Slack/Linear/Jira**  
   - Minimal architecture:
     - `POST /bug-report`  
       → write to DB or S3 (JSON + image)  
       → send a Slack webhook with link + key fields  
       → optional sync into Linear/Jira via API.
   - This is extremely easy to ship and keeps you independent of any heavy SDK.

If you’re already on **Sentry/Datadog/Bugsnag**, I’d wire the shake dialog into *that* first, then only add a dedicated SDK if you miss the fancy UX.

---

## 3. “What would YC tell us to do?”

YC’s actual motto here would be:

- **Talk to users, get feedback any way you can, fast.** Tools are secondary. citeturn0search10turn0search22turn0search18  
- **Don’t over-engineer bug tracking at seed stage.**
  - One place where everything lands (usually **Slack + Linear/Jira**).
  - Use an off-the-shelf SDK (Instabug / Shake) or a dumb endpoint.
- **Optimize for speed, not elegance.**
  - If Instabug saves you a week of building screenshot upload / dashboard, use Instabug.
  - Revisit once you actually have scale and know what data you really care about.

So a very YC implementation:

- Step 1: Integrate Instabug or Shake in a day.
- Step 2: Wire their webhooks → Slack channel `#bugs` + Linear.
- Step 3: Review that channel daily with the team, fix the most painful stuff.

---

## 4. “What would OpenAI use?”

We *don’t* have public info on OpenAI’s exact stack for the ChatGPT iOS bug popup, and I can’t pretend to. Anything specific would be made up, so I won’t do that.

Realistically though, a company at that scale and with that sensitivity will usually:

- **Avoid third-party bug-report SDKs in production user flows** (data/privacy, control).
- Use:
  - Their own **first-party telemetry + logging** backend.
  - Standard observability (e.g., Sentry/Datadog/whatever) for crashes & errors.
  - A **custom internal feedback pipeline**:
    - Shake gesture → internal “Report a problem” view.
    - Sends structured JSON + screenshots into their own services.
    - Surfaced in internal tools used by support / on-call engineers.

So “what OpenAI would use” for *you* basically translates to:  

> **If you’re big and care about control:** do your own endpoint + your standard observability stack, no Instabug.  
> **If you’re small and move fast:** just use Instabug/Shake and pipe it into your existing task system.

---

## Concrete recommendation (opinionated)

If you tell me you’re:

- **Pre-PMF / early YC-style startup:**  
  → Use **Instabug** or **Shake** + Slack + Linear. Ship this week.

- **More mature, infra-conscious, want data in-house:**  
  → Custom `POST /bug-report` + **Sentry user feedback** integration.

If you want, I can sketch a short implementation plan:

- iOS: data model for reports, endpoint schema, S3 layout, Slack message format.
- Backend: one small service (can be just a new route in your existing API).


## See Also
- [[chatgpt/chatgpt_automating-feature-design]]
- [[chatgpt/chatgpt_clerk-allowlist-feature]]
- [[chatgpt/chatgpt_feature-comparison-request]]
- [[chatgpt/chatgpt_feature-flag-workflow-setup]]
- [[chatgpt/chatgpt_feature-flagging-in-ios]]
