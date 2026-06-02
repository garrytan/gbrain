---
title: "Clerk OTP Test Setup"
type: note
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 69804ca2-9d34-8331-9e24-2c0db1753a4b
message_count: 2
tags: [chatgpt, import]
---
# Clerk OTP Test Setup

> Conversation ID: 69804ca2-9d34-8331-9e24-2c0db1753a4b
> Created: 2026-02-02T07:05:07Z
> Updated: 2026-02-02T07:05:43Z
> Messages: 2

---

## User

clerk test auth otp

---

## Assistant

Here’s how you *test* one-time password (OTP) authentication in **Clerk** (the auth service for apps):

### 🔹 What “Clerk OTP auth” is
Clerk supports OTPs (one-time passcodes) sent by **email or SMS** as part of passwordless or multi-factor authentication flows. It manages sending, validating, and verifying these codes for you. citeturn0search0turn0search3

### 🔹 How to simulate OTP in tests
Clerk has a **Test Mode** that lets you simulate OTP flows without actually sending SMS or emails, so you can verify your implementation end-to-end:

**In Test Mode (development):**
- Email OTPs can be verified using the code `424242` for any test email with `+clerk_test`.  
  Example: `jane+clerk_test@example.com` → use OTP `424242`.  
- Phone OTPs use fictional test numbers (`+1 (XXX) 555-0100` → `+1 (XXX) 555-0199`) and the same test OTP code `424242`.  
- No real SMS or email is sent. This lets you assert your sign-in/sign-up flows properly handle the OTP verification step.  
Clerk’s test setup counts *test deliveries separately* and won’t hit SMS limits. citeturn0search7

### 🔹 Typical test flow
1. **Enable Test Mode**  
   In the Clerk Dashboard or via API toggle “Test Mode” so Clerk uses test identifiers. citeturn0search7

2. **Run your app’s auth actions**  
   - Trigger sign-in or sign-up that sends an OTP (email or phone).  
   - Clerk returns OTP flow state without sending real messages.  
   - Your test code inputs `424242` as the OTP.  

3. **Assert success**  
   Verify your code handles OTP verification and creates/sets active sessions or continues where appropriate.

### 🔹 Notes for devs
- OTP flows are also used in MFA (multi-factor authentication). citeturn0search10  
- Phone number verification uses `prepareVerification()` to send the OTP and `attemptVerification({ code })` to validate it. citeturn0search2

If you want sample test code or a specific framework example (React/Next, Node, etc.), tell me your stack and I can give it.


## See Also
- [[chatgpt/chatgpt_clerk-apple-integration-setup]]
- [[chatgpt/chatgpt_clerk-e2e-testing-setup]]
- [[chatgpt/chatgpt_clerk-ios-native-setup]]
- [[chatgpt/chatgpt_clerk-vercel-preview-setup]]
- [[chatgpt/chatgpt_e2e-test-account-setup]]
