---
title: "Cookie banner requirements"
type: note
created: 2025-08-05
updated: 2025-08-05
source: chatgpt-export
conversation_id: 68927f9c-6d50-8331-b189-0daad2ef77b8
message_count: 2
tags: [chatgpt, import]
---
# Cookie banner requirements

> Conversation ID: 68927f9c-6d50-8331-b189-0daad2ef77b8
> Created: 2025-08-05T22:03:09Z
> Updated: 2025-08-05T22:03:39Z
> Messages: 2

---

## User

In what situation do i legally need a cookie approve banner

---

## Assistant

**Mr. White, here’s the short version.**

You only *legally* need an “Accept-cookies” banner when either of these are true:

| Situation | Why the banner (or equivalent notice/controls) is required | What the banner must let the user do |
|-----------|-----------------------------------------------------------|--------------------------------------|
| **You have visitors in the EU/EEA/UK and you drop any cookie that isn’t strictly necessary (analytics, ads, remarketing, social pixels, etc.).** | ePrivacy Directive + GDPR demand *prior, informed, freely-given* opt-in for non-essential cookies. citeturn0search7 | Block non-essential cookies until the user clicks “Accept” (or let them selectively opt in/out). Must also offer an easy “Withdraw consent” link. |
| **You “sell” or “share” Californians’ personal info via tracking cookies (cross-site ads, retargeting, data brokers) or you knowingly track minors (<16).** | CCPA/CPRA treat cookie IDs as personal info and require a “Notice at Collection” and a **“Do Not Sell/Share My Personal Info”** mechanism; explicit opt-in if the user is a minor. A banner is the easiest way to surface this. citeturn0search0turn0search9 | Let adults opt-out of sale/sharing **at or before** the cookie drops; obtain explicit opt-in from minors. |
| **You target or serve users in one of the newer U.S. state privacy laws (e.g., CO, CT, VA, TX) and use cookies for “targeted advertising.”** | These laws mirror CPRA’s opt-out requirement and regulators are already enforcing it. A banner centralizes notice + opt-out. citeturn0search11 |

**When you *don’t* need one**

- Only essential cookies (site login, cart, security) and you **do not** target EU/UK users.  
- Analytics are completely self-hosted, anonymized, and never combined with ads or shared externally.  
- You operate purely inside the U.S. and never “sell/share” Californian (or other state-resident) data.

**Practical call**

Because any public-facing site can get EU traffic and California regulators are suing over hidden trackers, most U.S. businesses just run a geo-aware consent banner by default. It’s cheap insurance.

That’s it.


## See Also
- [[chatgpt/chatgpt_cookie-banner-requirements-2]]
- [[chatgpt/chatgpt_cookie-banner-requirements-3]]
- [[chatgpt/chatgpt_bar-sink-requirements-california]]
- [[chatgpt/chatgpt_deepseek-v4-requirements]]
- [[chatgpt/chatgpt_id-requirements-domestic-flight]]
