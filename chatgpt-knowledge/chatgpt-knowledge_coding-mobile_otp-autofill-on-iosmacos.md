---
title: "OTP Autofill on iOS/macOS"
type: guide
created: 2025-12-28
updated: 2025-12-28
source: chatgpt-export
topic: coding-mobile
message_count: 6
tags: [chatgpt, knowledge, coding-mobile]
---
# OTP Autofill on iOS/macOS

> **Source:** ChatGPT conversation
> **Date:** 2025-12-28T21:14:26Z
> **Messages:** 6
> **Topic:** coding-mobile

## Question

Can we have our OTP screen grab code from Gmail automatically on iOS and macOS?

## Answer

Mr. White — **yes, you *can* have OTP (one-time passcode) codes from Gmail automatically offered to you on iOS and macOS** — but with some important caveats:

### ✅ **Native iOS & macOS Autofill Capabilities**
- **Apple devices can auto-detect one-time codes** sent via **SMS or email** and suggest them above the keyboard or in the autofill popup when you’re logging in, eliminating manual copy-paste. This works when:  
  • You’re running **modern OS versions** (iOS 17+/iPadOS 17+/macOS Sonoma or later). citeturn0search0turn0search19  
  • The email account (e.g., Gmail) is added in **Apple’s Mail app**. citeturn0search19  
  • You have **Autofill & Passwords** enabled in Settings ► General ► Autofill & Passwords (and in System Settings ► Passwords on macOS). citeturn0search0

### 📩 **How It Works**
- When a 2FA/OTP email arrives in Mail or an SMS arrives in Messages, iOS/macOS can **scan the content on-device**, detect the numeric code, and offer it as an autofill suggestion in the login field. citeturn0search0turn0search19  
- You just tap/click the suggestion — no manual copying. citeturn0search0  
- There’s also a setting to **delete used codes automatically** to reduce inbox clutter. citeturn0search0

### 📬 **Gmail App vs Apple Mail**
- Until recently, **Gmail’s own app didn’t integrate with Apple’s autofill system** — meaning OTP codes in Gmail might *not* trigger the suggestion unless viewed via Apple Mail. citeturn0search3  
- Starting with **iOS 26/macOS 26**, Apple has expanded OTP autofill to work with **third-party apps including Gmail** and browsers like Chrome/Firefox, *so long as the system can detect the code on-device*. citeturn0search7turn0search20

### 🖥️ **On macOS**
- On macOS Sonoma and later, the autofill works in Safari and — with the newer system updates — also in third-party browsers when the code is detected in Mail or third-party apps like Gmail. citeturn0search20

### ⚠️ **Limits Today**
- Older OS versions may not support email-based OTP autofill outside of Apple Mail. citeturn0search3  
- Gmail push delivery in the Apple Mail app can be slower with “Fetch” settings, so sometimes codes arrive late. citeturn0search3  
- It doesn’t truly “screen grab” the code from Gmail by itself — it *detects* codes in notifications or mail content and offers them to autofill; it’s not a background scraper.

---

**Bottom line:**  
Yes — on modern iOS and macOS versions, you can get Gmail OTPs suggested automatically in your login fields *without manual copy-paste* by using Apple’s autofill system, especially with Gmail set up in Mail or once iOS 26/macOS 26 support is in place. citeturn0search0turn0search7

## Question

What does our component and code need in place to work properly 

## Answer

Mr. White — to make OTP AutoFill work reliably on **iOS + macOS**, you need the right **UI field semantics** (so the OS knows “this is an OTP field”) and the right **message format** (so the OS can detect the code in SMS/Mail/app content).

## 1) Native iOS / macOS app (UIKit / AppKit)

### The OTP input field must be tagged as an OTP field
**UIKit (iOS / iPadOS / Mac Catalyst):**
- Use **one field if you can** (most reliable with AutoFill).
- Set:
  - `textContentType = .oneTimeCode` (this is the key)
  - `keyboardType = .numberPad` (recommended)
  - `autocorrectionType = .no` (recommended)

Apple’s guidance for AutoFill is: set the text input view’s `textContentType` so the system offers the correct suggestions. citeturn0search2turn0search19

**If you use 6 separate boxes (one digit per field):**
- AutoFill often pastes the *entire* code into the focused field; you must handle that (split digits and distribute). This is a common real-world issue on iOS/macOS. citeturn0search14  
- Practical tip: still mark the **first** field as `.oneTimeCode`, then when it receives multiple characters, distribute.

### Don’t expect delegate callbacks to behave like manual typing
AutoFill can insert text without triggering the exact same delegate paths you rely on for keystrokes, so ensure your “value changed” handling works for programmatic text insertion too (e.g., target/action `.editingChanged`, or observing changes).

## 2) Web OTP screen (Safari + iOS browsers)

