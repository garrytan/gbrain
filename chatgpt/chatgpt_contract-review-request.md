---
title: "Contract Review Request"
type: note
created: 2026-04-13
updated: 2026-04-13
source: chatgpt-export
conversation_id: 69dd64b6-7ae4-83e8-8a6d-48a008430b8b
message_count: 2
tags: [chatgpt, import, long-form]
---
# Contract Review Request

> Conversation ID: 69dd64b6-7ae4-83e8-8a6d-48a008430b8b
> Created: 2026-04-13T21:48:39Z
> Updated: 2026-04-13T22:11:02Z
> Messages: 2

---

## User

We're getting a landing page design, and Upwork reached out to us because they have a product they're building that's AI with human in the loop for design, and they're having me pilot. I'm one of the pilot customers. Can you take a look at this contract just to make sure there's no red flags? 

---

## Assistant

Mr. White, I reviewed the uploaded **Upwork Agentic Agency Agreement**. It has several real red flags. It is heavily vendor-favorable, especially on AI/data use, liability, and acceptance mechanics. fileciteturn0file0

The biggest issue is **training and reuse rights**. Section 4.2 gives Upwork a **non-exclusive, perpetual, irrevocable, worldwide, royalty-free license** to use, copy, modify, and create derivative works from the **Outcomes** to train and improve Upwork’s AI models, products, and services. Section 4.5 separately gives Upwork a broad, transferable, sublicensable, irrevocable license over your **Data** and Outcomes, including after termination, and Section 5.4 says information used to train internal models is exempt from return/destruction. For a pilot, that is the clause I would push back on first. fileciteturn0file0

Second, they want **full control over who does the work**, while also trying to avoid responsibility for those people and systems. Section 2.2 lets Upwork choose subcontractors and AI agents at its sole discretion, and you cannot direct, select, or reject them unless agreed in writing. Then Sections 8.1 and 8.2 say Upwork is not responsible for acts, errors, negligence, misconduct, or breaches by service providers/freelancers, and your sole remedy for that conduct is the dispute process. That combination is unusually one-sided. fileciteturn0file0

Third, the contract gives you **very little assurance of actual human involvement**, even though the pitch was “AI with human in the loop.” Section 2.5 says Upwork does **not guarantee any specific ratio of human to AI involvement**. Section 2.4 says you waive certain claims related to the quality of AI-generated content, and Section 8 provides the services “as is,” with no promise of any particular result. If named human review matters, it needs to be written into the scope. fileciteturn0file0

Fourth, the **acceptance and revision mechanics favor Upwork**. You get 14 calendar days to review each milestone, silence counts as acceptance, and using the work in live production or commercially also counts as acceptance. You only get **3 rounds of revisions**, requested within 14 business days, with one consolidated feedback package per round. For design work, especially with iterative landing pages, that is tight. fileciteturn0file0

Fifth, the **IP protection is weaker than it first appears**. They say you own the Outcomes after full payment, but they also carve out pre-existing materials and third-party components, disclaim strong responsibility for AI-generated inaccuracies, and put responsibility on **you** to review third-party/open-source licenses and to conduct due diligence on third-party IP rights before use. Their IP indemnity is narrow, and Section 8.2 limits it further to Outcomes directly attributable to Upwork’s own acts, not service providers. Since they reserve the right to use service providers and AI agents, that protection is thinner than it looks. fileciteturn0file0

Sixth, your **indemnity is broad and effectively uncapped**, while theirs is narrow. You indemnify them for a long list of things, including your instructions/specs, your data, third-party tools you use, account misuse, and your use of outcomes. The liability cap in Section 10 excludes indemnity obligations, so those claims are outside the normal cap. Their liability is otherwise capped at fees paid or payable in the prior 12 months for the services giving rise to the claim. fileciteturn0file0

Seventh, they default to **marketing and logo use**. Sections 6.1 and 6.2 let them display your company name and logo on their website and marketing materials unless you opt out in writing. If you do not want to be publicly identified as a pilot customer, send that opt-out before signing or at the same time. fileciteturn0file0

A few incorporated-term items matter too. The agreement folds in Upwork’s broader Terms of Service, which currently include the User Agreement, Escrow Instructions, Fee and ACH Authorization Agreement, Privacy Policy, and DPA. The current User Agreement for U.S. users contains **individual binding arbitration and a class/jury waiver**, with an opt-out only if you notify Upwork within 30 days of first registration or future changes to the arbitration provision. fileciteturn0file0 citeturn560030view0turn824162view0turn824162view1turn824162view2

There is also an important AI-license mismatch. Upwork’s current general User Agreement says AI-related training use of user content is tied to opted-in users and site preferences, but this uploaded agency agreement grants a broader standalone **perpetual training license** over Outcomes and broad post-term rights over Data/Outcomes for this service. Because your uploaded agreement says it controls over conflicting ToS terms for the service contract, I would assume the broader agency clause governs unless they expressly revise it. fileciteturn0file0 citeturn732477view3turn824162view2

One more pilot-specific point: Upwork’s legal center also has separate **AI Agent Playground Participation Terms (Beta)**. I do not know whether those apply to your pilot, but if this design pilot touches that program or any related beta, ask Upwork in writing whether any additional beta terms apply. Those beta terms also include content-use and logo-use provisions. citeturn584764view0

My practical read: for a **low-dollar, non-sensitive landing page design**, this is survivable if you sanitize inputs and treat it like an experiment. For anything involving confidential go-to-market strategy, proprietary data, strong reliance on originality, or a public pilot relationship, I would push for edits before signing. fileciteturn0file0

The clauses I would ask them to change are these:

1. **Delete or narrow AI training rights.** No training on your data, prompts, messages, feedback, or outcomes. No retention for model training after termination. fileciteturn0file0  
2. **Add a real human-review commitment.** At minimum: named human design lead, human QA before delivery, and disclosure of whether outputs used third-party models. fileciteturn0file0  
3. **Make Upwork responsible for its subcontractors and AI agents.** They choose them, so they should stand behind them. fileciteturn0file0  
4. **Fix acceptance.** No deemed acceptance from silence or production use; acceptance should require written approval or objective conformity to specs. Extend review to at least 21–30 days for final deliverables. fileciteturn0file0  
5. **Strengthen IP terms.** Full ownership of final files and deliverables; mandatory disclosure of all fonts, stock, plugins, open-source, and third-party licenses; Upwork indemnity should cover provider/AI output too. fileciteturn0file0  
6. **Opt out of marketing/logo/testimonial use.** Do this in writing now. fileciteturn0file0  
7. **Clarify fees.** Confirm the exact project fee, whether Marketplace or Business Plus fees apply, and any Contract Initiation Fee, because current Upwork terms make those separate charges and some are nonrefundable. citeturn682314view0turn298188view0turn682314view1

The single most important sentence to send them is: **“Upwork may not use our data, prompts, messages, feedback, or deliverables to train or improve any AI model, and must delete or return them at the end of the engagement except for legally required retention.”** fileciteturn0file0

Next step: I can turn this into a short redline list you can send Upwork today.
