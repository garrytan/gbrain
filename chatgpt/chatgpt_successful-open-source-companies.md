---
title: "Successful open source companies"
type: note
created: 2025-07-22
updated: 2025-07-23
source: chatgpt-export
conversation_id: 68802591-bb90-8328-9fd2-dcd1062c8d82
message_count: 4
tags: [chatgpt, import, long-form]
---
# Successful open source companies

> Conversation ID: 68802591-bb90-8328-9fd2-dcd1062c8d82
> Created: 2025-07-22T23:58:10Z
> Updated: 2025-07-23T00:03:15Z
> Messages: 4

---

## User

What are the most successful open source companies

---

## Assistant

Mr. White—here’s a quick, revenue-based snapshot of the biggest winners that still anchor their business to an open-source core:

| 2024/25 Rev. | Flagship OSS Project(s) | How They Monetize |
|--------------|------------------------|-------------------|
| **≈ $6.5 B** | Red Hat Enterprise Linux, OpenShift | Subscription support & hybrid-cloud platform under IBM citeturn8view0 |
| **>$3 B ARR** | Apache Spark | Databricks Lakehouse Platform (SaaS, data AI services) citeturn0news75 |
| **$2.01 B** | MongoDB Core / Atlas | Atlas DBaaS + enterprise licensing citeturn6search0 |
| **≈ $1.66 B** | Elasticsearch, Kibana | Elastic Cloud, enterprise plugins citeturn0search2 |
| **$1.0 B (≈$922 M sub.)** | Apache Kafka | Confluent Cloud & platform support citeturn0search4 |
| **$759 M** | GitLab CE | SaaS tiers & self-managed licenses citeturn10view0 |
| **$710 M** | WordPress, WooCommerce | WordPress.com hosting, SaaS add-ons citeturn9search1 |
| **$670 M** | SUSE Linux Enterprise | Subscription support & Rancher stack citeturn7search0 |
| **$583 M** | Terraform, Vault, Consul | HashiCorp Cloud Platform + enterprise licenses (note: now BSL) citeturn13view0 |
| **$250 M ARR** | Grafana, Loki, Tempo | Grafana Cloud & enterprise plugins citeturn2search0 |

**Why these matter**

* **Scale + OSS flywheel:** Each started with a community-led project, then layered a paid cloud/service tier to capture enterprise budgets.
* **Recurring revenue beats licenses:** All ten lean on subscriptions or managed-service ARR; that predictability drives valuations.
* **License shifts:** A few (HashiCorp, MongoDB) tightened licenses to deter cloud “strip-mining,” yet still trace their success to an open-source beachhead.

That’s the current leaderboard—any deeper dive on one of them, just say the word.

---

## User

Explain advantages and disadvantages of log your body being open source.  Lay out how the business model could work as an open source company. consider ycombinator recommendations and how they would recommend we set it up. Also tell me if yc would disagree with making it open source.

---

## Assistant

**Open-sourcing LogYourBody — the trade-offs**

|                                         | Upside | Downside |
|-----------------------------------------|--------|----------|
| **Distribution flywheel** | Free code = viral GitHub/Reddit/HN exposure, lower CAC, dev trust. PostHog used this to get to YC’s default analytics tool for 54 % of the W24 batch. citeturn12view0L5-L6 | Anyone can fork, re-skin and rank beside you in the App Store or run a “$5/mo LogYourBody-Cloud” on AWS faster than you can DMCA them. |
| **Community contributions** | Pull requests fix edge-cases, new integrations, translation strings while you sleep. | Community ≠ free labor; you’ll spend real eng time on code review, docs, and diplomacy. |
| **Credibility & compliance** | Doctors, coaches and EU regulators like auditable code; AGPL + self-host tick the “no vendor lock-in” box that wins enterprise pilots. citeturn7view0L11-L13 | Full transparency means every security flaw is public the moment you push. You must patch at OSS speed or get roasted. |
| **Talent magnet** | Hackers join cool OSS brands over yet-another-closed-fitness-app. | Star engineers often demand “mission + equity”; if revenue lags, they drift away to better-funded OSS darlings. |
| **IP moat shifts to data & brand** | Your anonymized body-comp dataset, iOS polish, and “LogYourBody Certified Trainer” ecosystem become the defensible assets. | If you fail to build network effects fast, the fork with the bigger marketing budget wins. |

---

### YC’s likely stance

* **Pro:** YC has funded GitLab, PostHog, Sentry, Cal.com, etc. “Nearly all of YC’s biggest hits stand on open-source” was the on-stage line at YC’s 2024 Open-Source AI summit. citeturn9view0L5-L6  
* **But show a business model.** YC partners remind founders that “open source is a distribution model, not a business model.” citeturn8view0L1-L3  
* If you present a credible path to **default-alive** ARR (SaaS, usage-based, or enterprise), they won’t object. If you say “we’ll figure out monetization later,” they’ll push back.

---

### OSS-friendly business model blueprint

1. **Open-core + Cloud (default YC playbook)**  
   * **License:** MIT/Apache for the core; keep AI-powered progress-photo analysis, advanced dashboards, HIPAA mode behind a source-available license (e.g., BSL) to stop AWS strip-mining.  
   * **Product tiers:**  
     * Community Edition — self-host, single user, no support.  
     * **LogYourBody Cloud** — $X/user/month; instant sync, iOS/Android push, AI form-check.  
     * **Enterprise** — SSO, audit logs, custom ML models, dedicated Slack channel.  

2. **Data network effects**  
   * Aggregate de-identified body-comp trends → sell benchmarking dashboards to gyms, coaches, insurers. (Closed dataset even if code is open.)  

3. **Marketplace & integrations**  
   * 30 % rev-share on paid plugins (meal-plan generators, RP-style template packs).  

4. **White-label & API**  
   * Charge boutique gyms or nutrition startups to embed LogYourBody under their brand; metered API pricing aligns with YC’s “simple, usage-based SaaS” advice. citeturn0search6  

5. **Services (keep small)**  
   * Paid onboarding, custom reports, DEXA importer setup; fine for cash flow but don’t let it dominate headcount (YC’s recurring refrain).

---

### Structuring the project the YC way

| Step | YC-style guideline |
|------|--------------------|
| **1. Choose license early** | Pick something OSI-approved but “business-safe” (AGPL + commercial, or BSL) before launch; hard to tighten later without backlash. |
| **2. Nail self-serve onboarding** | A one-command `docker compose up` plus an iOS TestFlight that syncs in 60 sec. OSS is the top-funnel; friction kills. |
| **3. Track the right metric** | Weekly active users syncing ≥ 3 metrics. Show steady ↑ curve; investors understand open-core once engagement is proved. |
| **4. Ship hosted version fast** | “The cloud SKU is the business” — launch paid Cloud within weeks, not years, to validate willingness-to-pay. |
| **5. Default-alive economics** | Keep burn ≤ 2× MRR so you’re not hostage to the next round. YC will grill you on this. |
| **6. Community > marketing** | Blog transparently, public roadmap, accept PRs with praise. Think GitLab handbook. |

---

### Would YC ever advise *against* OSS here?

Only if:

* **Moat is purely the code.** A simple calorie-tracker has zero edge once public.  
* **Highly regulated IP.** If FDA-cleared medical algorithms become core, open code could create liability.  
* **You can’t articulate monetization.** YC is happy to fund open-source *companies*; they won’t fund open-source *charities*.

If you have differentiated UX, network data, and a clear Cloud upsell, open-sourcing LogYourBody is aligned with YC’s playbook — just remember the revenue engine has to scale faster than the GitHub stars.
