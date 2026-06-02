---
title: "Clerk iOS Native Setup"
type: note
created: 2026-05-28
updated: 2026-05-28
source: chatgpt-export
conversation_id: 6a1882f5-7cdc-83e8-b5c3-8f2085902d69
message_count: 3
tags: [chatgpt, import, code]
---
# Clerk iOS Native Setup

> Conversation ID: 6a1882f5-7cdc-83e8-b5c3-8f2085902d69
> Created: 2026-05-28T18:02:05Z
> Updated: 2026-05-28T19:23:33Z
> Messages: 3

---

## User

If we’re using clerk in iOS with a continue in browser flow for electron and iOS do we need the native app iOS enable in clerk dah oars?

---

## Assistant

I’ll verify against Clerk’s current docs/settings language, since the dashboard options and OAuth behavior can change.

---

## Assistant

Mr. White, **yes for iOS** if you’re actually using Clerk inside the iOS app.

### The rule

| App surface | Need Clerk Native API enabled? | Need iOS native app added in Clerk? |
|---|---:|---:|
| **iOS native / Expo / React Native using Clerk SDK** | **Yes** | **Yes** |
| **Mobile browser only** | No | No |
| **Electron app using browser-based Clerk flow** | Usually no | No, unless using native-style deep links/custom scheme |
| **Electron “continue in browser,” then deep-link back to app** | Maybe | You need redirect/deep-link allowlisting; Native API depends on implementation |

Clerk’s current docs say the **Native API must be enabled** for native app integrations, and iOS apps should be added under **Native applications** with App ID Prefix / Team ID and Bundle ID. citeturn767670search2

For OAuth/social login in native flows, Clerk also requires allowlisting mobile SSO redirect URLs under **Native applications → Allowlist for mobile SSO redirect**. Clerk defaults to:

```text
{bundleIdentifier}://callback
```

or your custom redirect URL. citeturn767670search0

### Practical answer for Jovie

Use this setup:

1. **Enable Native API** in Clerk.
2. **Add the iOS app** in Clerk Native applications.
3. Add your iOS redirect URL, likely something like:

```text
jovie://callback
```

or:

```text
com.jovie.app://callback
```

4. For Electron, treat it as a web app unless you’re returning from browser auth into Electron via a custom protocol like:

```text
jovie-desktop://callback
```

Then allowlist that redirect too.

### Best implementation pattern

For both iOS and Electron:

```text
App → opens browser Clerk auth → Clerk completes auth → redirects to custom scheme → app receives session/handshake
```

That means **iOS should be configured as native**. Electron only needs native-style config if you use a custom protocol return path.
