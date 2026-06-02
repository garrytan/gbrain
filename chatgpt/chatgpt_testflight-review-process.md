---
conversation_id: 6923aae4-b830-832d-8235-d7a257409240
created: 2025-11-24
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: TestFlight review process
type: note
updated: 2025-11-24
---

# TestFlight review process

**Related:** [[coding_mobile]]

> Conversation ID: 6923aae4-b830-832d-8235-d7a257409240
> Created: 2025-11-24T00:46:46Z
> Updated: 2025-11-24T16:17:45Z
> Messages: 4

---

## User

why is the build here waiting review. i jsut want to get a build dirstributed to alpha testers

---

## Assistant

Mr. White — here’s what’s happening.

On TestFlight, **external testers** (anything outside your App Store Connect internal users) require **Apple review**, even if it’s just an early build. That’s why you’re seeing **“Waiting for Review”** — you likely assigned this build to an **external testing group (Alpha)** instead of internal testing.

**Internal testers = no review.  
External testers = requires review.**

---

### **To distribute instantly (no waiting):**

1. Go to **TestFlight → Testers → Internal Testing**.
2. Add yourself or whoever needs access (must be listed under Users & Access with proper roles).
3. Select one of the builds marked **Ready to Submit**, not the one locked in review.
4. Enable testing and distribute.

Internal builds go live immediately.

---

### **If you want external testers:**

Then you must submit **Test Info** and wait for Apple to review. First review often takes a few hours to a couple of days. Later reviews are faster.

---

### Quick Fix Summary:

| Testing Type | Requires Apple Review | Fast? | Who Can Test |
|-------------|-----------------------|-------|--------------|
| **Internal** | ❌ No | ⚡ Immediate | Team members in App Store Connect |
| **External** | ✅ Yes | ⏳ Must wait | Anyone with TestFlight link |

---

If you want, I can walk you step-by-step based on the groups you already created.

Want **internal only** or **external link** long term?

---

## User

where do test flight crash reports ive

---

## Assistant

Mr. White — they’re not in the main App Store Connect "Analytics" section. TestFlight crash logs live in a different place.

Here’s exactly where to find them:

---

### **Path to TestFlight crash logs:**

1. Go to **App Store Connect → Apps**.
2. Select your app.
3. Open the **TestFlight** tab (not App Store or Activity).
4. In the left sidebar, select **Crashes**.

---

### **Where they actually appear per build:**

You can also drill down:

1. In TestFlight, click a specific **build**.
2. You’ll see sections for:
   - **Crashes**
   - **Sessions**
   - **Feedback**
3. Crash reports appear under **Crashes**, with stack traces you can download as **.ips** files.

---

### **Important Notes:**

- Crash logs only appear **after someone installs and runs the build from TestFlight**.
- Internal testers generate crash reports the same way, but sometimes there’s a delay of **5–30 minutes** before they populate.
- If you connected **Firebase Crashlytics or Sentry**, those will appear separately — Apple won’t merge them.

---

### **If crashes aren’t showing:**

Check these:

- Make sure the build is installed **via TestFlight**, not sideloaded or run from Xcode — Apple only collects data from official TestFlight installs.
- Ensure users have **"Share with App Developer"** enabled in TestFlight settings (common missing step).

---

If you want, I can walk you through decoding the .ips files with Xcode so they show symbolicated stack traces.

Want that?


**Topic:** [[chatgpt-clusters/code_review]]