Your OTP `<input>` must declare the OTP purpose:

- `autocomplete="one-time-code"` (key attribute)
- `inputmode="numeric"` (recommended)
- Optional: `pattern="[0-9]*"` (helps some keyboards)

`one-time-code` is the standardized autocomplete token for OTPs. citeturn0search17

## 3) Backend message formatting (what you send)

### If OTP is delivered by SMS (best-supported path)
If you can, use **domain-bound SMS** format so iOS/macOS can strongly associate the code with your site/app domain. Apple documents the binding approach and requirements. citeturn0search3

### If OTP is delivered by email (Gmail, etc.)
Apple supports AutoFill for codes “received in Mail” (iOS 17 / macOS Sonoma era and later). citeturn0search1  
There isn’t a public “email format spec” as strict as the domain-bound SMS doc, but to maximize detection:
- Put the code as a **clean 6–8 digit number** (no extra punctuation inside the digits)
- Put it **near the top** of the email (subject and first line help)
- Include obvious keywords like **“verification code”** / **“one-time code”**
- Avoid multiple similar numbers in the same message

## 4) If you want OTPs to AutoFill from *inside your own app / extension*
If you’re building a password manager / credential provider extension, Apple provides an API for your extension to supply one-time passcodes to AutoFill. citeturn0search0  
(This is for your credential provider ecosystem—not for “reading Gmail automatically.”)

---

### Quick “done right” checklist
- **iOS

*(Answer truncated — 3622 chars total)*

## Question

So can you give me a prompt that I can give to an AI agent that has visibility into the whole codebase to audit the OTP component and ensure that all of the is in place and that it handles any edge cases and doesn't create weird UX scenarios where you get locked in or you can't paste things properly or you paste something but then you can't backspace and shit like that and just generally check for any other situations similar to that and make sure it fully supports it so that it just is automatically inherited. It's Next.js, but AI agent has visibility into that so you don't need to specify any of that kind of stuff.

## Answer

Mr. White — here’s a copy/paste prompt you can give an AI agent with full repo access. It’s written to force a real audit (not vibes), cover AutoFill + paste/backspace edge cases, and produce concrete diffs + tests.

```text
You are an expert frontend engineer auditing our OTP / verification-code input UX end-to-end.

Goal:
Ensure our OTP component fully supports OS/browser OTP autofill and robust manual entry on iOS/macOS/Android/desktop, without weird UX traps (can’t paste, can’t backspace, gets “stuck” in a field, focus loops, blocked submit, etc.). You have full codebase visibility. Produce an actionable report plus code changes.

Scope (must find all of these in repo):
1) All OTP UI components (any “OTP”, “verification code”, “2FA”, “one time code”, “passcode” input).
2) All OTP-related pages/flows (login, signup, password reset, device verification).
3) All OTP API integration points (submit, resend, rate limit handling, error display).
4) Email/SMS templates or server-side code that generates OTP messages (format & copy).

Deliverables:
A) Inventory: list every OTP component + where used (file paths, route names).
B) A checklist-based audit: for each item below, mark PASS/FAIL with evidence (code excerpts/paths).
C) Fixes: implement minimal, safe changes to address FAIL items (include diffs).
D) Tests: add/adjust unit + e2e tests to cover critical edge cases.
E) UX notes: any remaining risk, plus recommended product copy/micro-interactions.

Audit checklist (be explicit and repo-backed):
1) Autofill semantics:
   - Web input(s) have autocomplete="one-time-code".
   - Input uses inputMode="numeric" and does NOT prevent autofill via aggressive filtering.
   - If multi-box OTP (6 separate inputs), confirm autofill inserts full code and we properly distribute digits.
   - Ensure no code blocks paste/autofill by rejecting non-single-char updates.

2) Paste behavior:
   - Paste a full code into any box (or first box) should fill all digits.
   - Paste with spaces/hyphens (e.g., "123 456", "123-456") is sanitized.
   - Paste longer than expected: truncate safely (prefer last N or first N—pick one and justify).
   - Paste shorter: fill available and keep focus correct.
   - Pasting should not break backspace navigation.

3) Typing & backspace:
   - Typing digits advances focus (if multi-box).
   - Backspace on empty field moves focus to previous and clears it (expected OTP UX).
   - Backspace on filled field clears current digit without unexpected focus jumps.
   - Arrow keys / tab navigation works on desktop.
   - Mobile “delete” behavior on iOS is handled (including when value was autofilled/pasted).

4) Focus management & “getting stuck”:
   - No infinite focus loops.
   - Clicking any box sets correct caret/selection.
   - On validation error, focus behavior is sane (don’t trap user).
   - If submit is disabled until N digits, ensure user can still edit / clear / paste.
   - Resend flow doesn’t reset focus/value in surprising ways.

5) Input f

*(Answer truncated — 5507 chars total)*
