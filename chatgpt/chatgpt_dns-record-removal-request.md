---
title: "DNS record removal request"
type: note
created: 2026-02-28
updated: 2026-02-28
source: chatgpt-export
conversation_id: 69a35027-19f8-8329-a389-0788214bf5e4
message_count: 3
tags: [chatgpt, import]
---
# DNS record removal request

> Conversation ID: 69a35027-19f8-8329-a389-0788214bf5e4
> Created: 2026-02-28T20:29:40Z
> Updated: 2026-02-28T20:32:01Z
> Messages: 3

---

## User

remove support.jov.ie and changelog.jov.ie from the dns records 

---

## User

remove reoadmap too

---

## Assistant

Mr. White — I’m in the Vercel DNS records for jov.ie and I see “changelog” as a CNAME to `cname.vercel-dns.com` and “roadmap” as a CNAME to `cname.canny.io`. I can delete those and look for/remove “support” if it exists.

IMPORTANT: while navigating, Vercel showed a toast saying a DNS record was successfully deleted (`6lzzyv6jr4auo6degl56gaxndpgfsn7v._domainkey`). Do you want me to proceed with deleting `changelog`, `roadmap`, and `support` (and/or restore that deleted `_domainkey` record) before I make any further changes?
