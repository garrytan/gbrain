---
title: "NIP-07 extension overview"
type: guide
created: 2025-11-14
updated: 2025-11-14
source: chatgpt-export
conversation_id: 69169149-19a8-8325-bff6-63782d349845
message_count: 2
tags: [chatgpt, import, code]
---
# NIP-07 extension overview

> Conversation ID: 69169149-19a8-8325-bff6-63782d349845
> Created: 2025-11-14T02:17:48Z
> Updated: 2025-11-14T17:57:58Z
> Messages: 2

---

## User

nip07 extension

---

## Assistant

## entity["software_specification", "NIP-07", 0] (“window.nostr” Browser Extension Capability)  
image_group{"layout":"bento","aspect_ratio":"1:1","query":["NIP-07 window.nostr specification diagram","window.nostr browser extension illustration","Nostr protocol browser extension signEvent example"],"num_per_query":1}

Mr. White — here’s a concise breakdown of NIP-07: what it is, how it works, what you should watch out for.

---

### What is NIP-07  
- NIP-07 is a specification in the entity["computer_protocol", "Nostr", 0] protocol suite that defines a **browser extension / browser environment API** whereby webpages/apps can interact with a user’s Nostr keys via `window.nostr`. citeturn0search0turn0search7turn0search5  
- Specifically the spec says (mandatory):  
  ```js
  async window.nostr.getPublicKey(): string    // returns the public key as hex
  async window.nostr.signEvent(event: Event): Event  // takes an event object, adds id/pubkey/sig and returns it
  ```  
  citeturn0search0turn0search3  
- It optionally supports functions like `getRelays()`, and encryption/decryption methods for NIP-04 / NIP-44. citeturn0search7turn0search0  
- The purpose: allow web-apps to request operations (get public key, sign events) **without the user giving their private key directly to the app**. The private key remains controlled by the extension (or underlying key storage). citeturn0search3  

---

### Why it matters / use-cases  
- It enables browser-based Nostr clients (web apps) to integrate with user wallets or key storage extensions in a standardized way. For example, when you log in to a Nostr-based site, the site can invoke `window.nostr.signEvent(...)` to produce a signed event rather than asking you to paste your key.  
- It increases security: the private key doesn’t need to be pasted into every web application; the extension handles the signature.  
- It improves usability: you don’t need to manually handle key import every time; you can reuse your key via the extension.  
- Many built-in libraries and clients (e.g., for Nostr Connect) detect `window.nostr` first to support this flow. citeturn0search9  

---

### Example browser extension implementations  
- entity["software", "nos2x", 0] — a Chrome extension implementing NIP-07: “This extension allows you to sign Nostr events on web-apps without having to give them your keys.” citeturn0search1  
- entity["software", "AKA Profiles", 0] — another extension that supports multiple keypairs and includes NIP-07 compatibility. citeturn0search4  
- entity["software", "nostr-keyx", 0] — more advanced: uses OS keychain/YubiKey to store private key, and exposes `window.nostr` for signing. citeturn0search2  

---

### How it works from a developer/usage perspective  
- A web app checks `if (window.nostr)` and then might call `getPublicKey()` to fetch the user’s public key for identification.  
- Later the web app builds an event (timestamp, kind, tags, content) and calls `window.nostr.signEvent(event)`. The extension signs it (adds id, pubkey, sig) and returns it, which the web app sends on the Nostr network.  
- The extension may manage multiple keys, ask the user for permission per-site, display UI prompts for signing.  
- If encryption/decryption APIs are implemented (optional), the web app may call `window.nostr.nip04.encrypt(...)` or `decrypt(...)`, etc.  

---

### Things to watch / security considerations  
- Just because a web page uses `window.nostr` **doesn’t mean** it is safe: if the extension is compromised or grants permission too broadly, your private key could be indirectly misused.  
- If the extension stores private keys insecurely (e.g., in browser local storage rather than more secure hardware/OS-keychain), there is risk. The “nostr-keyx” extension addresses this by using OS native keychain / YubiKey. citeturn0search2  
- Web apps could request repeated signings or misuse the signed events; always verify permissions and trust the extension.  
- The spec is optional/draft in part, so implementation details may vary across extensions.  

---

### Should you use it?  
Yes — if you are using Nostr via web apps, using an extension supporting NIP-07 is generally **safer and more convenient** than manually exporting keys or pasting them into apps.  
However: pick a reputable extension, ensure that private key storage is secure, restrict permissions per site, and understand that **the extension itself is a critical security component**.  

---

If you like, I can pull together a **comparison of the top NIP-07 browser extensions** (features, security, OS support) so you can pick one. Would that be helpful, Mr. White?


## See Also
- [[chatgpt/chatgpt_1001tracklists-overview-2]]
- [[chatgpt/chatgpt_1001tracklists-overview-3]]
- [[chatgpt/chatgpt_1001tracklists-overview]]
- [[chatgpt/chatgpt_11-labs-grant-overview]]
- [[chatgpt/chatgpt_1600-vine-st-overview]]
