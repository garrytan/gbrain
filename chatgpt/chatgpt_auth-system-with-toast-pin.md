---
title: "Auth system with Toast PIN"
type: note
created: 2025-09-28
updated: 2025-09-28
source: chatgpt-export
conversation_id: 68d9738a-a794-832d-8cdc-d3b64ef00699
message_count: 4
tags: [chatgpt, import]
---
# Auth system with Toast PIN

> Conversation ID: 68d9738a-a794-832d-8cdc-d3b64ef00699
> Created: 2025-09-28T17:42:54Z
> Updated: 2025-09-28T17:45:25Z
> Messages: 4

---

## User

Can I build an auth system for our opps dashboard that lets user login with their toast pin code?

---

## Assistant

Mr. White — short answer: **no, not in a supported or secure way.**

- **Toast doesn’t expose an API to verify a user’s POS passcode (PIN).** You can set a passcode when creating an employee and update it later (with the *current* passcode), but you **can’t read or validate** a passcode via API. Toast’s APIs authenticate your *integration* using OAuth2 client-credentials, not employees logging in. citeturn1search1turn1search10turn0search2  
- **Those PINs are only meant for POS devices** (4–8 digits, low entropy, device-gated UI), not for third-party web app sign-in. citeturn1search1turn1search8  
- **Toast SSO goes the other direction** (use your org’s IdP to log in to Toast), not “Login with Toast” for external apps. citeturn0search4

### What to do instead (safe patterns)
1) **Use your IdP (Google/Entra/Okta) via OIDC** for the ops dashboard. If you already use Toast SSO, reuse the same IdP here so staff have one set of creds. citeturn0search4  
2) **Map users to their Toast employee records**: store the Toast `employee.guid`/`externalEmployeeId`; sync via the Labor API (needs `labor.employees:read` scope and API access). citeturn0search11turn0search7  
3) **If you want a “keypad” feel**, use app-specific **TOTP** (6-digit rotating codes) or **passkeys/WebAuthn** instead of static PINs, with rate-limiting and lockouts.

If you want, I can sketch the linking flow (IdP login → look up employee by email/`externalEmployeeId` → role map from Toast jobs) and example endpoints to keep the Toast data in sync.

---

## User

I could just stop employee, role, name, to a basic file and lock it down that way and id manually add the codes to the file.

---

## Assistant

Mr. White — technically you *can*, but only for a very low-risk, internal-only tool. If you go this route, do it like this (minimum bar):

### If you insist on “file + manual codes”
- **Never store raw codes.** Store **Argon2id** hashes with per-user salts (e.g., m=64–128 MiB, t=2–3, p=1–2).  
- **Use longer codes.** At least **8–10 digits** (4–6 is trivially brute-forced).  
- **Brute-force controls.**  
  - Per-user + per-IP rate-limits (e.g., 5 tries/min).  
  - Exponential backoff; **lock** after 10 failed attempts (30–60 min).  
  - Global circuit-breaker if failures spike.  
- **Scope it to trusted networks.** Put the dashboard **behind VPN/IP allowlist** or **mTLS**. Do **not** expose to the open internet with only a PIN.  
- **Session hygiene.** 15–30 min idle timeout, secure/HTTP-only cookies, CSRF protection.  
- **Audit & rotation.** Log every create/update/login; mark codes **expired every 90 days**; support a **disabled** flag.  
- **Use a real storage layer.** A locked-down **SQLite** file (still one file) > ad-hoc JSON/YAML. Encrypt at rest; keep the key out of the repo/env files.  
- **Data model (minimal):**  
  `employee_id, name, role, code_hash, salt, attempts, locked_until, last_used_at, expires_at, disabled`

**Verify flow (pseudocode):**
1) Lookup employee → check `disabled/locked/expires`.  
2) Enforce rate limits.  
3) `argon2id.verify(input_code, code_hash)` → on success reset counters; on failure increment + maybe lock.  

### Safer alternatives (recommended)
- **OIDC with your IdP** (Google/Okta/Entra) + map to Toast employee IDs.  
- **“Keypad” feel without static PINs:** **TOTP** (rotating 6-digit) or **passkeys/WebAuthn**; keep the numeric keypad UI if you like.

Bottom line: a flat-file of static codes is high-risk. If this must ship, meet the controls above and keep it **internal-only**. I can sketch a quick schema and Argon2 config for your stack if you tell me the language/framework.
