---
title: "Doppler URL Key Parameters"
type: note
created: 2026-01-05
updated: 2026-01-05
source: chatgpt-export
conversation_id: 695c21db-1f6c-8326-baa4-4daea3ee31f4
message_count: 2
tags: [chatgpt, import]
---
# Doppler URL Key Parameters

> Conversation ID: 695c21db-1f6c-8326-baa4-4daea3ee31f4
> Created: 2026-01-05T20:42:00Z
> Updated: 2026-01-05T20:42:53Z
> Messages: 2

---

## User

Yo dawg, I'm trying to spin up an encryption key to add to our secrets in Doppler for a production instance, and the previous AI agent wrote guidelines recommending that we generate the key via OpenSSL in a base32 or base64 or something like that key and then add it. I'm just going to generate it directly in Doppler. For the URL encryption key, what parameters do I have access to to stay within compatibility? Thank you.

---

## Assistant

Mr. White — if you generate the key **directly in Doppler**, the compatibility “knobs” you can control are basically:

### 1) Random Value (most common for “URL encryption key” strings)
Doppler lets you choose: citeturn1view0  
- **Format / character set**
  - **Alphanumeric (Base62)**: `0-9 a-z A-Z`
  - **Hex (Base16)**: `0-9 a-f`
  - **Base64**
  - **Base64 URL**: `0-9 a-z A-Z - _ =` (URL-safe)
- **Bytes of entropy (length/strength)**
  - Default **32 bytes**, adjustable up to **190 bytes** citeturn1view0

Practical mapping tips:
- If your app expects a **64-hex-character** key (common): pick **Hex** with **32 bytes** entropy (32 bytes → 64 hex chars).
- If your app expects a **base64url**-style key for URLs: pick **Base64 URL** and set entropy to whatever byte length your code expects (often **32 bytes**). citeturn1view0  
- Doppler’s Base64/Base64-URL “random value” is **not encoding meaningful data** (so don’t plan on decoding it); it’s just random characters from that alphabet. citeturn1view0

### 2) Symmetric Key (when you truly want an AES key)
Doppler can generate an **AES-GCM symmetric key** with:
- **128-bit** or **256-bit** selection citeturn1view0

Use this when your encryption library expects an **actual AES key** (not “a random string that your app later hashes/derives from”).

---

**Rule of thumb:** If the thing is called “URL encryption key” and is stored as a single env var/string, **Random Value → Base64 URL → 32 bytes entropy** is usually the safest compatibility choice (URL-safe characters, plenty of entropy). If your code explicitly wants “32-byte key” or “256-bit AES key,” use **Symmetric Key → 256-bit** instead.
