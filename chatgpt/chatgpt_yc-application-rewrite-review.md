---
title: "YC application rewrite review"
type: note
created: 2026-04-10
updated: 2026-04-10
source: chatgpt-export
conversation_id: 69d939e6-6500-83e8-b41a-df38dc99672a
message_count: 4
tags: [chatgpt, import]
---
# YC application rewrite review

> Conversation ID: 69d939e6-6500-83e8-b41a-df38dc99672a
> Created: 2026-04-10T17:56:54Z
> Updated: 2026-04-10T19:05:51Z
> Messages: 4

---

## Assistant

I’m reviewing the current application, canon files, and product repo first. Then I’ll tighten the YC answers and interview prep while preserving the approved structure, and flag any remaining weak points or inconsistencies.

---

## Assistant

The private repo files are not exposed here, so I’m grounding the rewrite in the public product repo, live app, site, and docs. The live pages already support the revised lead, “The release system for independent artists,” with public profiles, pre-saves and smart links, release tasks, fan notifications, and a command-center workflow.

---

## Assistant

I’m into the rewrite now. The main risks I’m correcting are inconsistent public pricing and positioning, a few surfaces that blur shipped versus planned features, and anything that still needs verification before submission.

---

## Assistant

Mr. White,

I prepared three files:

[YC application rewrite](sandbox:/mnt/data/jovie_yc_s26_application_rewrite.md)  
[YC interview prep rewrite](sandbox:/mnt/data/jovie_yc_s26_interview_prep_rewrite.md)  
[YC submission audit](sandbox:/mnt/data/jovie_yc_s26_submission_audit.md)

I verified the public Jovie repo, live product, live Tim profile, live pricing page, and YC’s current application and interview guidance. The private ops repo files referenced in your prompt were not retrievable in this environment, so I produced a full replacement draft and audit grounded in public sources plus the facts in your prompt. fileciteturn0file0 citeturn965194view0turn965194view1turn212791view0turn777581view0turn212791view1turn965194view2turn965194view3turn965194view4

What I strengthened:
- The opener stays simple and YC-compliant: “Jovie is release software for independent artists.” YC explicitly emphasizes clear expression, the founder video requires founders talking only for one minute, and the interview is a 10-minute Q&A with no presentation. citeturn965194view2turn965194view3turn965194view4
- The product description is concrete and limited to claims I could verify: Spotify import, public artist profiles, release pages and smart links, audience capture, analytics, paid-plan release notifications, and AI pitch generation. The live site, pricing page, public docs, and entitlement code support that set of claims. citeturn212791view0turn212791view1turn197537view3turn839137view0
- The market answer uses the bottom-up Spotify Loud & Clear cohort: around 250,000 professional or aspiring professional artists globally, 81,000+ earning at least $10K from Spotify alone in 2025, and 13,800+ earning $100K+. citeturn517151view1turn517151view0turn517151view2
- The founder case leans on verifiable proof: 500+ stages, 70M+ UGC streams, Armada/Black Hole credits, and a public repo showing 5,085 commits for a live product. citeturn695226view0turn965194view1

Fix these before you submit:
- Pricing needs one canonical story. The public pricing page shows Free and Pro at $20/month, the canonical price code includes a Max tier at $200/month, the terms page still says Jovie is free for all creators, and `docs/PRODUCT_CAPABILITIES.md` still lists older tiers and prices. Resolve that mismatch everywhere. citeturn212791view1turn385678view0turn269003view0turn726142view0
- Feature gating needs one canonical source. The live pricing page and entitlement code gate release notifications to paid plans, while `FEATURE_REGISTRY.md` describes them as Free+. That same registry also conflicts on AI message limits and contact limits. I treated the live pricing page plus entitlement code as the safe source of truth in the rewrite. citeturn212791view1turn839137view0turn269003view2
- Keep automated follow-ups and catalog monitoring out of the application unless your private canon confirms the public product has caught up. The public feature registry still marks them as planned. citeturn269003view1

The rewrite files already reflect those constraints. The main remaining risk is consistency across pricing and shipped-feature claims.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_review-expansion-and-rewrite]]
- [[chatgpt/chatgpt_rewrite-job-application-answers]]
- [[chatgpt/chatgpt_yc-application-rewrite]]
- [[chatgpt/chatgpt_yc-application-strategy-review]]
- [[chatgpt/chatgpt_about-section-rewrite]]
