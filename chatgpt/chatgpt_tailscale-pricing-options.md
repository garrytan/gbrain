---
conversation_id: 6a166711-ac24-83e8-a05c-760ad26e628e
created: 2026-05-27
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Tailscale pricing options
type: note
updated: 2026-05-27
---

# Tailscale pricing options

**Related:** [[business_startup]]

> Conversation ID: 6a166711-ac24-83e8-a05c-760ad26e628e
> Created: 2026-05-27T03:37:58Z
> Updated: 2026-05-27T03:38:04Z
> Messages: 2

---

## User

tailscale cost

---

## Assistant

Current pricing for urlTailscalehttps://tailscale.com/pricing:

| Plan | Price | Best for |
|---|---|---|
| Personal | Free | Solo founders, homelabs, side projects |
| Standard | $8/user/month | Small teams |
| Premium | $18/user/month | Larger orgs, advanced security/compliance |
| Enterprise | Custom | Big deployments |

Key limits/features on the free Personal plan:
- Up to 6 users
- Unlimited devices
- 50 tagged resources
- Most core Tailscale features included
- SSH + Kubernetes support
- 1,000 ephemeral-resource minutes/month citeturn0search0turn0search5

For your setup specifically — MacBook Air + desktop + servers + Hermes + GBrain + Tailscale mesh — the free tier is probably enough unless:
- you start adding multiple collaborators/employees,
- need SSO/SCIM,
- need heavy ephemeral CI runners,
- or want enterprise audit/security features.

For a solo AI-agent startup stack, Tailscale free tier is unusually generous and commonly used by indie founders. citeturn0search5turn0search9


**Topic:** [[chatgpt-clusters/business_startup]]
