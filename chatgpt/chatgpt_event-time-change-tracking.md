---
conversation_id: 68eb4af0-ed68-8325-9e2c-064ce8da28c2
created: 2025-10-12
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: Event time change tracking
type: note
updated: 2025-10-12
---

# Event time change tracking

**Related:** [[jovie_music]]

> Conversation ID: 68eb4af0-ed68-8325-9e2c-064ce8da28c2
> Created: 2025-10-12T06:30:23Z
> Updated: 2025-10-12T06:31:38Z
> Messages: 4

---

## User

Is there anyway in tixr studio to see if a show was previously set to a different time and got changed?

---

## Assistant

I couldn’t find anything in Tixr’s public documentation that confirms you can see a prior event time if it’s been changed.  

Tixr does have a **Detailed Audit Report** feature in Studio, which lets you audit sales, ticket adjustments, etc. citeturn0search1 But that report is focused on ticketing/inventory actions, not necessarily event scheduling changes.  

If you want, I can dig into whether Tixr’s internal logs or “change history” features support tracking event time edits (for your account level). Do you want me to check that for your specific user tier (e.g. enterprise vs standard)?

---

## User

Yes please

---

## Assistant

I checked Tixr’s public documentation and I didn’t find anything confirming that *event time changes* (i.e. edits to show start time) are tracked in a visible change-history log inside Tixr Studio for all users.  

Here’s what I found (and what that implies):

---

### 🔍 What I found

- Tixr provides a **Detailed Audit Report** in Studio that lets you audit **ticketing activity** (sales, cancellations, adjustments) for a specific event. citeturn0search0  
- That report is focused on inventory, refunds, adjustments—not event schedule metadata. citeturn0search0  
- Tixr’s “Event Changes and Cancelations” help article explains what happens when an event is changed or canceled from a ticket buyer perspective, but does not mention a backend “edit history” feature. citeturn0search1  
- In their “Full Required Assets” listing, Tixr states that event start time is part of the event metadata. citeturn0search10  
- But owning metadata doesn’t necessarily mean the system preserves historical versions of it in an audit trail.

---

### ⚠️ What this suggests (and caveats)

- If you’re a standard / non-enterprise user, it’s unlikely you’ll see past versions of event times (i.e. “this show used to be at 8:00 pm, now it’s 9:00 pm”) via any built-in UI that’s publicly documented.
- It’s possible that internally, or at higher access tiers (enterprise / customer success / backstage), Tixr may keep logs of changes (for support / troubleshooting), but they don’t advertise that as a user feature.
- If your account has a custom or elevated role (e.g. admin / promoter / enterprise tier), you might ask Tixr support whether they can expose “event metadata change logs” for your events.

---

If you like, I can try to dig into user forums or undocumented features to see if any users have discovered a workaround or hidden log, just in case. Would you like me to check that?


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_ai-progress-over-time]]
- [[chatgpt/chatgpt_airpods-charge-time-summary]]
- [[chatgpt/chatgpt_apartment-deep-clean-time-4-6-hours]]
- [[chatgpt/chatgpt_backup-time-for-20tb]]
- [[chatgpt/chatgpt_dns-propagation-time]]
